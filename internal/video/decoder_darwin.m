// H.264 decoder: VideoToolbox, hardware where the Mac has it, NV12 output
// straight into the virtual camera sink.
//
// Input is what pion's samplebuilder hands over: one access unit in Annex-B
// form, SPS/PPS in-band ahead of each IDR. VideoToolbox wants AVCC (4-byte
// big-endian lengths) plus a format description built from the parameter
// sets, so each access unit is walked NAL by NAL:
//   SPS+PPS  -> format description; a new or changed one replaces the session
//   IDR      -> opens the gate: nothing is decoded until a keyframe has been
//               fed to the session, and the caller is told to ask for one
//   slices   -> repacked as AVCC into a CMSampleBuffer and decoded
//
// The output callback runs on VideoToolbox's thread and stays in C: it stamps
// the frame with the host clock (what the camera extension wants) and pushes
// it into the sink. It never blocks and never calls Go.
//
// Plain C over CoreFoundation, no Objective-C objects and no ARC (see
// sink_darwin.m for why).
#include <VideoToolbox/VideoToolbox.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "decoder_darwin.h"
#include "sink_darwin.h"

#define MAX_NALS 64

typedef struct {
	void                       *sink;
	VTDecompressionSessionRef   session;
	CMVideoFormatDescriptionRef fmt;         // the session's format; NULL without a session
	int                         haveKeyframe; // an IDR has been fed since the session was (re)created
	_Atomic int                 needKeyframe; // the output callback saw a decode error: close the gate
	int                         tsInit;
	uint32_t                    tsLast;      // RTP timestamp unwrapping: 32-bit wraps every ~13 h
	int64_t                     tsAcc;
	_Atomic uint64_t            frames;
	_Atomic uint64_t            errors;
	_Atomic int                 width;
	_Atomic int                 height;
	_Atomic int                 hardware;
} vtdec;

typedef struct {
	const uint8_t *p;
	size_t         n;
} nal;

// onFrame is the VTDecompressionOutputCallback: VideoToolbox thread, C only.
static void onFrame(void *refcon, void *frameRefcon, OSStatus status, VTDecodeInfoFlags flags,
                    CVImageBufferRef image, CMTime pts, CMTime duration) {
	(void)frameRefcon;
	(void)pts;
	(void)duration;
	vtdec *d = refcon;
	if (status != noErr) {
		// With asynchronous decompression a frame that fails to decode
		// fails here, not in VTDecompressionSessionDecodeFrame (which only
		// fails to submit). The frames after it reference it, so the gate
		// closes at the next vtdec_decode until an IDR arrives.
		atomic_fetch_add(&d->errors, 1);
		atomic_store(&d->needKeyframe, 1);
		return;
	}
	if ((flags & kVTDecodeInfo_FrameDropped) || image == NULL) {
		return; // dropped by the decoder on request, not an error
	}
	atomic_fetch_add(&d->frames, 1);
	// Host time, not the RTP clock: the extension re-stamps against the host
	// clock and a camera has no notion of the sender's timeline.
	sink_push(d->sink, image, CMClockGetTime(CMClockGetHostTimeClock()));
}

static void teardown(vtdec *d) {
	if (d->session != NULL) {
		VTDecompressionSessionWaitForAsynchronousFrames(d->session);
		VTDecompressionSessionInvalidate(d->session);
		CFRelease(d->session);
		d->session = NULL;
	}
	if (d->fmt != NULL) {
		CFRelease(d->fmt);
		d->fmt = NULL;
	}
	d->haveKeyframe = 0;
	atomic_store(&d->needKeyframe, 0); // the callbacks are done (waited for above)
}

// createSession opens a decompression session for d->fmt, delivering NV12
// IOSurface-backed buffers (what the camera extension takes without a copy).
static int createSession(vtdec *d) {
	CFMutableDictionaryRef attrs = CFDictionaryCreateMutable(kCFAllocatorDefault, 2,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	int32_t pixfmt = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange;
	CFNumberRef pixfmtNum = CFNumberCreate(kCFAllocatorDefault, kCFNumberSInt32Type, &pixfmt);
	CFDictionarySetValue(attrs, kCVPixelBufferPixelFormatTypeKey, pixfmtNum);
	CFRelease(pixfmtNum);
	CFDictionaryRef surface = CFDictionaryCreate(kCFAllocatorDefault, NULL, NULL, 0,
		&kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
	CFDictionarySetValue(attrs, kCVPixelBufferIOSurfacePropertiesKey, surface);
	CFRelease(surface);

	VTDecompressionOutputCallbackRecord cb = {onFrame, d};
	VTDecompressionSessionRef session = NULL;
	OSStatus st = VTDecompressionSessionCreate(kCFAllocatorDefault, d->fmt, NULL, attrs, &cb, &session);
	CFRelease(attrs);
	if (st != noErr || session == NULL) {
		return -1;
	}
	d->session = session;
	d->haveKeyframe = 0;

	CFBooleanRef hw = NULL;
	int usesHW = 0;
	if (VTSessionCopyProperty(session, kVTDecompressionPropertyKey_UsingHardwareAcceleratedVideoDecoder,
	                          kCFAllocatorDefault, &hw) == noErr && hw != NULL) {
		usesHW = CFBooleanGetValue(hw) ? 1 : 0;
		CFRelease(hw);
	}
	atomic_store(&d->hardware, usesHW);
	CMVideoDimensions dim = CMVideoFormatDescriptionGetDimensions(d->fmt);
	atomic_store(&d->width, dim.width);
	atomic_store(&d->height, dim.height);
	return 0;
}

// splitNALs cuts an Annex-B buffer at its start codes (00 00 01, with or
// without a leading 00). Returns the number of non-empty NALs found.
static int splitNALs(const uint8_t *buf, size_t len, nal *out, int max) {
	int count = 0;
	size_t i = 0;
	size_t start = (size_t)-1; // first byte of the NAL being scanned, or none yet
	while (i + 2 < len) {
		if (buf[i] == 0 && buf[i + 1] == 0 && buf[i + 2] == 1) {
			if (start != (size_t)-1) {
				size_t end = i;
				if (end > start && buf[end - 1] == 0) {
					end--; // the 4-byte form: the zero before 00 00 01 belongs to the start code
				}
				if (end > start && count < max) {
					out[count].p = buf + start;
					out[count].n = end - start;
					count++;
				}
			}
			i += 3;
			start = i;
			continue;
		}
		i++;
	}
	if (start != (size_t)-1 && len > start && count < max) {
		out[count].p = buf + start;
		out[count].n = len - start;
		count++;
	}
	return count;
}

static int64_t unwrapTimestamp(vtdec *d, uint32_t ts) {
	if (!d->tsInit) {
		d->tsInit = 1;
		d->tsLast = ts;
		d->tsAcc = (int64_t)ts;
		return d->tsAcc;
	}
	d->tsAcc += (int32_t)(ts - d->tsLast);
	d->tsLast = ts;
	return d->tsAcc;
}

int vtdec_open(vtdec_result *res, void *sink) {
	memset(res, 0, sizeof(*res));
	if (sink == NULL) {
		snprintf(res->err, sizeof(res->err), "no camera sink to decode into");
		return -1;
	}
	vtdec *d = calloc(1, sizeof(*d));
	if (d == NULL) {
		snprintf(res->err, sizeof(res->err), "out of memory");
		return -1;
	}
	d->sink = sink;
	res->handle = d;
	return 0;
}

int vtdec_decode(void *handle, const uint8_t *buf, size_t len, uint32_t rtpTimestamp) {
	vtdec *d = handle;
	if (d == NULL || buf == NULL || len == 0) {
		return -1;
	}

	nal nals[MAX_NALS];
	int count = splitNALs(buf, len, nals, MAX_NALS);
	const uint8_t *sps = NULL, *pps = NULL;
	size_t spsLen = 0, ppsLen = 0;
	int hasIDR = 0;
	for (int i = 0; i < count; i++) {
		switch (nals[i].p[0] & 0x1f) {
		case 7: sps = nals[i].p; spsLen = nals[i].n; break;
		case 8: pps = nals[i].p; ppsLen = nals[i].n; break;
		case 5: hasIDR = 1; break;
		default: break;
		}
	}

	// Parameter sets: build the format description; a first or changed one
	// (resolution or profile switch) replaces the session.
	if (sps != NULL && pps != NULL) {
		const uint8_t *ptrs[2] = {sps, pps};
		const size_t sizes[2] = {spsLen, ppsLen};
		CMVideoFormatDescriptionRef fmt = NULL;
		OSStatus st = CMVideoFormatDescriptionCreateFromH264ParameterSets(kCFAllocatorDefault, 2, ptrs, sizes, 4, &fmt);
		if (st != noErr || fmt == NULL) {
			atomic_fetch_add(&d->errors, 1);
		} else if (d->session == NULL || d->fmt == NULL || !CMFormatDescriptionEqual(fmt, d->fmt)) {
			teardown(d);
			d->fmt = fmt;
			if (createSession(d) != 0) {
				CFRelease(d->fmt);
				d->fmt = NULL;
				atomic_fetch_add(&d->errors, 1);
				return VTDEC_NEED_KEYFRAME;
			}
		} else {
			CFRelease(fmt);
		}
	}

	if (d->session == NULL) {
		return VTDEC_NEED_KEYFRAME;
	}
	if (atomic_exchange(&d->needKeyframe, 0)) {
		d->haveKeyframe = 0; // a frame failed in the callback since the last call
	}
	if (!d->haveKeyframe) {
		if (!hasIDR) {
			return VTDEC_NEED_KEYFRAME;
		}
		d->haveKeyframe = 1;
	}

	// Slices and SEI only (types 1-6); parameter sets live in the format
	// description and access unit delimiters (9) carry nothing.
	size_t total = 0;
	for (int i = 0; i < count; i++) {
		uint8_t t = nals[i].p[0] & 0x1f;
		if (t >= 1 && t <= 6) {
			total += 4 + nals[i].n;
		}
	}
	if (total == 0) {
		return 0;
	}

	CMBlockBufferRef bb = NULL;
	OSStatus st = CMBlockBufferCreateWithMemoryBlock(kCFAllocatorDefault, NULL, total, kCFAllocatorDefault, NULL,
	                                                 0, total, kCMBlockBufferAssureMemoryNowFlag, &bb);
	if (st != noErr || bb == NULL) {
		atomic_fetch_add(&d->errors, 1);
		return VTDEC_NEED_KEYFRAME;
	}
	size_t off = 0;
	for (int i = 0; i < count && st == noErr; i++) {
		uint8_t t = nals[i].p[0] & 0x1f;
		if (t < 1 || t > 6) {
			continue;
		}
		uint32_t n = (uint32_t)nals[i].n;
		uint8_t hdr[4] = {(uint8_t)(n >> 24), (uint8_t)(n >> 16), (uint8_t)(n >> 8), (uint8_t)n};
		st = CMBlockBufferReplaceDataBytes(hdr, bb, off, 4);
		off += 4;
		if (st == noErr) {
			st = CMBlockBufferReplaceDataBytes(nals[i].p, bb, off, n);
		}
		off += n;
	}
	if (st != noErr) {
		CFRelease(bb);
		atomic_fetch_add(&d->errors, 1);
		return VTDEC_NEED_KEYFRAME;
	}

	CMSampleTimingInfo timing = {
		.duration = kCMTimeInvalid,
		.presentationTimeStamp = CMTimeMake(unwrapTimestamp(d, rtpTimestamp), 90000),
		.decodeTimeStamp = kCMTimeInvalid,
	};
	size_t sampleSize = total;
	CMSampleBufferRef sb = NULL;
	st = CMSampleBufferCreate(kCFAllocatorDefault, bb, true, NULL, NULL, d->fmt, 1, 1, &timing, 1, &sampleSize, &sb);
	CFRelease(bb);
	if (st != noErr || sb == NULL) {
		atomic_fetch_add(&d->errors, 1);
		return VTDEC_NEED_KEYFRAME;
	}

	VTDecodeInfoFlags info = 0;
	st = VTDecompressionSessionDecodeFrame(d->session, sb, kVTDecodeFrame_EnableAsynchronousDecompression, NULL, &info);
	CFRelease(sb);
	if (st == kVTInvalidSessionErr || st == kVTVideoDecoderMalfunctionErr) {
		// The decoder is gone (sleep/wake, GPU reset): start over from the
		// next parameter sets and keyframe.
		teardown(d);
		atomic_fetch_add(&d->errors, 1);
		return VTDEC_NEED_KEYFRAME;
	}
	if (st != noErr) {
		// This frame is lost, so every frame referencing it would be garbage:
		// close the gate until the next IDR.
		d->haveKeyframe = 0;
		atomic_fetch_add(&d->errors, 1);
		return VTDEC_NEED_KEYFRAME;
	}
	return 0;
}

void vtdec_reset(void *handle) {
	vtdec *d = handle;
	if (d == NULL) {
		return;
	}
	d->haveKeyframe = 0;
	d->tsInit = 0;
}

void vtdec_close(void *handle) {
	vtdec *d = handle;
	if (d == NULL) {
		return;
	}
	teardown(d);
	free(d);
}

uint64_t vtdec_frames(void *handle) {
	vtdec *d = handle;
	return d == NULL ? 0 : atomic_load(&d->frames);
}

uint64_t vtdec_errors(void *handle) {
	vtdec *d = handle;
	return d == NULL ? 0 : atomic_load(&d->errors);
}

int vtdec_width(void *handle) {
	vtdec *d = handle;
	return d == NULL ? 0 : atomic_load(&d->width);
}

int vtdec_height(void *handle) {
	vtdec *d = handle;
	return d == NULL ? 0 : atomic_load(&d->height);
}

int vtdec_hardware(void *handle) {
	vtdec *d = handle;
	return d == NULL ? 0 : atomic_load(&d->hardware);
}

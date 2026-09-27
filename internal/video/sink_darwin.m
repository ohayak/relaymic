// Virtual camera sink: pushes decoded frames into the Remote Visio Camera
// extension through its sink stream, the way Apple recommends for feeding a
// camera system extension from an app (WWDC22 "Create camera extensions with
// Core Media IO"):
//   1. find the device by UID among kCMIOHardwarePropertyDevices;
//   2. pick its sink stream (by name, then by position, then by direction);
//   3. CMIOStreamCopyBufferQueue gives the client-side CMSimpleQueue of that
//      stream; CMIODeviceStartStream starts it;
//   4. every decoded frame becomes a CMSampleBuffer stamped with the host
//      clock and is enqueued; the extension re-stamps and forwards it on its
//      source stream, which is what Zoom or FaceTime read.
//
// Plain C over CoreFoundation, no Objective-C objects and no ARC: cgo flags
// are per package and this file must not need -fobjc-arc. The extension only
// authorizes writers whose code-signing identifier it knows (this binary's
// "remotevisio-receiver" or the app's "com.remotevisio.app"); anything else
// gets kCMIODevicePermissionsError ('!hog') from the enqueue.
#include <CoreMediaIO/CMIOHardware.h>
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sink_darwin.h"

#define SINK_STREAM_NAME "Remote Visio Camera Sink"

typedef struct {
	CMIODeviceID                device;
	CMIOStreamID                stream;
	CMSimpleQueueRef            queue;
	CMVideoFormatDescriptionRef fmt;   // cached; recreated when the frames change size or format
	pthread_mutex_t             mu;    // serializes push against push and close
	_Atomic uint64_t            pushed;
	_Atomic uint64_t            dropped;
} sink;

// fourcc renders an OSStatus that is a four-character code ('who?', '!str',
// '!hog', 'nope') as text, or nothing when it is an ordinary number.
static void fourcc(OSStatus st, char *out, size_t n) {
	uint32_t u = (uint32_t)st;
	char c[4] = {(char)(u >> 24), (char)(u >> 16), (char)(u >> 8), (char)u};
	for (int i = 0; i < 4; i++) {
		if (c[i] < 0x20 || c[i] > 0x7e) {
			out[0] = 0;
			return;
		}
	}
	snprintf(out, n, " '%c%c%c%c'", c[0], c[1], c[2], c[3]);
}

static void oserr(char *out, size_t n, const char *what, OSStatus st) {
	const char *why = "";
	switch (st) {
	case kCMIOHardwareUnknownPropertyError: why = ": unknown property"; break;
	case kCMIOHardwareBadStreamError:       why = ": bad stream"; break;
	case kCMIOHardwareBadDeviceError:       why = ": bad device"; break;
	case kCMIOHardwareBadObjectError:       why = ": bad object"; break;
	case kCMIOHardwareNotRunningError:      why = ": hardware not running"; break;
	case kCMIOHardwareIllegalOperationError: why = ": illegal operation"; break;
	case kCMIODevicePermissionsError:
		why = ": permission denied (the camera extension takes frames from one signed Remote Visio receiver"
		      " at a time: is another one running?)";
		break;
	default: break;
	}
	char code[16];
	fourcc(st, code, sizeof(code));
	snprintf(out, n, "%s: OSStatus %d%s%s", what, (int)st, code, why);
}

static OSStatus getPropSize(CMIOObjectID obj, CMIOObjectPropertySelector sel, UInt32 *size) {
	CMIOObjectPropertyAddress addr = {sel, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
	return CMIOObjectGetPropertyDataSize(obj, &addr, 0, NULL, size);
}

static OSStatus getProp(CMIOObjectID obj, CMIOObjectPropertySelector sel, UInt32 size, void *out) {
	CMIOObjectPropertyAddress addr = {sel, kCMIOObjectPropertyScopeGlobal, kCMIOObjectPropertyElementMain};
	UInt32 used = 0;
	return CMIOObjectGetPropertyData(obj, &addr, 0, NULL, size, &used, out);
}

// getString reads a CFString property (returned +1, released here) into out. Empty on failure.
static int getString(CMIOObjectID obj, CMIOObjectPropertySelector sel, char *out, size_t n) {
	out[0] = 0;
	CFStringRef s = NULL;
	if (getProp(obj, sel, sizeof(s), &s) != noErr || s == NULL) {
		return 0;
	}
	CFStringGetCString(s, out, (CFIndex)n, kCFStringEncodingUTF8);
	CFRelease(s);
	return 1;
}

// findDevice returns the CMIODeviceID whose UID matches, or kCMIOObjectUnknown.
static CMIODeviceID findDevice(const char *uid, char *err, size_t n) {
	UInt32 size = 0;
	OSStatus st = getPropSize(kCMIOObjectSystemObject, kCMIOHardwarePropertyDevices, &size);
	if (st != noErr) {
		oserr(err, n, "list camera devices", st);
		return kCMIOObjectUnknown;
	}
	UInt32 count = size / sizeof(CMIODeviceID);
	if (count == 0) {
		return kCMIOObjectUnknown;
	}
	CMIODeviceID *devs = calloc(count, sizeof(CMIODeviceID));
	if (devs == NULL) {
		snprintf(err, n, "out of memory");
		return kCMIOObjectUnknown;
	}
	st = getProp(kCMIOObjectSystemObject, kCMIOHardwarePropertyDevices, size, devs);
	if (st != noErr) {
		free(devs);
		oserr(err, n, "list camera devices", st);
		return kCMIOObjectUnknown;
	}
	CMIODeviceID found = kCMIOObjectUnknown;
	char cur[256];
	for (UInt32 i = 0; i < count; i++) {
		if (getString(devs[i], kCMIODevicePropertyDeviceUID, cur, sizeof(cur)) && strcmp(cur, uid) == 0) {
			found = devs[i];
			break;
		}
	}
	free(devs);
	return found;
}

// findSink picks the writable stream of dev: the one named SINK_STREAM_NAME;
// failing that the second one (the extension adds [source, sink] in that
// order); failing that the first whose direction says "output".
static int findSink(CMIODeviceID dev, sink_result *res) {
	UInt32 size = 0;
	OSStatus st = getPropSize(dev, kCMIODevicePropertyStreams, &size);
	if (st != noErr) {
		oserr(res->err, sizeof(res->err), "list the camera's streams", st);
		return -1;
	}
	UInt32 count = size / sizeof(CMIOStreamID);
	if (count == 0) {
		snprintf(res->err, sizeof(res->err), "the camera device has no streams");
		return -1;
	}
	CMIOStreamID *streams = calloc(count, sizeof(CMIOStreamID));
	if (streams == NULL) {
		snprintf(res->err, sizeof(res->err), "out of memory");
		return -1;
	}
	st = getProp(dev, kCMIODevicePropertyStreams, size, streams);
	if (st != noErr) {
		free(streams);
		oserr(res->err, sizeof(res->err), "list the camera's streams", st);
		return -1;
	}

	int pick = -1;
	char name[256];
	for (UInt32 i = 0; i < count; i++) {
		if (getString(streams[i], kCMIOObjectPropertyName, name, sizeof(name)) && strcmp(name, SINK_STREAM_NAME) == 0) {
			pick = (int)i;
			break;
		}
	}
	if (pick < 0 && count >= 2) {
		pick = 1;
	}
	if (pick < 0) {
		for (UInt32 i = 0; i < count; i++) {
			UInt32 dir = 1;
			if (getProp(streams[i], kCMIOStreamPropertyDirection, sizeof(dir), &dir) == noErr && dir == 0) {
				pick = (int)i;
				break;
			}
		}
	}
	if (pick < 0) {
		free(streams);
		snprintf(res->err, sizeof(res->err), "the camera device has no sink stream (%u stream(s), none writable)", (unsigned)count);
		return -1;
	}

	res->stream = streams[pick];
	res->index = pick;
	getString(res->stream, kCMIOObjectPropertyName, res->name, sizeof(res->name));
	UInt32 dir = 0;
	res->direction = getProp(res->stream, kCMIOStreamPropertyDirection, sizeof(dir), &dir) == noErr ? (int)dir : -1;
	free(streams);
	return 0;
}

int sink_open(sink_result *res, const char *deviceUID) {
	memset(res, 0, sizeof(*res));

	CMIODeviceID dev = findDevice(deviceUID, res->err, sizeof(res->err));
	if (dev == kCMIOObjectUnknown) {
		if (res->err[0] == 0) {
			snprintf(res->err, sizeof(res->err), "the Remote Visio Camera device is not available (camera extension not activated?)");
		}
		return -1;
	}
	res->device = dev;
	if (findSink(dev, res) != 0) {
		return -1;
	}

	// No queue-altered callback: for an output stream it would only announce
	// removals, and the push side already checks the queue's fill level.
	CMSimpleQueueRef queue = NULL;
	OSStatus st = CMIOStreamCopyBufferQueue(res->stream, NULL, NULL, &queue);
	if (st != noErr || queue == NULL) {
		if (queue != NULL) {
			CFRelease(queue);
		}
		oserr(res->err, sizeof(res->err), "get the sink stream's buffer queue", st);
		return -1;
	}
	st = CMIODeviceStartStream(dev, res->stream);
	if (st != noErr) {
		CFRelease(queue);
		oserr(res->err, sizeof(res->err), "start the sink stream", st);
		return -1;
	}

	sink *s = calloc(1, sizeof(*s));
	if (s == NULL) {
		CMIODeviceStopStream(dev, res->stream);
		CFRelease(queue);
		snprintf(res->err, sizeof(res->err), "out of memory");
		return -1;
	}
	s->device = dev;
	s->stream = res->stream;
	s->queue = queue;
	pthread_mutex_init(&s->mu, NULL);
	res->handle = s;
	return 0;
}

int sink_push(void *handle, CVPixelBufferRef pb, CMTime pts) {
	sink *s = handle;
	if (s == NULL || pb == NULL) {
		return -1;
	}
	pthread_mutex_lock(&s->mu);
	if (CMSimpleQueueGetCount(s->queue) >= CMSimpleQueueGetCapacity(s->queue)) {
		// The extension has not taken the previous frame yet: drop this one
		// rather than queue up latency. A camera shows the newest frame.
		pthread_mutex_unlock(&s->mu);
		atomic_fetch_add(&s->dropped, 1);
		return -1;
	}
	if (s->fmt == NULL || !CMVideoFormatDescriptionMatchesImageBuffer(s->fmt, pb)) {
		if (s->fmt != NULL) {
			CFRelease(s->fmt);
			s->fmt = NULL;
		}
		if (CMVideoFormatDescriptionCreateForImageBuffer(kCFAllocatorDefault, pb, &s->fmt) != noErr || s->fmt == NULL) {
			s->fmt = NULL;
			pthread_mutex_unlock(&s->mu);
			atomic_fetch_add(&s->dropped, 1);
			return -1;
		}
	}
	CMSampleTimingInfo timing = {
		.duration = kCMTimeInvalid,
		.presentationTimeStamp = pts,
		.decodeTimeStamp = kCMTimeInvalid,
	};
	CMSampleBufferRef sb = NULL;
	OSStatus st = CMSampleBufferCreateForImageBuffer(kCFAllocatorDefault, pb, true, NULL, NULL, s->fmt, &timing, &sb);
	if (st != noErr || sb == NULL) {
		pthread_mutex_unlock(&s->mu);
		atomic_fetch_add(&s->dropped, 1);
		return -1;
	}
	// On success the queue takes over the +1 reference; on failure it is still ours.
	st = CMSimpleQueueEnqueue(s->queue, sb);
	pthread_mutex_unlock(&s->mu);
	if (st != noErr) {
		CFRelease(sb);
		atomic_fetch_add(&s->dropped, 1);
		return -1;
	}
	atomic_fetch_add(&s->pushed, 1);
	return 0;
}

void sink_close(void *handle) {
	sink *s = handle;
	if (s == NULL) {
		return;
	}
	pthread_mutex_lock(&s->mu);
	CMIODeviceStopStream(s->device, s->stream);
	if (s->queue != NULL) {
		CFRelease(s->queue);
		s->queue = NULL;
	}
	if (s->fmt != NULL) {
		CFRelease(s->fmt);
		s->fmt = NULL;
	}
	pthread_mutex_unlock(&s->mu);
	pthread_mutex_destroy(&s->mu);
	free(s);
}

uint64_t sink_pushed(void *handle) {
	sink *s = handle;
	return s == NULL ? 0 : atomic_load(&s->pushed);
}

uint64_t sink_dropped(void *handle) {
	sink *s = handle;
	return s == NULL ? 0 : atomic_load(&s->dropped);
}

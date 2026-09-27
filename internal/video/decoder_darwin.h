// C-side interface of the H.264 decoder (VideoToolbox) feeding the camera sink.
#ifndef REMOTEVISIO_VIDEO_DECODER_H
#define REMOTEVISIO_VIDEO_DECODER_H

#include <stdint.h>
#include <stddef.h>

// vtdec_decode returns this when it has decoded nothing and the sender must
// send an IDR before decoding can (re)start: no decoder session yet, no
// keyframe since the session was (re)created, or a decode error that broke
// the reference chain.
#define VTDEC_NEED_KEYFRAME 2

typedef struct {
	void *handle; // opaque decoder, owned by the caller until vtdec_close
	char  err[512];
} vtdec_result;

// vtdec_open creates a decoder whose output goes into sink (a sink_result
// handle, which must outlive the decoder). Returns 0 on success, -1 on failure.
int vtdec_open(vtdec_result *res, void *sink);

// vtdec_decode takes one access unit in Annex-B form (4-byte start codes, as
// pion's H.264 depacketizer emits; 3-byte ones are accepted too) with its RTP
// timestamp (90 kHz). The bytes are copied before it returns. Returns 0 when
// the frame was handed to the decoder, VTDEC_NEED_KEYFRAME as described above,
// -1 on a bad argument.
int vtdec_decode(void *handle, const uint8_t *annexb, size_t len, uint32_t rtpTimestamp);

// vtdec_reset marks the start of a new stream from the same sender (a new
// connection): nothing is decoded until its first IDR, and the timestamp base
// starts over. The session stays; a changed SPS/PPS replaces it as usual.
void vtdec_reset(void *handle);

// vtdec_close drains and tears the session down, then frees the handle.
void vtdec_close(void *handle);

uint64_t vtdec_frames(void *handle); // frames delivered by the decoder
uint64_t vtdec_errors(void *handle); // frames that failed to decode
int      vtdec_width(void *handle);  // dimensions of the current stream, 0 before the first SPS
int      vtdec_height(void *handle);
int      vtdec_hardware(void *handle); // 1 when the session uses the hardware decoder

#endif

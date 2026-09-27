// C-side interface of the virtual camera sink: the writable ("sink") stream of
// the Remote Visio Camera CMIO extension, fed through the CoreMediaIO C API.
#ifndef REMOTEVISIO_VIDEO_SINK_H
#define REMOTEVISIO_VIDEO_SINK_H

#include <stdint.h>
#include <stddef.h>

typedef struct {
	void     *handle;    // opaque sink, owned by the caller until sink_close
	uint32_t  device;    // CMIODeviceID of the camera device
	uint32_t  stream;    // CMIOStreamID of the sink stream
	int       index;     // position of the sink in the device's stream list
	int       direction; // kCMIOStreamPropertyDirection of the sink (0 = output/writable, 1 = input)
	char      name[256]; // localized name of the sink stream
	char      err[512];
} sink_result;

// sink_open finds the camera device with the given UID, picks its sink stream,
// copies the stream's buffer queue and starts the stream. Returns 0 on success,
// -1 on failure with the reason written to err.
int sink_open(sink_result *res, const char *deviceUID);

// sink_close stops the stream and frees the handle. Nothing may push after it.
void sink_close(void *handle);

// Counters of frames enqueued and frames dropped (queue full or buffer failure).
uint64_t sink_pushed(void *handle);
uint64_t sink_dropped(void *handle);

// sink_push is for the decoder's output callback only, hence hidden from cgo
// (which parses this header as plain C): it enqueues one decoded frame as a
// CMSampleBuffer stamped with pts. Never blocks. Returns 0 when enqueued,
// -1 when dropped.
#ifdef __OBJC__
#include <CoreMedia/CoreMedia.h>
#include <CoreVideo/CoreVideo.h>
int sink_push(void *handle, CVPixelBufferRef pixelBuffer, CMTime pts);
#endif

#endif

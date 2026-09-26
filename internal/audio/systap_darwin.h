// C-side interface of the system audio tap (Core Audio process tap, macOS 14.2+).
#ifndef REMOTEVISIO_SYSTAP_H
#define REMOTEVISIO_SYSTAP_H

#include <stdint.h>

typedef struct {
	uint32_t tap;        // AudioObjectID of the process tap
	uint32_t agg;        // AudioObjectID of the private aggregate device
	char     uid[256];   // aggregate device UID — what miniaudio opens
	char     output[256];// name of the tapped output device, for logging
	double   rate;       // the tap's native sample rate
	uint32_t channels;   // the tap's native channel count
	char     err[512];
} systap_result;

// systap_open creates a global tap (excluding this process) and a private
// aggregate device wrapping it. With mute nonzero the tapped audio no longer
// plays from the Mac's own output device and only goes into the tap.
// Returns 0 on success, nonzero on failure with the reason written to err.
int systap_open(systap_result *res, int mute);

void systap_close(uint32_t tap, uint32_t agg);

#endif

// C-side interface for muting this Mac's own microphones or speakers (see
// micmute.go); output selects the output scope (speakers) over the input one.
#ifndef REMOTEVISIO_MICMUTE_H
#define REMOTEVISIO_MICMUTE_H

#include <stdint.h>

#define MICMUTE_MAX_VOLUMES 16

typedef struct {
	char     uid[256];
	char     name[256];
	int      has_mute;                        // a settable input mute switch
	int      mute;                            // its position
	int      nvol;                            // settable input volumes below
	uint32_t vol_element[MICMUTE_MAX_VOLUMES]; // 0 = the main volume, else a channel
	float    vol[MICMUTE_MAX_VOLUMES];
} micmute_dev;

// micmute_list fills devs (at most max) with this Mac's microphones (or,
// with output, its speakers): input (output) devices that are neither virtual nor aggregate, nor hidden, nor the audio
// device older Remote Visio versions installed. It returns how many, or -1
// when the device list is unreadable.
int micmute_list(micmute_dev *devs, int max, int output);

// micmute_set_mute sets the input mute switch of the device with this UID;
// micmute_set_volume one of its input volumes. Both return a Core Audio
// status: 0 on success, -1 when no device has this UID.
int micmute_set_mute(const char *uid, int mute, int output);
int micmute_set_volume(const char *uid, uint32_t element, float volume, int output);

#endif

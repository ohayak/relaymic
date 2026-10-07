// Core Audio side of muting this Mac's own microphones or speakers (see
// micmute.go): output is 0 for the input scope (microphones), 1 for the
// output scope (speakers).
#include "micmute_darwin.h"

#include <CoreAudio/CoreAudio.h>
#include <stdlib.h>
#include <string.h>

static AudioObjectPropertyScope scope_of(int output) {
	return output ? kAudioObjectPropertyScopeOutput : kAudioObjectPropertyScopeInput;
}

static int has_streams(AudioObjectID id, int output) {
	AudioObjectPropertyAddress a = {kAudioDevicePropertyStreams, scope_of(output), kAudioObjectPropertyElementMain};
	UInt32 size = 0;
	return AudioObjectGetPropertyDataSize(id, &a, 0, NULL, &size) == noErr && size > 0;
}

static UInt32 get_u32(AudioObjectID id, AudioObjectPropertySelector sel, AudioObjectPropertyScope scope, UInt32 element) {
	AudioObjectPropertyAddress a = {sel, scope, element};
	UInt32 v = 0, size = sizeof v;
	if (!AudioObjectHasProperty(id, &a) || AudioObjectGetPropertyData(id, &a, 0, NULL, &size, &v) != noErr) return 0;
	return v;
}

static int get_string(AudioObjectID id, AudioObjectPropertySelector sel, char *out, size_t len) {
	AudioObjectPropertyAddress a = {sel, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
	CFStringRef s = NULL;
	UInt32 size = sizeof s;
	if (AudioObjectGetPropertyData(id, &a, 0, NULL, &size, &s) != noErr || s == NULL) return -1;
	Boolean ok = CFStringGetCString(s, out, (CFIndex)len, kCFStringEncodingUTF8);
	CFRelease(s);
	return ok ? 0 : -1;
}

static int settable(AudioObjectID id, AudioObjectPropertySelector sel, UInt32 element, int output) {
	AudioObjectPropertyAddress a = {sel, scope_of(output), element};
	Boolean yes = false;
	return AudioObjectHasProperty(id, &a) && AudioObjectIsPropertySettable(id, &a, &yes) == noErr && yes;
}

// devices returns the system's device list (to free), and its length in n.
static AudioObjectID *devices(UInt32 *n) {
	AudioObjectPropertyAddress a = {kAudioHardwarePropertyDevices, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
	UInt32 size = 0;
	*n = 0;
	if (AudioObjectGetPropertyDataSize(kAudioObjectSystemObject, &a, 0, NULL, &size) != noErr) return NULL;
	AudioObjectID *ids = malloc(size > 0 ? size : sizeof(AudioObjectID));
	if (ids == NULL) return NULL;
	if (AudioObjectGetPropertyData(kAudioObjectSystemObject, &a, 0, NULL, &size, ids) != noErr) {
		free(ids);
		return NULL;
	}
	*n = size / sizeof(AudioObjectID);
	return ids;
}

int micmute_list(micmute_dev *devs, int max, int output) {
	UInt32 n = 0;
	AudioObjectID *ids = devices(&n);
	if (ids == NULL) return -1;
	int count = 0;
	for (UInt32 i = 0; i < n && count < max; i++) {
		AudioObjectID id = ids[i];
		if (!has_streams(id, output)) continue;
		UInt32 transport = get_u32(id, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain);
		if (transport == kAudioDeviceTransportTypeVirtual || transport == kAudioDeviceTransportTypeAggregate ||
		    transport == kAudioDeviceTransportTypeAutoAggregate) continue;
		if (get_u32(id, kAudioDevicePropertyIsHidden, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain)) continue;
		micmute_dev *d = &devs[count];
		memset(d, 0, sizeof *d);
		if (get_string(id, kAudioDevicePropertyDeviceUID, d->uid, sizeof d->uid) != 0) continue;
		// The audio device older Remote Visio versions installed (a Mac the
		// installer has not cleaned up yet) reports itself as virtual; this
		// holds whatever it reports.
		if (strncmp(d->uid, "RemoteVisio", 11) == 0) continue;
		if (get_string(id, kAudioObjectPropertyName, d->name, sizeof d->name) != 0) strcpy(d->name, d->uid);
		if (settable(id, kAudioDevicePropertyMute, kAudioObjectPropertyElementMain, output)) {
			d->has_mute = 1;
			d->mute = get_u32(id, kAudioDevicePropertyMute, scope_of(output), kAudioObjectPropertyElementMain) != 0;
		}
		// The volumes: the main one, or else each channel's.
		for (UInt32 el = 0; el <= MICMUTE_MAX_VOLUMES && d->nvol < MICMUTE_MAX_VOLUMES; el++) {
			if (!settable(id, kAudioDevicePropertyVolumeScalar, el, output)) continue;
			AudioObjectPropertyAddress a = {kAudioDevicePropertyVolumeScalar, scope_of(output), el};
			Float32 v = 0;
			UInt32 size = sizeof v;
			if (AudioObjectGetPropertyData(id, &a, 0, NULL, &size, &v) != noErr) continue;
			d->vol_element[d->nvol] = el;
			d->vol[d->nvol] = v;
			d->nvol++;
			if (el == kAudioObjectPropertyElementMain) break;
		}
		count++;
	}
	free(ids);
	return count;
}

static AudioObjectID find(const char *uid) {
	UInt32 n = 0;
	AudioObjectID *ids = devices(&n);
	if (ids == NULL) return kAudioObjectUnknown;
	AudioObjectID found = kAudioObjectUnknown;
	char got[256];
	for (UInt32 i = 0; i < n; i++) {
		if (get_string(ids[i], kAudioDevicePropertyDeviceUID, got, sizeof got) == 0 && strcmp(got, uid) == 0) {
			found = ids[i];
			break;
		}
	}
	free(ids);
	return found;
}

int micmute_set_mute(const char *uid, int mute, int output) {
	AudioObjectID id = find(uid);
	if (id == kAudioObjectUnknown) return -1;
	AudioObjectPropertyAddress a = {kAudioDevicePropertyMute, scope_of(output), kAudioObjectPropertyElementMain};
	UInt32 v = mute ? 1 : 0;
	return (int)AudioObjectSetPropertyData(id, &a, 0, NULL, sizeof v, &v);
}

int micmute_set_volume(const char *uid, uint32_t element, float volume, int output) {
	AudioObjectID id = find(uid);
	if (id == kAudioObjectUnknown) return -1;
	AudioObjectPropertyAddress a = {kAudioDevicePropertyVolumeScalar, scope_of(output), element};
	Float32 v = volume;
	return (int)AudioObjectSetPropertyData(id, &a, 0, NULL, sizeof v, &v);
}

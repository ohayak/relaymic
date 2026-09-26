// System audio tap: turns what this Mac is currently playing (the mix of all
// processes) into an input device private to this process, with no second
// BlackHole and no change to the system output device.
//
// Uses a Core Audio process tap (macOS 14.2+):
//   1. create a global tap that excludes this process: the mic audio the
//      receiver itself writes into BlackHole must never be captured back,
//      that would be a loopback;
//   2. create a private aggregate device holding only the tap (no real
//      sub-device: pulling the default output into it wedged coreaudiod);
//   3. hand the aggregate device's UID back to Go, which opens it with
//      miniaudio like any ordinary microphone.
//
// The first call prompts for the "System Audio Recording" permission
// (System Settings > Privacy & Security > Screen & System Audio Recording >
// System Audio Recording Only). If denied, the tap only delivers silence.
#import <Foundation/Foundation.h>
#import <CoreAudio/CoreAudio.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include "systap_darwin.h"

// The tap headers only exist in the macOS 14.2+ SDK. On an older SDK the
// receiver must still build, with the return path reported unavailable.
#if defined(__MAC_OS_X_VERSION_MAX_ALLOWED) && __MAC_OS_X_VERSION_MAX_ALLOWED >= 140200
#import <CoreAudio/AudioHardwareTapping.h>
#import <CoreAudio/CATapDescription.h>
#define REMOTEVISIO_HAVE_TAP 1
#else
#define REMOTEVISIO_HAVE_TAP 0
#endif

#if !REMOTEVISIO_HAVE_TAP

int systap_open(systap_result *res, int mute) {
	(void)mute;
	memset(res, 0, sizeof(*res));
	snprintf(res->err, sizeof(res->err), "built against an SDK older than macOS 14.2; the return path is unavailable in this build");
	return -1;
}

void systap_close(uint32_t tap, uint32_t agg) {
	(void)tap;
	(void)agg;
}

#else

static OSStatus getProp(AudioObjectID obj, AudioObjectPropertySelector sel,
                        UInt32 qualSize, const void *qual, UInt32 *size, void *out) {
	AudioObjectPropertyAddress addr = {sel, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain};
	return AudioObjectGetPropertyData(obj, &addr, qualSize, qual, size, out);
}

static void cfstr(CFStringRef s, char *out, size_t n) {
	out[0] = 0;
	if (s != NULL) {
		CFStringGetCString(s, out, (CFIndex)n, kCFStringEncodingUTF8);
	}
}

int systap_open(systap_result *res, int mute) {
	memset(res, 0, sizeof(*res));
	if (@available(macOS 14.2, *)) {
	@autoreleasepool {
		OSStatus st;
		UInt32 size;

		// This process's Core Audio object ID: the tap must exclude itself.
		pid_t pid = getpid();
		AudioObjectID self = kAudioObjectUnknown;
		size = sizeof(self);
		st = getProp(kAudioObjectSystemObject, kAudioHardwarePropertyTranslatePIDToProcessObject,
		             sizeof(pid), &pid, &size, &self);
		NSArray *exclude = (st == noErr && self != kAudioObjectUnknown) ? @[@(self)] : @[];

		// The default output device name is only logged, to tell the user where
		// the Mac's audio is going right now. In practice the global tap captures
		// the mix sent to the default output device (apps routed to another
		// device are not in it). The aggregate deliberately contains no real
		// device: pulling the default output in (on a machine whose default
		// output is BlackHole, that is BlackHole itself) makes the receiver hold
		// BlackHole through two paths at once, which in practice wedges the
		// driver until coreaudiod is restarted.
		AudioObjectID outDev = kAudioObjectUnknown;
		size = sizeof(outDev);
		if (getProp(kAudioObjectSystemObject, kAudioHardwarePropertyDefaultOutputDevice, 0, NULL, &size, &outDev) == noErr
		    && outDev != kAudioObjectUnknown) {
			CFStringRef outName = NULL;
			size = sizeof(outName);
			if (getProp(outDev, kAudioObjectPropertyName, 0, NULL, &size, &outName) == noErr && outName != NULL) {
				cfstr(outName, res->output, sizeof(res->output));
				CFRelease(outName);
			}
		}

		CATapDescription *desc = [[[CATapDescription alloc] initStereoGlobalTapButExcludeProcesses:exclude] autorelease];
		desc.name = @"Remote Visio Return Path";
		desc.privateTap = YES;              // does not show up in Audio MIDI Setup
		// By default the Mac keeps playing locally and the tap just takes a copy;
		// with -speaker-mute the tapped audio no longer goes to the Mac's own
		// output device, so the remote machine goes quiet while the sender still hears it.
		desc.muteBehavior = mute ? CATapMuted : CATapUnmuted;

		AudioObjectID tap = kAudioObjectUnknown;
		st = AudioHardwareCreateProcessTap(desc, &tap);
		if (st != noErr || tap == kAudioObjectUnknown) {
			snprintf(res->err, sizeof(res->err),
			         "failed to create system audio tap (OSStatus %d); check System Settings > Privacy & Security > Screen & System Audio Recording", (int)st);
			return -1;
		}

		NSString *aggUID = [NSString stringWithFormat:@"com.remotevisio.tap.%d", (int)pid];
		NSDictionary *dict = @{
			@kAudioAggregateDeviceNameKey: @"Remote Visio Return Path",
			@kAudioAggregateDeviceUIDKey: aggUID,
			@kAudioAggregateDeviceIsPrivateKey: @YES,
			@kAudioAggregateDeviceIsStackedKey: @NO,
			@kAudioAggregateDeviceTapAutoStartKey: @YES,
			@kAudioAggregateDeviceTapListKey: @[@{
				@kAudioSubTapUIDKey: desc.UUID.UUIDString,
				@kAudioSubTapDriftCompensationKey: @YES,
			}],
		};

		AudioObjectID agg = kAudioObjectUnknown;
		st = AudioHardwareCreateAggregateDevice((__bridge CFDictionaryRef)dict, &agg);
		if (st != noErr || agg == kAudioObjectUnknown) {
			AudioHardwareDestroyProcessTap(tap);
			snprintf(res->err, sizeof(res->err), "failed to create aggregate device (OSStatus %d)", (int)st);
			return -1;
		}

		AudioStreamBasicDescription fmt;
		memset(&fmt, 0, sizeof(fmt));
		size = sizeof(fmt);
		if (getProp(tap, kAudioTapPropertyFormat, 0, NULL, &size, &fmt) == noErr) {
			res->rate = fmt.mSampleRate;
			res->channels = fmt.mChannelsPerFrame;
		}

		res->tap = tap;
		res->agg = agg;
		strlcpy(res->uid, aggUID.UTF8String, sizeof(res->uid));
		return 0;
	}
	} else {
		snprintf(res->err, sizeof(res->err), "the return path needs macOS 14.2 or newer");
		return -1;
	}
}

void systap_close(uint32_t tap, uint32_t agg) {
	if (agg != kAudioObjectUnknown) {
		AudioHardwareDestroyAggregateDevice(agg);
	}
	if (tap != kAudioObjectUnknown) {
		if (@available(macOS 14.2, *)) {
			AudioHardwareDestroyProcessTap(tap);
		}
	}
}

#endif // REMOTEVISIO_HAVE_TAP

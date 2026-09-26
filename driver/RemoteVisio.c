// RemoteVisio.c — the Remote Visio virtual audio device, a Core Audio HAL plug-in.
//
// One device, "Remote Visio", with an output stream and an input stream. Whatever
// is played into the output side comes back out of the input side, so any
// app that reads "Remote Visio" as a microphone hears what the receiver wrote.
// Fixed format: 48 kHz, 2 channels, Float32. No controls.
//
// This runs inside coreaudiod. A crash here kills every app's audio, so the
// rules are strict: no allocation and no blocking on the IO path (one short,
// priority-inheriting lock guards the ring, see below); every property call
// validates its object and answers unknown selectors with an error instead
// of an assumption.
//
// Loopback ring: a fixed ring of frames indexed by absolute sample time.
// Output cycles write ("mix") at their output time, input cycles read at
// their input time, which the HAL keeps behind the output time by the IO
// buffer size. So a frame is always written before it is read. To keep a
// reader from hearing a stale lap of the ring when no output client is
// running, the ring is split into blocks, each stamped with the lap number
// in which it was last written. A reader only copies out of a block whose
// stamp matches its own lap and gets silence otherwise. The first writer to
// touch a block in a new lap clears it, later writers in the same lap add
// into it, which is how several output clients get mixed.
//
// coreaudiod runs one IO thread per client, so two apps playing into the
// device at the same time mix on different threads. Ring access is therefore
// serialised with an os_unfair_lock, held only for the bounded copy of one
// cycle (a few microseconds; the lock is priority-inheriting, which keeps it
// acceptable on the IO thread). Property and IO start/stop state is guarded
// by a separate mutex that the IO path never takes.

#include <CoreAudio/AudioServerPlugIn.h>
#include <CoreFoundation/CoreFoundation.h>
#include <mach/mach_time.h>
#include <math.h>
#include <os/lock.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>

#pragma mark Constants

enum {
	kObjectID_PlugIn       = kAudioObjectPlugInObject, // 1
	kObjectID_Device       = 2,
	kObjectID_StreamOutput = 3,
	kObjectID_StreamInput  = 4,
};

#define kDeviceName      "Remote Visio"
#define kDeviceUID       "RemoteVisio:Device"
#define kDeviceModelUID  "RemoteVisio:Model"
#define kManufacturer    "Remote Visio"

#define kSampleRate        48000.0
#define kChannels          2
#define kBytesPerFrame     (kChannels * (UInt32)sizeof(Float32))
#define kZeroTimeStampPeriod 16384u              // frames between zero time stamps
#define kRingFrames        65536u                // 4 periods, ~1.4 s at 48 kHz
#define kBlockFrames       256u
#define kBlocks            (kRingFrames / kBlockFrames)

// Sentinel lap for "never written".
#define kLapNever INT64_MIN

#pragma mark State

static pthread_mutex_t gStateMutex = PTHREAD_MUTEX_INITIALIZER;
static AudioServerPlugInHostRef gHost = NULL;
static UInt32 gRefCount = 0;

// IO state. gIOClients is changed under gStateMutex only; the IO thread
// never reads it. gAnchorHostTime/gSeed are written under the mutex before
// any IO cycle can run and read on the IO thread afterwards.
static UInt32 gIOClients = 0;
static UInt64 gAnchorHostTime = 0;
static _Atomic UInt64 gSeed = 1;
static Float64 gHostTicksPerFrame = 0;

static os_unfair_lock gRingLock = OS_UNFAIR_LOCK_INIT;
static Float32 gRing[kRingFrames * kChannels];
static SInt64  gBlockLap[kBlocks];

static AudioServerPlugInDriverInterface gInterface;
static AudioServerPlugInDriverInterface* gInterfacePtr = &gInterface;
static AudioServerPlugInDriverRef gDriverRef = &gInterfacePtr;

#pragma mark Helpers

static void FillFormat(AudioStreamBasicDescription* f) {
	memset(f, 0, sizeof(*f));
	f->mSampleRate       = kSampleRate;
	f->mFormatID         = kAudioFormatLinearPCM;
	f->mFormatFlags      = kAudioFormatFlagIsFloat | kAudioFormatFlagsNativeEndian | kAudioFormatFlagIsPacked;
	f->mBytesPerPacket   = kBytesPerFrame;
	f->mFramesPerPacket  = 1;
	f->mBytesPerFrame    = kBytesPerFrame;
	f->mChannelsPerFrame = kChannels;
	f->mBitsPerChannel   = 32;
}

static Boolean FormatIsSupported(const AudioStreamBasicDescription* f) {
	return f->mSampleRate == kSampleRate
		&& f->mFormatID == kAudioFormatLinearPCM
		&& f->mChannelsPerFrame == kChannels
		&& f->mBitsPerChannel == 32
		&& (f->mFormatFlags & kAudioFormatFlagIsFloat) != 0
		&& f->mBytesPerFrame == kBytesPerFrame
		&& f->mFramesPerPacket == 1;
}

static void ResetRing(void) {
	os_unfair_lock_lock(&gRingLock);
	for (UInt32 b = 0; b < kBlocks; b++) {
		gBlockLap[b] = kLapNever;
	}
	memset(gRing, 0, sizeof(gRing));
	os_unfair_lock_unlock(&gRingLock);
}

// Sample times arrive as Float64. Anything non-finite or absurdly large is a
// host bug; refuse it rather than feed undefined behaviour into the cast.
// floor() rather than truncation so that fractional negative times land in
// the same lap/index the ring helpers below would compute.
static Boolean SampleTime(Float64 st, SInt64* out) {
	if (!(st > -9.0e15 && st < 9.0e15)) return false;
	*out = (SInt64)floor(st);
	return true;
}

// Floor division/modulo so that negative sample times (possible for the
// first input cycles after start) map onto a lap/index pair consistently.
static SInt64 LapOf(SInt64 t) {
	SInt64 q = t / (SInt64)kRingFrames;
	if ((t % (SInt64)kRingFrames) < 0) q--;
	return q;
}
static UInt32 IndexOf(SInt64 t) {
	SInt64 r = t % (SInt64)kRingFrames;
	if (r < 0) r += (SInt64)kRingFrames;
	return (UInt32)r;
}

// Copy a CFString property out, taking a retain for the caller as the HAL expects.
static OSStatus OutString(const char* s, UInt32 inDataSize, UInt32* outDataSize, void* outData) {
	if (inDataSize < sizeof(CFStringRef)) return kAudioHardwareBadPropertySizeError;
	*(CFStringRef*)outData = CFStringCreateWithCString(NULL, s, kCFStringEncodingUTF8);
	*outDataSize = sizeof(CFStringRef);
	return kAudioHardwareNoError;
}

static OSStatus OutUInt32(UInt32 v, UInt32 inDataSize, UInt32* outDataSize, void* outData) {
	if (inDataSize < sizeof(UInt32)) return kAudioHardwareBadPropertySizeError;
	*(UInt32*)outData = v;
	*outDataSize = sizeof(UInt32);
	return kAudioHardwareNoError;
}

static OSStatus OutFloat64(Float64 v, UInt32 inDataSize, UInt32* outDataSize, void* outData) {
	if (inDataSize < sizeof(Float64)) return kAudioHardwareBadPropertySizeError;
	*(Float64*)outData = v;
	*outDataSize = sizeof(Float64);
	return kAudioHardwareNoError;
}

// Fill an AudioObjectID list, writing as many as fit and reporting the size used.
static OSStatus OutObjectList(const AudioObjectID* ids, UInt32 count, UInt32 inDataSize, UInt32* outDataSize, void* outData) {
	UInt32 n = inDataSize / sizeof(AudioObjectID);
	if (n > count) n = count;
	for (UInt32 i = 0; i < n; i++) ((AudioObjectID*)outData)[i] = ids[i];
	*outDataSize = n * sizeof(AudioObjectID);
	return kAudioHardwareNoError;
}

// Streams owned by the device, filtered by scope.
static UInt32 DeviceStreams(AudioObjectPropertyScope scope, AudioObjectID out[2]) {
	UInt32 n = 0;
	if (scope == kAudioObjectPropertyScopeGlobal || scope == kAudioObjectPropertyScopeOutput) out[n++] = kObjectID_StreamOutput;
	if (scope == kAudioObjectPropertyScopeGlobal || scope == kAudioObjectPropertyScopeInput)  out[n++] = kObjectID_StreamInput;
	return n;
}

// OwnedObjects may carry an array of AudioClassIDs; an empty array means
// everything. Each of our objects owns exactly one class of child, so the
// answer is whether any entry names that class, its base class or the wildcard.
static Boolean QualifierAllows(UInt32 qualSize, const void* qual, AudioClassID owned) {
	UInt32 n = qualSize / sizeof(AudioClassID);
	if (n == 0 || qual == NULL) return true;
	const AudioClassID* want = (const AudioClassID*)qual;
	for (UInt32 i = 0; i < n; i++) {
		if (want[i] == kAudioObjectClassID || want[i] == kAudioObjectClassIDWildcard || want[i] == owned) return true;
	}
	return false;
}

#pragma mark IUnknown

static HRESULT RemoteVisio_QueryInterface(void* inDriver, REFIID inUUID, LPVOID* outInterface) {
	if (outInterface == NULL) return E_POINTER;
	*outInterface = NULL;
	if (inDriver != gDriverRef) return E_NOINTERFACE;
	CFUUIDRef requested = CFUUIDCreateFromUUIDBytes(NULL, inUUID);
	if (requested == NULL) return E_NOINTERFACE;
	Boolean ok = CFEqual(requested, IUnknownUUID) || CFEqual(requested, kAudioServerPlugInDriverInterfaceUUID);
	CFRelease(requested);
	if (!ok) return E_NOINTERFACE;
	pthread_mutex_lock(&gStateMutex);
	gRefCount++;
	pthread_mutex_unlock(&gStateMutex);
	*outInterface = gDriverRef;
	return S_OK;
}

static ULONG RemoteVisio_AddRef(void* inDriver) {
	if (inDriver != gDriverRef) return 0;
	pthread_mutex_lock(&gStateMutex);
	ULONG n = ++gRefCount;
	pthread_mutex_unlock(&gStateMutex);
	return n;
}

static ULONG RemoteVisio_Release(void* inDriver) {
	if (inDriver != gDriverRef) return 0;
	pthread_mutex_lock(&gStateMutex);
	if (gRefCount > 0) gRefCount--;
	ULONG n = gRefCount;
	pthread_mutex_unlock(&gStateMutex);
	return n; // static object, nothing to free
}

#pragma mark Basic operations

static OSStatus RemoteVisio_Initialize(AudioServerPlugInDriverRef inDriver, AudioServerPlugInHostRef inHost) {
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	mach_timebase_info_data_t tb;
	mach_timebase_info(&tb);
	// host ticks per second = 1e9 * denom / numer
	gHostTicksPerFrame = (1000000000.0 * (Float64)tb.denom / (Float64)tb.numer) / kSampleRate;
	pthread_mutex_lock(&gStateMutex);
	gHost = inHost;
	gIOClients = 0;
	ResetRing();
	pthread_mutex_unlock(&gStateMutex);
	return kAudioHardwareNoError;
}

static OSStatus RemoteVisio_CreateDevice(AudioServerPlugInDriverRef inDriver, CFDictionaryRef inDescription,
                                      const AudioServerPlugInClientInfo* inClientInfo, AudioObjectID* outDeviceObjectID) {
	(void)inDriver; (void)inDescription; (void)inClientInfo; (void)outDeviceObjectID;
	return kAudioHardwareUnsupportedOperationError;
}

static OSStatus RemoteVisio_DestroyDevice(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID) {
	(void)inDriver; (void)inDeviceObjectID;
	return kAudioHardwareUnsupportedOperationError;
}

static OSStatus RemoteVisio_AddDeviceClient(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID,
                                         const AudioServerPlugInClientInfo* inClientInfo) {
	(void)inClientInfo;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
	return kAudioHardwareNoError;
}

static OSStatus RemoteVisio_RemoveDeviceClient(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID,
                                            const AudioServerPlugInClientInfo* inClientInfo) {
	(void)inClientInfo;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
	return kAudioHardwareNoError;
}

static OSStatus RemoteVisio_PerformDeviceConfigurationChange(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID,
                                                          UInt64 inChangeAction, void* inChangeInfo) {
	(void)inChangeAction; (void)inChangeInfo;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
	return kAudioHardwareNoError; // we never request one
}

static OSStatus RemoteVisio_AbortDeviceConfigurationChange(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID,
                                                        UInt64 inChangeAction, void* inChangeInfo) {
	(void)inChangeAction; (void)inChangeInfo;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
	return kAudioHardwareNoError;
}

#pragma mark Properties: plug-in object

static Boolean PlugIn_HasProperty(const AudioObjectPropertyAddress* a) {
	switch (a->mSelector) {
	case kAudioObjectPropertyBaseClass:
	case kAudioObjectPropertyClass:
	case kAudioObjectPropertyOwner:
	case kAudioObjectPropertyManufacturer:
	case kAudioObjectPropertyOwnedObjects:
	case kAudioPlugInPropertyDeviceList:
	case kAudioPlugInPropertyTranslateUIDToDevice:
	case kAudioPlugInPropertyResourceBundle:
		return true;
	default:
		return false;
	}
}

static OSStatus PlugIn_GetSize(const AudioObjectPropertyAddress* a, UInt32 qualSize, const void* qual, UInt32* outSize) {
	switch (a->mSelector) {
	case kAudioObjectPropertyBaseClass:
	case kAudioObjectPropertyClass:
	case kAudioObjectPropertyOwner:
	case kAudioPlugInPropertyTranslateUIDToDevice:
		*outSize = sizeof(AudioObjectID); return kAudioHardwareNoError; // AudioClassID is the same size
	case kAudioObjectPropertyManufacturer:
	case kAudioPlugInPropertyResourceBundle:
		*outSize = sizeof(CFStringRef); return kAudioHardwareNoError;
	case kAudioObjectPropertyOwnedObjects:
		*outSize = QualifierAllows(qualSize, qual, kAudioDeviceClassID) ? sizeof(AudioObjectID) : 0;
		return kAudioHardwareNoError;
	case kAudioPlugInPropertyDeviceList:
		*outSize = sizeof(AudioObjectID); return kAudioHardwareNoError;
	default:
		return kAudioHardwareUnknownPropertyError;
	}
}

static OSStatus PlugIn_Get(const AudioObjectPropertyAddress* a, UInt32 qualSize, const void* qual,
                           UInt32 inDataSize, UInt32* outDataSize, void* outData) {
	static const AudioObjectID device = kObjectID_Device;
	switch (a->mSelector) {
	case kAudioObjectPropertyBaseClass:    return OutUInt32(kAudioObjectClassID, inDataSize, outDataSize, outData);
	case kAudioObjectPropertyClass:        return OutUInt32(kAudioPlugInClassID, inDataSize, outDataSize, outData);
	case kAudioObjectPropertyOwner:        return OutUInt32(kAudioObjectUnknown, inDataSize, outDataSize, outData);
	case kAudioObjectPropertyManufacturer: return OutString(kManufacturer, inDataSize, outDataSize, outData);
	case kAudioPlugInPropertyResourceBundle: return OutString("", inDataSize, outDataSize, outData);
	case kAudioObjectPropertyOwnedObjects:
		if (!QualifierAllows(qualSize, qual, kAudioDeviceClassID)) { *outDataSize = 0; return kAudioHardwareNoError; }
		return OutObjectList(&device, 1, inDataSize, outDataSize, outData);
	case kAudioPlugInPropertyDeviceList:
		return OutObjectList(&device, 1, inDataSize, outDataSize, outData);
	case kAudioPlugInPropertyTranslateUIDToDevice: {
		if (inDataSize < sizeof(AudioObjectID)) return kAudioHardwareBadPropertySizeError;
		AudioObjectID found = kAudioObjectUnknown;
		if (qualSize >= sizeof(CFStringRef) && qual != NULL) {
			CFStringRef uid = *(const CFStringRef*)qual;
			if (uid != NULL && CFStringCompare(uid, CFSTR(kDeviceUID), 0) == kCFCompareEqualTo) found = kObjectID_Device;
		}
		*(AudioObjectID*)outData = found;
		*outDataSize = sizeof(AudioObjectID);
		return kAudioHardwareNoError;
	}
	default:
		return kAudioHardwareUnknownPropertyError;
	}
}

#pragma mark Properties: device object

static Boolean Device_HasProperty(const AudioObjectPropertyAddress* a) {
	switch (a->mSelector) {
	case kAudioObjectPropertyBaseClass:
	case kAudioObjectPropertyClass:
	case kAudioObjectPropertyOwner:
	case kAudioObjectPropertyName:
	case kAudioObjectPropertyManufacturer:
	case kAudioObjectPropertyOwnedObjects:
	case kAudioDevicePropertyDeviceUID:
	case kAudioDevicePropertyModelUID:
	case kAudioDevicePropertyTransportType:
	case kAudioDevicePropertyRelatedDevices:
	case kAudioDevicePropertyClockDomain:
	case kAudioDevicePropertyDeviceIsAlive:
	case kAudioDevicePropertyDeviceIsRunning:
	case kAudioDevicePropertyDeviceCanBeDefaultDevice:
	case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
	case kAudioDevicePropertyLatency:
	case kAudioDevicePropertyStreams:
	case kAudioObjectPropertyControlList:
	case kAudioDevicePropertySafetyOffset:
	case kAudioDevicePropertyNominalSampleRate:
	case kAudioDevicePropertyAvailableNominalSampleRates:
	case kAudioDevicePropertyIsHidden:
	case kAudioDevicePropertyZeroTimeStampPeriod:
		return true;
	case kAudioDevicePropertyPreferredChannelsForStereo:
	case kAudioDevicePropertyPreferredChannelLayout:
		return a->mScope == kAudioObjectPropertyScopeInput || a->mScope == kAudioObjectPropertyScopeOutput;
	default:
		return false;
	}
}

static OSStatus Device_GetSize(const AudioObjectPropertyAddress* a, UInt32 qualSize, const void* qual, UInt32* outSize) {
	AudioObjectID streams[2];
	switch (a->mSelector) {
	case kAudioObjectPropertyBaseClass:
	case kAudioObjectPropertyClass:
	case kAudioObjectPropertyOwner:
	case kAudioDevicePropertyTransportType:
	case kAudioDevicePropertyClockDomain:
	case kAudioDevicePropertyDeviceIsAlive:
	case kAudioDevicePropertyDeviceIsRunning:
	case kAudioDevicePropertyDeviceCanBeDefaultDevice:
	case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
	case kAudioDevicePropertyLatency:
	case kAudioDevicePropertySafetyOffset:
	case kAudioDevicePropertyIsHidden:
	case kAudioDevicePropertyZeroTimeStampPeriod:
		*outSize = sizeof(UInt32); return kAudioHardwareNoError;
	case kAudioObjectPropertyName:
	case kAudioObjectPropertyManufacturer:
	case kAudioDevicePropertyDeviceUID:
	case kAudioDevicePropertyModelUID:
		*outSize = sizeof(CFStringRef); return kAudioHardwareNoError;
	case kAudioObjectPropertyOwnedObjects:
		*outSize = QualifierAllows(qualSize, qual, kAudioStreamClassID) ? DeviceStreams(a->mScope, streams) * sizeof(AudioObjectID) : 0;
		return kAudioHardwareNoError;
	case kAudioDevicePropertyStreams:
		*outSize = DeviceStreams(a->mScope, streams) * sizeof(AudioObjectID); return kAudioHardwareNoError;
	case kAudioDevicePropertyRelatedDevices:
		*outSize = sizeof(AudioObjectID); return kAudioHardwareNoError;
	case kAudioObjectPropertyControlList:
		*outSize = 0; return kAudioHardwareNoError;
	case kAudioDevicePropertyNominalSampleRate:
		*outSize = sizeof(Float64); return kAudioHardwareNoError;
	case kAudioDevicePropertyAvailableNominalSampleRates:
		*outSize = sizeof(AudioValueRange); return kAudioHardwareNoError;
	case kAudioDevicePropertyPreferredChannelsForStereo:
		if (a->mScope != kAudioObjectPropertyScopeInput && a->mScope != kAudioObjectPropertyScopeOutput) return kAudioHardwareUnknownPropertyError;
		*outSize = 2 * sizeof(UInt32); return kAudioHardwareNoError;
	case kAudioDevicePropertyPreferredChannelLayout:
		if (a->mScope != kAudioObjectPropertyScopeInput && a->mScope != kAudioObjectPropertyScopeOutput) return kAudioHardwareUnknownPropertyError;
		*outSize = (UInt32)(offsetof(AudioChannelLayout, mChannelDescriptions) + kChannels * sizeof(AudioChannelDescription));
		return kAudioHardwareNoError;
	default:
		return kAudioHardwareUnknownPropertyError;
	}
}

static OSStatus Device_Get(const AudioObjectPropertyAddress* a, UInt32 qualSize, const void* qual,
                           UInt32 inDataSize, UInt32* outDataSize, void* outData) {
	static const AudioObjectID self = kObjectID_Device;
	AudioObjectID streams[2];
	switch (a->mSelector) {
	case kAudioObjectPropertyBaseClass:    return OutUInt32(kAudioObjectClassID, inDataSize, outDataSize, outData);
	case kAudioObjectPropertyClass:        return OutUInt32(kAudioDeviceClassID, inDataSize, outDataSize, outData);
	case kAudioObjectPropertyOwner:        return OutUInt32(kObjectID_PlugIn, inDataSize, outDataSize, outData);
	case kAudioObjectPropertyName:         return OutString(kDeviceName, inDataSize, outDataSize, outData);
	case kAudioObjectPropertyManufacturer: return OutString(kManufacturer, inDataSize, outDataSize, outData);
	case kAudioDevicePropertyDeviceUID:    return OutString(kDeviceUID, inDataSize, outDataSize, outData);
	case kAudioDevicePropertyModelUID:     return OutString(kDeviceModelUID, inDataSize, outDataSize, outData);
	case kAudioDevicePropertyTransportType: return OutUInt32(kAudioDeviceTransportTypeVirtual, inDataSize, outDataSize, outData);
	case kAudioDevicePropertyClockDomain:  return OutUInt32(0, inDataSize, outDataSize, outData);
	case kAudioDevicePropertyDeviceIsAlive: return OutUInt32(1, inDataSize, outDataSize, outData);
	case kAudioDevicePropertyDeviceIsRunning: {
		pthread_mutex_lock(&gStateMutex);
		UInt32 running = gIOClients > 0 ? 1 : 0;
		pthread_mutex_unlock(&gStateMutex);
		return OutUInt32(running, inDataSize, outDataSize, outData);
	}
	case kAudioDevicePropertyDeviceCanBeDefaultDevice:
		// Selectable as the default input (that is the whole point), never as
		// the default output: a fresh install must not silently swallow the
		// Mac's sound output, and nothing useful is ever played into it anyway.
		return OutUInt32(a->mScope == kAudioObjectPropertyScopeOutput ? 0 : 1, inDataSize, outDataSize, outData);
	case kAudioDevicePropertyDeviceCanBeDefaultSystemDevice:
		return OutUInt32(0, inDataSize, outDataSize, outData);
	case kAudioDevicePropertyLatency:
	case kAudioDevicePropertySafetyOffset:
		return OutUInt32(0, inDataSize, outDataSize, outData);
	case kAudioDevicePropertyIsHidden:
		return OutUInt32(0, inDataSize, outDataSize, outData);
	case kAudioDevicePropertyZeroTimeStampPeriod:
		return OutUInt32(kZeroTimeStampPeriod, inDataSize, outDataSize, outData);
	case kAudioObjectPropertyOwnedObjects:
		if (!QualifierAllows(qualSize, qual, kAudioStreamClassID)) { *outDataSize = 0; return kAudioHardwareNoError; }
		return OutObjectList(streams, DeviceStreams(a->mScope, streams), inDataSize, outDataSize, outData);
	case kAudioDevicePropertyStreams:
		return OutObjectList(streams, DeviceStreams(a->mScope, streams), inDataSize, outDataSize, outData);
	case kAudioDevicePropertyRelatedDevices:
		return OutObjectList(&self, 1, inDataSize, outDataSize, outData);
	case kAudioObjectPropertyControlList:
		*outDataSize = 0; return kAudioHardwareNoError;
	case kAudioDevicePropertyNominalSampleRate:
		return OutFloat64(kSampleRate, inDataSize, outDataSize, outData);
	case kAudioDevicePropertyAvailableNominalSampleRates: {
		UInt32 n = inDataSize / sizeof(AudioValueRange);
		if (n > 0) {
			AudioValueRange* r = (AudioValueRange*)outData;
			r->mMinimum = kSampleRate;
			r->mMaximum = kSampleRate;
			*outDataSize = sizeof(AudioValueRange);
		} else {
			*outDataSize = 0;
		}
		return kAudioHardwareNoError;
	}
	case kAudioDevicePropertyPreferredChannelsForStereo: {
		if (a->mScope != kAudioObjectPropertyScopeInput && a->mScope != kAudioObjectPropertyScopeOutput) return kAudioHardwareUnknownPropertyError;
		if (inDataSize < 2 * sizeof(UInt32)) return kAudioHardwareBadPropertySizeError;
		((UInt32*)outData)[0] = 1;
		((UInt32*)outData)[1] = 2;
		*outDataSize = 2 * sizeof(UInt32);
		return kAudioHardwareNoError;
	}
	case kAudioDevicePropertyPreferredChannelLayout: {
		if (a->mScope != kAudioObjectPropertyScopeInput && a->mScope != kAudioObjectPropertyScopeOutput) return kAudioHardwareUnknownPropertyError;
		UInt32 need = (UInt32)(offsetof(AudioChannelLayout, mChannelDescriptions) + kChannels * sizeof(AudioChannelDescription));
		if (inDataSize < need) return kAudioHardwareBadPropertySizeError;
		AudioChannelLayout* l = (AudioChannelLayout*)outData;
		memset(l, 0, need);
		l->mChannelLayoutTag = kAudioChannelLayoutTag_UseChannelDescriptions;
		l->mChannelBitmap = 0;
		l->mNumberChannelDescriptions = kChannels;
		l->mChannelDescriptions[0].mChannelLabel = kAudioChannelLabel_Left;
		l->mChannelDescriptions[1].mChannelLabel = kAudioChannelLabel_Right;
		*outDataSize = need;
		return kAudioHardwareNoError;
	}
	default:
		return kAudioHardwareUnknownPropertyError;
	}
}

#pragma mark Properties: stream objects

static Boolean Stream_HasProperty(const AudioObjectPropertyAddress* a) {
	switch (a->mSelector) {
	case kAudioObjectPropertyBaseClass:
	case kAudioObjectPropertyClass:
	case kAudioObjectPropertyOwner:
	case kAudioStreamPropertyIsActive:
	case kAudioStreamPropertyDirection:
	case kAudioStreamPropertyTerminalType:
	case kAudioStreamPropertyStartingChannel:
	case kAudioStreamPropertyLatency:
	case kAudioStreamPropertyVirtualFormat:
	case kAudioStreamPropertyPhysicalFormat:
	case kAudioStreamPropertyAvailableVirtualFormats:
	case kAudioStreamPropertyAvailablePhysicalFormats:
		return true;
	default:
		return false;
	}
}

static OSStatus Stream_GetSize(const AudioObjectPropertyAddress* a, UInt32* outSize) {
	switch (a->mSelector) {
	case kAudioObjectPropertyBaseClass:
	case kAudioObjectPropertyClass:
	case kAudioObjectPropertyOwner:
	case kAudioStreamPropertyIsActive:
	case kAudioStreamPropertyDirection:
	case kAudioStreamPropertyTerminalType:
	case kAudioStreamPropertyStartingChannel:
	case kAudioStreamPropertyLatency:
		*outSize = sizeof(UInt32); return kAudioHardwareNoError;
	case kAudioStreamPropertyVirtualFormat:
	case kAudioStreamPropertyPhysicalFormat:
		*outSize = sizeof(AudioStreamBasicDescription); return kAudioHardwareNoError;
	case kAudioStreamPropertyAvailableVirtualFormats:
	case kAudioStreamPropertyAvailablePhysicalFormats:
		*outSize = sizeof(AudioStreamRangedDescription); return kAudioHardwareNoError;
	default:
		return kAudioHardwareUnknownPropertyError;
	}
}

static OSStatus Stream_Get(AudioObjectID id, const AudioObjectPropertyAddress* a,
                           UInt32 inDataSize, UInt32* outDataSize, void* outData) {
	Boolean isInput = id == kObjectID_StreamInput;
	switch (a->mSelector) {
	case kAudioObjectPropertyBaseClass: return OutUInt32(kAudioObjectClassID, inDataSize, outDataSize, outData);
	case kAudioObjectPropertyClass:     return OutUInt32(kAudioStreamClassID, inDataSize, outDataSize, outData);
	case kAudioObjectPropertyOwner:     return OutUInt32(kObjectID_Device, inDataSize, outDataSize, outData);
	case kAudioStreamPropertyIsActive:  return OutUInt32(1, inDataSize, outDataSize, outData);
	case kAudioStreamPropertyDirection: return OutUInt32(isInput ? 1 : 0, inDataSize, outDataSize, outData);
	case kAudioStreamPropertyTerminalType:
		return OutUInt32(isInput ? kAudioStreamTerminalTypeMicrophone : kAudioStreamTerminalTypeSpeaker, inDataSize, outDataSize, outData);
	case kAudioStreamPropertyStartingChannel: return OutUInt32(1, inDataSize, outDataSize, outData);
	case kAudioStreamPropertyLatency:   return OutUInt32(0, inDataSize, outDataSize, outData);
	case kAudioStreamPropertyVirtualFormat:
	case kAudioStreamPropertyPhysicalFormat:
		if (inDataSize < sizeof(AudioStreamBasicDescription)) return kAudioHardwareBadPropertySizeError;
		FillFormat((AudioStreamBasicDescription*)outData);
		*outDataSize = sizeof(AudioStreamBasicDescription);
		return kAudioHardwareNoError;
	case kAudioStreamPropertyAvailableVirtualFormats:
	case kAudioStreamPropertyAvailablePhysicalFormats: {
		UInt32 n = inDataSize / sizeof(AudioStreamRangedDescription);
		if (n > 0) {
			AudioStreamRangedDescription* r = (AudioStreamRangedDescription*)outData;
			FillFormat(&r->mFormat);
			r->mSampleRateRange.mMinimum = kSampleRate;
			r->mSampleRateRange.mMaximum = kSampleRate;
			*outDataSize = sizeof(AudioStreamRangedDescription);
		} else {
			*outDataSize = 0;
		}
		return kAudioHardwareNoError;
	}
	default:
		return kAudioHardwareUnknownPropertyError;
	}
}

#pragma mark Property dispatch

static Boolean RemoteVisio_HasProperty(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientProcessID,
                                    const AudioObjectPropertyAddress* inAddress) {
	(void)inClientProcessID;
	if (inDriver != gDriverRef || inAddress == NULL) return false;
	switch (inObjectID) {
	case kObjectID_PlugIn:       return PlugIn_HasProperty(inAddress);
	case kObjectID_Device:       return Device_HasProperty(inAddress);
	case kObjectID_StreamOutput:
	case kObjectID_StreamInput:  return Stream_HasProperty(inAddress);
	default:                     return false;
	}
}

static OSStatus RemoteVisio_IsPropertySettable(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientProcessID,
                                            const AudioObjectPropertyAddress* inAddress, Boolean* outIsSettable) {
	(void)inClientProcessID;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inAddress == NULL || outIsSettable == NULL) return kAudioHardwareIllegalOperationError;
	if (!RemoteVisio_HasProperty(inDriver, inObjectID, inClientProcessID, inAddress)) {
		return inObjectID >= kObjectID_PlugIn && inObjectID <= kObjectID_StreamInput
			? kAudioHardwareUnknownPropertyError : kAudioHardwareBadObjectError;
	}
	switch (inObjectID) {
	case kObjectID_Device:
		*outIsSettable = inAddress->mSelector == kAudioDevicePropertyNominalSampleRate;
		break;
	case kObjectID_StreamOutput:
	case kObjectID_StreamInput:
		// The streams are always active; saying IsActive is settable and then
		// ignoring the value would leave the host's idea of it out of sync.
		*outIsSettable = inAddress->mSelector == kAudioStreamPropertyVirtualFormat
			|| inAddress->mSelector == kAudioStreamPropertyPhysicalFormat;
		break;
	default:
		*outIsSettable = false;
	}
	return kAudioHardwareNoError;
}

static OSStatus RemoteVisio_GetPropertyDataSize(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientProcessID,
                                             const AudioObjectPropertyAddress* inAddress, UInt32 inQualifierDataSize,
                                             const void* inQualifierData, UInt32* outDataSize) {
	(void)inClientProcessID;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inAddress == NULL || outDataSize == NULL) return kAudioHardwareIllegalOperationError;
	switch (inObjectID) {
	case kObjectID_PlugIn:       return PlugIn_GetSize(inAddress, inQualifierDataSize, inQualifierData, outDataSize);
	case kObjectID_Device:       return Device_GetSize(inAddress, inQualifierDataSize, inQualifierData, outDataSize);
	case kObjectID_StreamOutput:
	case kObjectID_StreamInput:  return Stream_GetSize(inAddress, outDataSize);
	default:                     return kAudioHardwareBadObjectError;
	}
}

static OSStatus RemoteVisio_GetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientProcessID,
                                         const AudioObjectPropertyAddress* inAddress, UInt32 inQualifierDataSize,
                                         const void* inQualifierData, UInt32 inDataSize, UInt32* outDataSize, void* outData) {
	(void)inClientProcessID;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inAddress == NULL || outDataSize == NULL || (outData == NULL && inDataSize > 0)) return kAudioHardwareIllegalOperationError;
	switch (inObjectID) {
	case kObjectID_PlugIn:       return PlugIn_Get(inAddress, inQualifierDataSize, inQualifierData, inDataSize, outDataSize, outData);
	case kObjectID_Device:       return Device_Get(inAddress, inQualifierDataSize, inQualifierData, inDataSize, outDataSize, outData);
	case kObjectID_StreamOutput:
	case kObjectID_StreamInput:  return Stream_Get(inObjectID, inAddress, inDataSize, outDataSize, outData);
	default:                     return kAudioHardwareBadObjectError;
	}
}

static OSStatus RemoteVisio_SetPropertyData(AudioServerPlugInDriverRef inDriver, AudioObjectID inObjectID, pid_t inClientProcessID,
                                         const AudioObjectPropertyAddress* inAddress, UInt32 inQualifierDataSize,
                                         const void* inQualifierData, UInt32 inDataSize, const void* inData) {
	(void)inClientProcessID; (void)inQualifierDataSize; (void)inQualifierData;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inAddress == NULL || (inData == NULL && inDataSize > 0)) return kAudioHardwareIllegalOperationError;
	switch (inObjectID) {
	case kObjectID_PlugIn:
		return PlugIn_HasProperty(inAddress) ? kAudioHardwareUnsupportedOperationError : kAudioHardwareUnknownPropertyError;
	case kObjectID_Device:
		if (!Device_HasProperty(inAddress)) return kAudioHardwareUnknownPropertyError;
		if (inAddress->mSelector == kAudioDevicePropertyNominalSampleRate) {
			if (inDataSize < sizeof(Float64)) return kAudioHardwareBadPropertySizeError;
			// One rate only. Setting it to what it already is succeeds, anything else is refused.
			return *(const Float64*)inData == kSampleRate ? kAudioHardwareNoError : kAudioHardwareIllegalOperationError;
		}
		return kAudioHardwareUnsupportedOperationError;
	case kObjectID_StreamOutput:
	case kObjectID_StreamInput:
		if (!Stream_HasProperty(inAddress)) return kAudioHardwareUnknownPropertyError;
		switch (inAddress->mSelector) {
		case kAudioStreamPropertyVirtualFormat:
		case kAudioStreamPropertyPhysicalFormat:
			if (inDataSize < sizeof(AudioStreamBasicDescription)) return kAudioHardwareBadPropertySizeError;
			return FormatIsSupported((const AudioStreamBasicDescription*)inData) ? kAudioHardwareNoError : kAudioDeviceUnsupportedFormatError;
		default:
			return kAudioHardwareUnsupportedOperationError;
		}
	default:
		return kAudioHardwareBadObjectError;
	}
}

#pragma mark IO

static void NotifyRunningChanged(void) {
	if (gHost == NULL) return;
	AudioObjectPropertyAddress addr = { kAudioDevicePropertyDeviceIsRunning, kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyElementMain };
	gHost->PropertiesChanged(gHost, kObjectID_Device, 1, &addr);
}

static OSStatus RemoteVisio_StartIO(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID) {
	(void)inClientID;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
	Boolean changed = false;
	pthread_mutex_lock(&gStateMutex);
	if (gIOClients == UINT32_MAX) {
		pthread_mutex_unlock(&gStateMutex);
		return kAudioHardwareIllegalOperationError;
	}
	if (gIOClients == 0) {
		// First client: a fresh time line. New anchor, new seed so the HAL
		// resynchronises, and a clean ring so nothing from last time leaks out.
		ResetRing();
		gAnchorHostTime = mach_absolute_time();
		atomic_fetch_add(&gSeed, 1);
		changed = true;
	}
	gIOClients++;
	pthread_mutex_unlock(&gStateMutex);
	if (changed) NotifyRunningChanged();
	return kAudioHardwareNoError;
}

static OSStatus RemoteVisio_StopIO(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID) {
	(void)inClientID;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
	Boolean changed = false;
	pthread_mutex_lock(&gStateMutex);
	if (gIOClients > 0) {
		gIOClients--;
		changed = gIOClients == 0;
	}
	pthread_mutex_unlock(&gStateMutex);
	if (changed) NotifyRunningChanged();
	return kAudioHardwareNoError;
}

// The device clock is the host clock: sample time advances at exactly
// 48 kHz of host time from the anchor. Computed directly from the current
// host time so a stalled IO thread catches up instead of drifting.
static OSStatus RemoteVisio_GetZeroTimeStamp(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID,
                                          Float64* outSampleTime, UInt64* outHostTime, UInt64* outSeed) {
	(void)inClientID;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
	if (outSampleTime == NULL || outHostTime == NULL || outSeed == NULL) return kAudioHardwareIllegalOperationError;
	UInt64 now = mach_absolute_time();
	UInt64 anchor = gAnchorHostTime;
	Float64 ticksPerPeriod = gHostTicksPerFrame * (Float64)kZeroTimeStampPeriod;
	UInt64 periods = 0;
	if (now > anchor && ticksPerPeriod > 0) {
		periods = (UInt64)((Float64)(now - anchor) / ticksPerPeriod);
	}
	*outSampleTime = (Float64)periods * (Float64)kZeroTimeStampPeriod;
	*outHostTime = anchor + (UInt64)((Float64)periods * ticksPerPeriod);
	*outSeed = atomic_load(&gSeed);
	return kAudioHardwareNoError;
}

static OSStatus RemoteVisio_WillDoIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID,
                                           UInt32 inOperationID, Boolean* outWillDo, Boolean* outWillDoInPlace) {
	(void)inClientID;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
	if (outWillDo == NULL || outWillDoInPlace == NULL) return kAudioHardwareIllegalOperationError;
	switch (inOperationID) {
	case kAudioServerPlugInIOOperationReadInput:
	case kAudioServerPlugInIOOperationWriteMix:
		*outWillDo = true;
		*outWillDoInPlace = true;
		break;
	default:
		*outWillDo = false;
		*outWillDoInPlace = true;
	}
	return kAudioHardwareNoError;
}

static OSStatus RemoteVisio_BeginIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID,
                                          UInt32 inOperationID, UInt32 inIOBufferFrameSize, const AudioServerPlugInIOCycleInfo* inIOCycleInfo) {
	(void)inClientID; (void)inOperationID; (void)inIOBufferFrameSize; (void)inIOCycleInfo;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
	return kAudioHardwareNoError;
}

static OSStatus RemoteVisio_EndIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, UInt32 inClientID,
                                        UInt32 inOperationID, UInt32 inIOBufferFrameSize, const AudioServerPlugInIOCycleInfo* inIOCycleInfo) {
	(void)inClientID; (void)inOperationID; (void)inIOBufferFrameSize; (void)inIOCycleInfo;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
	return kAudioHardwareNoError;
}

// Mix `frames` interleaved stereo frames from `in` into the ring at sample time `t`.
static void RingMix(SInt64 t, const Float32* in, UInt32 frames) {
	UInt32 done = 0;
	while (done < frames) {
		SInt64 lap = LapOf(t);
		UInt32 idx = IndexOf(t);
		UInt32 block = idx / kBlockFrames;
		UInt32 blockEnd = (block + 1) * kBlockFrames;
		UInt32 run = frames - done;
		if (run > blockEnd - idx) run = blockEnd - idx;
		if (gBlockLap[block] != lap) {
			// First touch of this block in this lap: whatever is there is a lap old.
			memset(&gRing[(size_t)block * kBlockFrames * kChannels], 0, kBlockFrames * kChannels * sizeof(Float32));
			gBlockLap[block] = lap;
		}
		Float32* dst = &gRing[(size_t)idx * kChannels];
		const Float32* src = &in[(size_t)done * kChannels];
		for (UInt32 i = 0; i < run * kChannels; i++) dst[i] += src[i];
		t += run;
		done += run;
	}
}

// Copy `frames` frames out of the ring at sample time `t`; silence where
// nothing was written in this lap.
static void RingRead(SInt64 t, Float32* out, UInt32 frames) {
	UInt32 done = 0;
	while (done < frames) {
		SInt64 lap = LapOf(t);
		UInt32 idx = IndexOf(t);
		UInt32 block = idx / kBlockFrames;
		UInt32 blockEnd = (block + 1) * kBlockFrames;
		UInt32 run = frames - done;
		if (run > blockEnd - idx) run = blockEnd - idx;
		Float32* dst = &out[(size_t)done * kChannels];
		if (gBlockLap[block] == lap) {
			memcpy(dst, &gRing[(size_t)idx * kChannels], (size_t)run * kChannels * sizeof(Float32));
		} else {
			memset(dst, 0, (size_t)run * kChannels * sizeof(Float32));
		}
		t += run;
		done += run;
	}
}

static OSStatus RemoteVisio_DoIOOperation(AudioServerPlugInDriverRef inDriver, AudioObjectID inDeviceObjectID, AudioObjectID inStreamObjectID,
                                       UInt32 inClientID, UInt32 inOperationID, UInt32 inIOBufferFrameSize,
                                       const AudioServerPlugInIOCycleInfo* inIOCycleInfo, void* ioMainBuffer, void* ioSecondaryBuffer) {
	(void)inClientID; (void)ioSecondaryBuffer;
	if (inDriver != gDriverRef) return kAudioHardwareBadObjectError;
	if (inDeviceObjectID != kObjectID_Device) return kAudioHardwareBadObjectError;
	if (inIOCycleInfo == NULL || ioMainBuffer == NULL) return kAudioHardwareIllegalOperationError;
	// A cycle can never legitimately exceed the ring; refuse rather than wrap onto itself.
	if (inIOBufferFrameSize == 0 || inIOBufferFrameSize > kRingFrames / 2) return kAudioHardwareIllegalOperationError;
	SInt64 t;
	switch (inOperationID) {
	case kAudioServerPlugInIOOperationWriteMix:
		if (inStreamObjectID != kObjectID_StreamOutput) return kAudioHardwareBadStreamError;
		if (!SampleTime(inIOCycleInfo->mOutputTime.mSampleTime, &t)) return kAudioHardwareIllegalOperationError;
		os_unfair_lock_lock(&gRingLock);
		RingMix(t, (const Float32*)ioMainBuffer, inIOBufferFrameSize);
		os_unfair_lock_unlock(&gRingLock);
		return kAudioHardwareNoError;
	case kAudioServerPlugInIOOperationReadInput:
		if (inStreamObjectID != kObjectID_StreamInput) return kAudioHardwareBadStreamError;
		if (!SampleTime(inIOCycleInfo->mInputTime.mSampleTime, &t)) return kAudioHardwareIllegalOperationError;
		os_unfair_lock_lock(&gRingLock);
		RingRead(t, (Float32*)ioMainBuffer, inIOBufferFrameSize);
		os_unfair_lock_unlock(&gRingLock);
		return kAudioHardwareNoError;
	default:
		return kAudioHardwareNoError; // we said we wouldn't do these; be lenient if asked anyway
	}
}

#pragma mark Interface table and factory

static AudioServerPlugInDriverInterface gInterface = {
	NULL,
	RemoteVisio_QueryInterface,
	RemoteVisio_AddRef,
	RemoteVisio_Release,
	RemoteVisio_Initialize,
	RemoteVisio_CreateDevice,
	RemoteVisio_DestroyDevice,
	RemoteVisio_AddDeviceClient,
	RemoteVisio_RemoveDeviceClient,
	RemoteVisio_PerformDeviceConfigurationChange,
	RemoteVisio_AbortDeviceConfigurationChange,
	RemoteVisio_HasProperty,
	RemoteVisio_IsPropertySettable,
	RemoteVisio_GetPropertyDataSize,
	RemoteVisio_GetPropertyData,
	RemoteVisio_SetPropertyData,
	RemoteVisio_StartIO,
	RemoteVisio_StopIO,
	RemoteVisio_GetZeroTimeStamp,
	RemoteVisio_WillDoIOOperation,
	RemoteVisio_BeginIOOperation,
	RemoteVisio_DoIOOperation,
	RemoteVisio_EndIOOperation,
};

// The CFPlugIn factory named in Info.plist. coreaudiod asks for the
// AudioServerPlugIn type; anything else gets NULL.
__attribute__((visibility("default")))
void* RemoteVisio_Create(CFAllocatorRef inAllocator, CFUUIDRef inRequestedTypeUUID) {
	(void)inAllocator;
	if (inRequestedTypeUUID == NULL || !CFEqual(inRequestedTypeUUID, kAudioServerPlugInTypeUUID)) return NULL;
	pthread_mutex_lock(&gStateMutex);
	gRefCount++;
	pthread_mutex_unlock(&gStateMutex);
	return gDriverRef;
}

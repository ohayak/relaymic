// harness.c — exercises the Remote Visio HAL plug-in in-process, without coreaudiod.
//
// Loads the built bundle's executable with dlopen, calls the CFPlugIn factory
// the way coreaudiod would, then drives the driver interface directly: a
// stub host, every property on every object, IO start/stop, the device
// clock, and the loopback ring (write, read back, mixing of two clients,
// wrap-around, stale-lap silence, negative times, oversized cycles).
//
// Anything that would crash coreaudiod crashes this program instead, which
// is the point. Run via `make test-driver`.
#include <CoreAudio/AudioHardware.h>
#include <CoreAudio/AudioServerPlugIn.h>
#include <dlfcn.h>
#include <mach/mach_time.h>
#include <math.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int gFails = 0;
static int gChecks = 0;
#define CHECK(cond, ...) do { gChecks++; if (!(cond)) { gFails++; printf("FAIL line %d: ", __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

enum { kPlugIn = 1, kDevice = 2, kStreamOut = 3, kStreamIn = 4 };
#define RING_FRAMES 65536
#define CH 2

#pragma mark Stub host

static int gNotifications = 0;
static OSStatus HostPropertiesChanged(AudioServerPlugInHostRef h, AudioObjectID id, UInt32 n, const AudioObjectPropertyAddress* a) {
	(void)h; (void)a;
	CHECK(id == kDevice, "notification for unexpected object %u", id);
	CHECK(n == 1, "notification with %u addresses", n);
	gNotifications++;
	return 0;
}
static OSStatus HostCopyFromStorage(AudioServerPlugInHostRef h, CFStringRef key, CFPropertyListRef* out) {
	(void)h; (void)key; *out = NULL; return kAudioHardwareUnknownPropertyError;
}
static OSStatus HostWriteToStorage(AudioServerPlugInHostRef h, CFStringRef key, CFPropertyListRef data) { (void)h; (void)key; (void)data; return 0; }
static OSStatus HostDeleteFromStorage(AudioServerPlugInHostRef h, CFStringRef key) { (void)h; (void)key; return 0; }
static OSStatus HostRequestDeviceConfigurationChange(AudioServerPlugInHostRef h, AudioObjectID dev, UInt64 action, void* info) {
	(void)h; (void)dev; (void)action; (void)info; return 0;
}
static AudioServerPlugInHostInterface gHost = {
	HostPropertiesChanged, HostCopyFromStorage, HostWriteToStorage, HostDeleteFromStorage, HostRequestDeviceConfigurationChange,
};

#pragma mark Helpers

typedef void* (*FactoryFn)(CFAllocatorRef, CFUUIDRef);
static AudioServerPlugInDriverRef D;
#define I (*D)

static AudioObjectPropertyAddress Addr(AudioObjectPropertySelector sel, AudioObjectPropertyScope scope) {
	AudioObjectPropertyAddress a = { sel, scope, kAudioObjectPropertyElementMain };
	return a;
}

static UInt32 GetU32(AudioObjectID obj, AudioObjectPropertySelector sel, AudioObjectPropertyScope scope) {
	AudioObjectPropertyAddress a = Addr(sel, scope);
	UInt32 v = 0xDEADBEEF, size = 0;
	OSStatus st = I->GetPropertyData(D, obj, 0, &a, 0, NULL, sizeof(v), &size, &v);
	CHECK(st == 0, "GetPropertyData(%u, '%c%c%c%c') = %d", obj, (char)(sel >> 24), (char)(sel >> 16), (char)(sel >> 8), (char)sel, (int)st);
	CHECK(size == sizeof(v), "size %u", size);
	return v;
}

static char* GetStr(AudioObjectID obj, AudioObjectPropertySelector sel) {
	AudioObjectPropertyAddress a = Addr(sel, kAudioObjectPropertyScopeGlobal);
	CFStringRef s = NULL; UInt32 size = 0;
	OSStatus st = I->GetPropertyData(D, obj, 0, &a, 0, NULL, sizeof(s), &size, &s);
	CHECK(st == 0 && s != NULL, "string property %d", (int)st);
	static char buf[256];
	buf[0] = 0;
	if (s) { CFStringGetCString(s, buf, sizeof(buf), kCFStringEncodingUTF8); CFRelease(s); }
	return buf;
}

static UInt32 GetList(AudioObjectID obj, AudioObjectPropertySelector sel, AudioObjectPropertyScope scope, AudioObjectID out[8]) {
	AudioObjectPropertyAddress a = Addr(sel, scope);
	UInt32 size = 0;
	OSStatus st = I->GetPropertyDataSize(D, obj, 0, &a, 0, NULL, &size);
	CHECK(st == 0, "GetPropertyDataSize list %d", (int)st);
	UInt32 got = 0;
	st = I->GetPropertyData(D, obj, 0, &a, 0, NULL, 8 * sizeof(AudioObjectID), &got, out);
	CHECK(st == 0, "GetPropertyData list %d", (int)st);
	CHECK(got == size, "list size mismatch: size says %u, data gave %u", size, got);
	return got / sizeof(AudioObjectID);
}

static AudioServerPlugInIOCycleInfo Cycle(Float64 outT, Float64 inT) {
	AudioServerPlugInIOCycleInfo c;
	memset(&c, 0, sizeof(c));
	c.mNominalIOBufferFrameSize = 512;
	c.mOutputTime.mSampleTime = outT;
	c.mInputTime.mSampleTime = inT;
	c.mCurrentTime.mSampleTime = (outT + inT) / 2;
	return c;
}

static OSStatus Write(UInt32 client, Float64 t, const Float32* data, UInt32 frames) {
	AudioServerPlugInIOCycleInfo c = Cycle(t, t - 1024);
	Float32* buf = malloc(frames * CH * sizeof(Float32));
	memcpy(buf, data, frames * CH * sizeof(Float32));
	OSStatus st = I->DoIOOperation(D, kDevice, kStreamOut, client, kAudioServerPlugInIOOperationWriteMix, frames, &c, buf, NULL);
	free(buf);
	return st;
}

static OSStatus Read(UInt32 client, Float64 t, Float32* out, UInt32 frames) {
	AudioServerPlugInIOCycleInfo c = Cycle(t + 1024, t);
	memset(out, 0x7f, frames * CH * sizeof(Float32)); // poison so silence must be written explicitly
	return I->DoIOOperation(D, kDevice, kStreamIn, client, kAudioServerPlugInIOOperationReadInput, frames, &c, out, NULL);
}

static void Ramp(Float32* buf, UInt32 frames, Float32 base) {
	for (UInt32 i = 0; i < frames; i++) { buf[i * CH] = base + (Float32)i; buf[i * CH + 1] = -(base + (Float32)i); }
}

static int Equal(const Float32* a, const Float32* b, UInt32 frames) {
	for (UInt32 i = 0; i < frames * CH; i++) if (fabsf(a[i] - b[i]) > 1e-4f) return 0;
	return 1;
}

static int Silent(const Float32* a, UInt32 frames) {
	for (UInt32 i = 0; i < frames * CH; i++) if (a[i] != 0.0f) return 0;
	return 1;
}

#pragma mark Tests

static void TestFactory(const char* path) {
	void* h = dlopen(path, RTLD_NOW | RTLD_LOCAL);
	if (!h) { printf("dlopen: %s\n", dlerror()); exit(2); }
	FactoryFn create = (FactoryFn)dlsym(h, "RemoteVisio_Create");
	if (!create) { printf("dlsym: %s\n", dlerror()); exit(2); }

	CFUUIDRef other = CFUUIDCreateFromString(NULL, CFSTR("00000000-0000-0000-0000-000000000000"));
	CHECK(create(NULL, other) == NULL, "factory produced something for a foreign type");
	CFRelease(other);
	CHECK(create(NULL, NULL) == NULL, "factory produced something for a NULL type");

	D = (AudioServerPlugInDriverRef)create(NULL, kAudioServerPlugInTypeUUID);
	CHECK(D != NULL && *D != NULL, "factory returned no driver");

	// IUnknown
	void* iface = NULL;
	CFUUIDBytes bytes = CFUUIDGetUUIDBytes(kAudioServerPlugInDriverInterfaceUUID);
	CHECK(I->QueryInterface(D, bytes, &iface) == S_OK && iface == D, "QueryInterface for the driver interface");
	CFUUIDRef bogus = CFUUIDCreateFromString(NULL, CFSTR("12345678-1234-1234-1234-123456789ABC"));
	CHECK(I->QueryInterface(D, CFUUIDGetUUIDBytes(bogus), &iface) == E_NOINTERFACE, "QueryInterface accepted a bogus UUID");
	CFRelease(bogus);
	ULONG n1 = I->AddRef(D), n2 = I->Release(D);
	CHECK(n1 == n2 + 1, "AddRef/Release accounting %lu %lu", n1, n2);
	CHECK(I->Initialize(D, &gHost) == 0, "Initialize failed");
}

static void TestTopology(void) {
	AudioObjectID ids[8];
	CHECK(GetList(kPlugIn, kAudioPlugInPropertyDeviceList, kAudioObjectPropertyScopeGlobal, ids) == 1 && ids[0] == kDevice, "device list");
	CHECK(GetList(kPlugIn, kAudioObjectPropertyOwnedObjects, kAudioObjectPropertyScopeGlobal, ids) == 1 && ids[0] == kDevice, "plug-in owned objects");
	CHECK(GetU32(kPlugIn, kAudioObjectPropertyClass, kAudioObjectPropertyScopeGlobal) == kAudioPlugInClassID, "plug-in class");
	CHECK(GetU32(kPlugIn, kAudioObjectPropertyOwner, kAudioObjectPropertyScopeGlobal) == kAudioObjectUnknown, "plug-in owner");

	// UID translation with a qualifier
	AudioObjectPropertyAddress a = Addr(kAudioPlugInPropertyTranslateUIDToDevice, kAudioObjectPropertyScopeGlobal);
	CFStringRef uid = CFSTR("RemoteVisio:Device");
	AudioObjectID found = 0; UInt32 size = 0;
	CHECK(I->GetPropertyData(D, kPlugIn, 0, &a, sizeof(uid), &uid, sizeof(found), &size, &found) == 0 && found == kDevice, "translate UID → device");
	CFStringRef wrong = CFSTR("Nope");
	CHECK(I->GetPropertyData(D, kPlugIn, 0, &a, sizeof(wrong), &wrong, sizeof(found), &size, &found) == 0 && found == kAudioObjectUnknown, "translate unknown UID");

	CHECK(strcmp(GetStr(kDevice, kAudioObjectPropertyName), "Remote Visio") == 0, "device name");
	CHECK(strcmp(GetStr(kDevice, kAudioDevicePropertyDeviceUID), "RemoteVisio:Device") == 0, "device UID");
	CHECK(strcmp(GetStr(kDevice, kAudioObjectPropertyManufacturer), "Remote Visio") == 0, "manufacturer");
	CHECK(GetU32(kDevice, kAudioObjectPropertyClass, kAudioObjectPropertyScopeGlobal) == kAudioDeviceClassID, "device class");
	CHECK(GetU32(kDevice, kAudioObjectPropertyOwner, kAudioObjectPropertyScopeGlobal) == kPlugIn, "device owner");
	CHECK(GetU32(kDevice, kAudioDevicePropertyTransportType, kAudioObjectPropertyScopeGlobal) == kAudioDeviceTransportTypeVirtual, "transport");
	CHECK(GetU32(kDevice, kAudioDevicePropertyDeviceIsAlive, kAudioObjectPropertyScopeGlobal) == 1, "alive");
	CHECK(GetU32(kDevice, kAudioDevicePropertyDeviceIsRunning, kAudioObjectPropertyScopeGlobal) == 0, "running before StartIO");
	CHECK(GetU32(kDevice, kAudioDevicePropertyDeviceCanBeDefaultDevice, kAudioObjectPropertyScopeInput) == 1, "can be default input");
	CHECK(GetU32(kDevice, kAudioDevicePropertyDeviceCanBeDefaultDevice, kAudioObjectPropertyScopeOutput) == 0, "must not be default output");
	CHECK(GetU32(kDevice, kAudioDevicePropertyDeviceCanBeDefaultSystemDevice, kAudioObjectPropertyScopeOutput) == 0, "must not be system output");
	CHECK(GetU32(kDevice, kAudioDevicePropertyIsHidden, kAudioObjectPropertyScopeGlobal) == 0, "hidden");
	CHECK(GetU32(kDevice, kAudioDevicePropertyZeroTimeStampPeriod, kAudioObjectPropertyScopeGlobal) == 16384, "zts period");

	CHECK(GetList(kDevice, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeGlobal, ids) == 2, "streams global");
	CHECK(GetList(kDevice, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeInput, ids) == 1 && ids[0] == kStreamIn, "streams input");
	CHECK(GetList(kDevice, kAudioDevicePropertyStreams, kAudioObjectPropertyScopeOutput, ids) == 1 && ids[0] == kStreamOut, "streams output");
	CHECK(GetList(kDevice, kAudioObjectPropertyOwnedObjects, kAudioObjectPropertyScopeGlobal, ids) == 2, "device owned objects");
	CHECK(GetList(kDevice, kAudioDevicePropertyRelatedDevices, kAudioObjectPropertyScopeGlobal, ids) == 1 && ids[0] == kDevice, "related devices");
	CHECK(GetList(kDevice, kAudioObjectPropertyControlList, kAudioObjectPropertyScopeGlobal, ids) == 0, "no controls");

	// Owned objects with a class qualifier that excludes streams → empty; the
	// qualifier is an array, and the wildcard class matches everything.
	a = Addr(kAudioObjectPropertyOwnedObjects, kAudioObjectPropertyScopeGlobal);
	AudioClassID want = kAudioControlClassID;
	CHECK(I->GetPropertyDataSize(D, kDevice, 0, &a, sizeof(want), &want, &size) == 0 && size == 0, "qualifier filters owned objects");
	AudioClassID many[2] = { kAudioControlClassID, kAudioStreamClassID };
	CHECK(I->GetPropertyDataSize(D, kDevice, 0, &a, sizeof(many), many, &size) == 0 && size == 2 * sizeof(AudioObjectID), "multi-class qualifier ignored past the first entry");
	AudioClassID wild = kAudioObjectClassIDWildcard;
	CHECK(I->GetPropertyDataSize(D, kDevice, 0, &a, sizeof(wild), &wild, &size) == 0 && size == 2 * sizeof(AudioObjectID), "wildcard qualifier not honoured");
	CHECK(I->GetPropertyDataSize(D, kPlugIn, 0, &a, sizeof(wild), &wild, &size) == 0 && size == sizeof(AudioObjectID), "wildcard qualifier on the plug-in");

	// Sample rate
	a = Addr(kAudioDevicePropertyNominalSampleRate, kAudioObjectPropertyScopeGlobal);
	Float64 rate = 0;
	CHECK(I->GetPropertyData(D, kDevice, 0, &a, 0, NULL, sizeof(rate), &size, &rate) == 0 && rate == 48000.0, "nominal rate");
	Boolean settable = false;
	CHECK(I->IsPropertySettable(D, kDevice, 0, &a, &settable) == 0 && settable, "rate settable");
	CHECK(I->SetPropertyData(D, kDevice, 0, &a, 0, NULL, sizeof(rate), &rate) == 0, "set rate 48000");
	rate = 44100;
	CHECK(I->SetPropertyData(D, kDevice, 0, &a, 0, NULL, sizeof(rate), &rate) != 0, "set rate 44100 must fail");
	a = Addr(kAudioDevicePropertyAvailableNominalSampleRates, kAudioObjectPropertyScopeGlobal);
	AudioValueRange ranges[4];
	CHECK(I->GetPropertyData(D, kDevice, 0, &a, 0, NULL, sizeof(ranges), &size, ranges) == 0 && size == sizeof(AudioValueRange)
		&& ranges[0].mMinimum == 48000 && ranges[0].mMaximum == 48000, "available rates");

	// Channel layout
	a = Addr(kAudioDevicePropertyPreferredChannelLayout, kAudioObjectPropertyScopeInput);
	char layoutBuf[256];
	CHECK(I->GetPropertyData(D, kDevice, 0, &a, 0, NULL, sizeof(layoutBuf), &size, layoutBuf) == 0, "channel layout");
	AudioChannelLayout* l = (AudioChannelLayout*)layoutBuf;
	CHECK(l->mNumberChannelDescriptions == 2 && l->mChannelDescriptions[1].mChannelLabel == kAudioChannelLabel_Right, "layout content");
	a = Addr(kAudioDevicePropertyPreferredChannelLayout, kAudioObjectPropertyScopeGlobal);
	CHECK(!I->HasProperty(D, kDevice, 0, &a), "layout has no global scope");

	// Streams
	CHECK(GetU32(kStreamOut, kAudioStreamPropertyDirection, kAudioObjectPropertyScopeGlobal) == 0, "output direction");
	CHECK(GetU32(kStreamIn, kAudioStreamPropertyDirection, kAudioObjectPropertyScopeGlobal) == 1, "input direction");
	CHECK(GetU32(kStreamIn, kAudioObjectPropertyOwner, kAudioObjectPropertyScopeGlobal) == kDevice, "stream owner");
	CHECK(GetU32(kStreamIn, kAudioStreamPropertyTerminalType, kAudioObjectPropertyScopeGlobal) == kAudioStreamTerminalTypeMicrophone, "input terminal");
	CHECK(GetU32(kStreamIn, kAudioStreamPropertyStartingChannel, kAudioObjectPropertyScopeGlobal) == 1, "starting channel");
	a = Addr(kAudioStreamPropertyPhysicalFormat, kAudioObjectPropertyScopeGlobal);
	AudioStreamBasicDescription f;
	CHECK(I->GetPropertyData(D, kStreamIn, 0, &a, 0, NULL, sizeof(f), &size, &f) == 0, "physical format");
	CHECK(f.mSampleRate == 48000 && f.mChannelsPerFrame == 2 && f.mBitsPerChannel == 32 && f.mBytesPerFrame == 8
		&& (f.mFormatFlags & kAudioFormatFlagIsFloat) && f.mFormatID == kAudioFormatLinearPCM, "format fields");
	CHECK(I->SetPropertyData(D, kStreamIn, 0, &a, 0, NULL, sizeof(f), &f) == 0, "set identical format");
	f.mSampleRate = 44100;
	CHECK(I->SetPropertyData(D, kStreamIn, 0, &a, 0, NULL, sizeof(f), &f) != 0, "set other rate must fail");
	a = Addr(kAudioStreamPropertyIsActive, kAudioObjectPropertyScopeGlobal);
	CHECK(I->IsPropertySettable(D, kStreamIn, 0, &a, &settable) == 0 && !settable, "IsActive must not claim to be settable");
	UInt32 zero = 0;
	CHECK(I->SetPropertyData(D, kStreamIn, 0, &a, 0, NULL, sizeof(zero), &zero) != 0, "IsActive set must be refused");
	a = Addr(kAudioStreamPropertyAvailablePhysicalFormats, kAudioObjectPropertyScopeGlobal);
	AudioStreamRangedDescription rd[4];
	CHECK(I->GetPropertyData(D, kStreamOut, 0, &a, 0, NULL, sizeof(rd), &size, rd) == 0 && size == sizeof(rd[0])
		&& rd[0].mFormat.mSampleRate == 48000 && rd[0].mSampleRateRange.mMaximum == 48000, "available formats");

	// Undersized buffers are refused, not overrun.
	a = Addr(kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal);
	char tiny[2];
	CHECK(I->GetPropertyData(D, kDevice, 0, &a, 0, NULL, sizeof(tiny), &size, tiny) == kAudioHardwareBadPropertySizeError, "tiny buffer for string");
	a = Addr(kAudioStreamPropertyPhysicalFormat, kAudioObjectPropertyScopeGlobal);
	CHECK(I->GetPropertyData(D, kStreamIn, 0, &a, 0, NULL, 4, &size, tiny) == kAudioHardwareBadPropertySizeError, "tiny buffer for format");

	// Unknown things
	a = Addr('zzzz', kAudioObjectPropertyScopeGlobal);
	CHECK(!I->HasProperty(D, kDevice, 0, &a), "unknown selector reported as present");
	CHECK(I->GetPropertyDataSize(D, kDevice, 0, &a, 0, NULL, &size) == kAudioHardwareUnknownPropertyError, "unknown selector size");
	CHECK(I->GetPropertyData(D, kDevice, 0, &a, 0, NULL, 64, &size, layoutBuf) == kAudioHardwareUnknownPropertyError, "unknown selector data");
	CHECK(I->SetPropertyData(D, kDevice, 0, &a, 0, NULL, 4, tiny) == kAudioHardwareUnknownPropertyError, "unknown selector set");
	a = Addr(kAudioObjectPropertyName, kAudioObjectPropertyScopeGlobal);
	CHECK(!I->HasProperty(D, 99, 0, &a), "bogus object has properties");
	CHECK(I->GetPropertyDataSize(D, 99, 0, &a, 0, NULL, &size) == kAudioHardwareBadObjectError, "bogus object size");
	CHECK(I->GetPropertyData(D, 99, 0, &a, 0, NULL, 64, &size, layoutBuf) == kAudioHardwareBadObjectError, "bogus object data");
	CHECK(I->IsPropertySettable(D, 99, 0, &a, &settable) == kAudioHardwareBadObjectError, "bogus object settable");
	CHECK(I->StartIO(D, 99, 1) == kAudioHardwareBadObjectError, "StartIO on bogus object");
	CHECK(I->AddDeviceClient(D, kDevice, NULL) == 0, "AddDeviceClient");
	CHECK(I->RemoveDeviceClient(D, kDevice, NULL) == 0, "RemoveDeviceClient");
	CHECK(I->CreateDevice(D, NULL, NULL, ids) == kAudioHardwareUnsupportedOperationError, "CreateDevice");
}

// Every selector we can think of, on every object, in every scope: HasProperty,
// GetPropertyDataSize and GetPropertyData must agree on what exists and on how
// big it is, and nothing may crash.
static void TestPropertyWalk(void) {
	static const AudioObjectPropertySelector sels[] = {
		kAudioObjectPropertyBaseClass, kAudioObjectPropertyClass, kAudioObjectPropertyOwner, kAudioObjectPropertyName,
		kAudioObjectPropertyModelName, kAudioObjectPropertyManufacturer, kAudioObjectPropertyElementName,
		kAudioObjectPropertyElementCategoryName, kAudioObjectPropertyElementNumberName, kAudioObjectPropertyOwnedObjects,
		kAudioObjectPropertyIdentify, kAudioObjectPropertySerialNumber, kAudioObjectPropertyFirmwareVersion,
		kAudioObjectPropertyControlList, kAudioObjectPropertyCustomPropertyInfoList,
		kAudioPlugInPropertyBundleID, kAudioPlugInPropertyDeviceList, kAudioPlugInPropertyTranslateUIDToDevice,
		kAudioPlugInPropertyBoxList, kAudioPlugInPropertyTranslateUIDToBox, kAudioPlugInPropertyClockDeviceList,
		kAudioPlugInPropertyTranslateUIDToClockDevice, kAudioPlugInPropertyResourceBundle,
		kAudioDevicePropertyConfigurationApplication, kAudioDevicePropertyDeviceUID, kAudioDevicePropertyModelUID,
		kAudioDevicePropertyTransportType, kAudioDevicePropertyRelatedDevices, kAudioDevicePropertyClockDomain,
		kAudioDevicePropertyDeviceIsAlive, kAudioDevicePropertyDeviceIsRunning, kAudioDevicePropertyDeviceCanBeDefaultDevice,
		kAudioDevicePropertyDeviceCanBeDefaultSystemDevice, kAudioDevicePropertyLatency, kAudioDevicePropertyStreams,
		kAudioDevicePropertySafetyOffset, kAudioDevicePropertyNominalSampleRate, kAudioDevicePropertyAvailableNominalSampleRates,
		kAudioDevicePropertyIcon, kAudioDevicePropertyIsHidden, kAudioDevicePropertyPreferredChannelsForStereo,
		kAudioDevicePropertyPreferredChannelLayout, kAudioDevicePropertyZeroTimeStampPeriod, kAudioDevicePropertyClockAlgorithm,
		kAudioDevicePropertyClockIsStable, kAudioDevicePropertyBufferFrameSize, kAudioDevicePropertyUsesVariableBufferFrameSizes,
		kAudioDevicePropertyIOCycleUsage, kAudioDevicePropertyStreamConfiguration, kAudioDevicePropertyIOProcStreamUsage,
		kAudioDevicePropertyActualSampleRate, kAudioDevicePropertyClockDevice, kAudioDevicePropertyVolumeScalar,
		kAudioDevicePropertyMute, kAudioDevicePropertyDataSource, kAudioDevicePropertyDeviceIsRunningSomewhere,
		kAudioStreamPropertyIsActive, kAudioStreamPropertyDirection, kAudioStreamPropertyTerminalType,
		kAudioStreamPropertyStartingChannel, kAudioStreamPropertyLatency, kAudioStreamPropertyVirtualFormat,
		kAudioStreamPropertyAvailableVirtualFormats, kAudioStreamPropertyPhysicalFormat, kAudioStreamPropertyAvailablePhysicalFormats,
		'zzzz', 0,
	};
	static const AudioObjectPropertyScope scopes[] = {
		kAudioObjectPropertyScopeGlobal, kAudioObjectPropertyScopeInput, kAudioObjectPropertyScopeOutput, kAudioObjectPropertyScopePlayThrough,
	};
	static const AudioObjectID objs[] = { kPlugIn, kDevice, kStreamOut, kStreamIn, 0, 5, 99, 0xFFFFFFFF };
	char buf[4096];
	int has = 0;
	for (size_t o = 0; o < sizeof(objs) / sizeof(objs[0]); o++) {
		for (size_t s = 0; s < sizeof(sels) / sizeof(sels[0]); s++) {
			for (size_t c = 0; c < sizeof(scopes) / sizeof(scopes[0]); c++) {
				for (UInt32 el = 0; el < 3; el += 2) { // main element and a bogus one
					AudioObjectPropertyAddress a = { sels[s], scopes[c], el };
					Boolean h = I->HasProperty(D, objs[o], 0, &a);
					UInt32 size = 0xFFFFFFFF, got = 0xFFFFFFFF, got0 = 0;
					OSStatus st1 = I->GetPropertyDataSize(D, objs[o], 0, &a, 0, NULL, &size);
					OSStatus st2 = I->GetPropertyData(D, objs[o], 0, &a, 0, NULL, sizeof(buf), &got, buf);
					OSStatus st0 = I->GetPropertyData(D, objs[o], 0, &a, 0, NULL, 0, &got0, NULL);
					(void)st0; // zero-size query must simply not crash
					CHECK(h == (st1 == 0) && h == (st2 == 0), "presence disagrees (has %d, size %d, get %d): obj %u sel '%c%c%c%c' scope '%c%c%c%c' el %u",
						h, (int)st1, (int)st2, objs[o], (char)(sels[s] >> 24), (char)(sels[s] >> 16), (char)(sels[s] >> 8), (char)sels[s],
						(char)(scopes[c] >> 24), (char)(scopes[c] >> 16), (char)(scopes[c] >> 8), (char)scopes[c], el);
					if (!h) continue;
					has++;
					CHECK(got == size, "size %u vs data %u for obj %u sel '%c%c%c%c'", size, got, objs[o],
						(char)(sels[s] >> 24), (char)(sels[s] >> 16), (char)(sels[s] >> 8), (char)sels[s]);
					// Strings were retained for us; release to keep the run leak-free.
					if (got == sizeof(CFStringRef) && (sels[s] == kAudioObjectPropertyName || sels[s] == kAudioObjectPropertyManufacturer
						|| sels[s] == kAudioDevicePropertyDeviceUID || sels[s] == kAudioDevicePropertyModelUID
						|| sels[s] == kAudioPlugInPropertyResourceBundle)) {
						CFRelease(*(CFStringRef*)buf);
					}
				}
			}
		}
	}
	CHECK(has > 60, "property walk found only %d properties", has);
	printf("property walk: %d present\n", has);
}

static void TestClockAndIO(void) {
	Boolean willDo = false, inPlace = false;
	CHECK(I->WillDoIOOperation(D, kDevice, 1, kAudioServerPlugInIOOperationReadInput, &willDo, &inPlace) == 0 && willDo && inPlace, "will read input");
	CHECK(I->WillDoIOOperation(D, kDevice, 1, kAudioServerPlugInIOOperationWriteMix, &willDo, &inPlace) == 0 && willDo && inPlace, "will write mix");
	CHECK(I->WillDoIOOperation(D, kDevice, 1, kAudioServerPlugInIOOperationProcessMix, &willDo, &inPlace) == 0 && !willDo, "won't process mix");

	int before = gNotifications;
	CHECK(I->StartIO(D, kDevice, 1) == 0, "StartIO");
	CHECK(gNotifications == before + 1, "running notification on first start");
	CHECK(GetU32(kDevice, kAudioDevicePropertyDeviceIsRunning, kAudioObjectPropertyScopeGlobal) == 1, "running after StartIO");
	CHECK(I->StartIO(D, kDevice, 2) == 0, "second client StartIO");
	CHECK(gNotifications == before + 1, "no notification on second start");

	Float64 st1, st2; UInt64 ht1, ht2, seed1, seed2;
	CHECK(I->GetZeroTimeStamp(D, kDevice, 1, &st1, &ht1, &seed1) == 0, "zero time stamp");
	usleep(400 * 1000); // > one period of 16384 frames at 48 kHz (341 ms)
	CHECK(I->GetZeroTimeStamp(D, kDevice, 1, &st2, &ht2, &seed2) == 0, "zero time stamp 2");
	CHECK(st2 > st1, "sample time did not advance (%f → %f)", st1, st2);
	CHECK(fmod(st2, 16384.0) == 0, "sample time not on a period boundary: %f", st2);
	CHECK(ht2 > ht1, "host time did not advance");
	CHECK(seed1 == seed2, "seed changed within a run");
	CHECK(ht2 <= (UInt64)mach_absolute_time(), "zero time stamp in the future");

	AudioServerPlugInIOCycleInfo c = Cycle(1000, 0);
	CHECK(I->BeginIOOperation(D, kDevice, 1, kAudioServerPlugInIOOperationWriteMix, 512, &c) == 0, "BeginIOOperation");
	CHECK(I->EndIOOperation(D, kDevice, 1, kAudioServerPlugInIOOperationWriteMix, 512, &c) == 0, "EndIOOperation");

	// Wrong stream for the operation, and oversized cycles, are refused.
	Float32 junk[8] = {0};
	CHECK(I->DoIOOperation(D, kDevice, kStreamIn, 1, kAudioServerPlugInIOOperationWriteMix, 4, &c, junk, NULL) == kAudioHardwareBadStreamError, "write into the input stream");
	CHECK(I->DoIOOperation(D, kDevice, kStreamOut, 1, kAudioServerPlugInIOOperationReadInput, 4, &c, junk, NULL) == kAudioHardwareBadStreamError, "read from the output stream");
	CHECK(I->DoIOOperation(D, kDevice, kStreamOut, 1, kAudioServerPlugInIOOperationWriteMix, RING_FRAMES, &c, junk, NULL) != 0, "oversized cycle accepted");
	CHECK(I->DoIOOperation(D, kDevice, kStreamOut, 1, kAudioServerPlugInIOOperationWriteMix, 0, &c, junk, NULL) != 0, "zero-frame cycle accepted");
	CHECK(I->DoIOOperation(D, kDevice, kStreamOut, 1, kAudioServerPlugInIOOperationWriteMix, 4, NULL, junk, NULL) != 0, "NULL cycle info accepted");
	CHECK(I->DoIOOperation(D, kDevice, kStreamOut, 1, kAudioServerPlugInIOOperationWriteMix, 4, &c, NULL, NULL) != 0, "NULL buffer accepted");

	const UInt32 N = 512;
	Float32 ramp[N * CH], got[N * CH], ramp2[N * CH], sum[N * CH];
	Ramp(ramp, N, 1.0f);

	// Plain loopback.
	CHECK(Write(1, 1000, ramp, N) == 0, "write");
	CHECK(Read(1, 1000, got, N) == 0, "read");
	CHECK(Equal(got, ramp, N), "loopback data mismatch");

	// Partial overlap reads see the right slice.
	CHECK(Read(1, 1100, got, 100) == 0 && Equal(got, &ramp[100 * CH], 100), "offset read");

	// Unwritten region is silence, not stale poison.
	CHECK(Read(1, 9000, got, N) == 0 && Silent(got, N), "unwritten region not silent");

	// Two clients mix.
	Ramp(ramp2, N, 100.0f);
	for (UInt32 i = 0; i < N * CH; i++) sum[i] = ramp[i] + ramp2[i];
	CHECK(Write(2, 1000, ramp2, N) == 0, "second write");
	CHECK(Read(1, 1000, got, N) == 0 && Equal(got, sum, N), "mixing two clients");

	// Two readers both get the data (reads don't consume).
	CHECK(Read(2, 1000, got, N) == 0 && Equal(got, sum, N), "second reader");

	// Wrap-around across the ring end.
	Float64 t = RING_FRAMES - 100;
	CHECK(Write(1, t, ramp, N) == 0, "wrap write");
	CHECK(Read(1, t, got, N) == 0 && Equal(got, ramp, N), "wrap read mismatch");

	// A lap later the old data must read as silence; the new lap's data must be there.
	CHECK(Write(1, 1000 + RING_FRAMES, ramp2, N) == 0, "next lap write");
	CHECK(Read(1, 1000, got, N) == 0 && Silent(got, N), "stale lap not silenced");
	CHECK(Read(1, 1000 + RING_FRAMES, got, N) == 0 && Equal(got, ramp2, N), "next lap read");
	// ...and a block that was NOT rewritten this lap is silent too.
	CHECK(Read(1, 20000 + RING_FRAMES, got, N) == 0 && Silent(got, N), "untouched block in new lap not silent");

	// Fractional and negative sample times must not crash.
	CHECK(Write(1, 3000.5, ramp, N) == 0 && Read(1, 3000.5, got, N) == 0, "fractional time");
	CHECK(Write(1, -100, ramp, N) == 0, "negative write");
	CHECK(Read(1, -100, got, N) == 0, "negative read");
	CHECK(Read(1, -RING_FRAMES * 3.0, got, N) == 0, "very negative read");

	// Non-finite or absurd sample times are a host bug and must be refused, not cast.
	CHECK(Write(1, NAN, ramp, N) != 0, "NaN sample time accepted");
	CHECK(Read(1, INFINITY, got, N) != 0, "Inf sample time accepted");
	CHECK(Write(1, 1e300, ramp, N) != 0, "huge sample time accepted");
	CHECK(Read(1, -1e300, got, N) != 0, "huge negative sample time accepted");

	// Stop: last client out flips running and notifies once.
	before = gNotifications;
	CHECK(I->StopIO(D, kDevice, 1) == 0, "StopIO");
	CHECK(gNotifications == before, "notified while a client still runs");
	CHECK(I->StopIO(D, kDevice, 2) == 0, "StopIO 2");
	CHECK(gNotifications == before + 1, "no notification on last stop");
	CHECK(GetU32(kDevice, kAudioDevicePropertyDeviceIsRunning, kAudioObjectPropertyScopeGlobal) == 0, "running after StopIO");
	CHECK(I->StopIO(D, kDevice, 3) == 0, "extra StopIO must not underflow");
	CHECK(GetU32(kDevice, kAudioDevicePropertyDeviceIsRunning, kAudioObjectPropertyScopeGlobal) == 0, "underflow made it 'running'");

	// Restart: new seed, clean ring.
	CHECK(I->StartIO(D, kDevice, 1) == 0, "restart");
	UInt64 seed3; Float64 st3; UInt64 ht3;
	CHECK(I->GetZeroTimeStamp(D, kDevice, 1, &st3, &ht3, &seed3) == 0 && seed3 != seed1, "seed unchanged after restart");
	CHECK(Read(1, 1000 + RING_FRAMES, got, N) == 0 && Silent(got, N), "ring not cleared on restart");
	CHECK(I->StopIO(D, kDevice, 1) == 0, "final stop");
}

// coreaudiod runs one IO thread per client. Two writers hammering overlapping
// regions from two threads must produce exact sums: every lost update or
// double-clear shows up as a wrong count.
#define CW_BASE 30000.0
#define CW_ROUNDS 2000
static void* WriterThread(void* arg) {
	UInt32 client = (UInt32)(uintptr_t)arg;
	Float32 ones[512 * CH];
	for (UInt32 i = 0; i < 512 * CH; i++) ones[i] = 1.0f;
	for (int n = 0; n < CW_ROUNDS; n++) {
		Write(client, CW_BASE + (n % 4) * 128, ones, 512); // four overlapping, misaligned regions
	}
	return NULL;
}

static void TestConcurrentWriters(void) {
	CHECK(I->StartIO(D, kDevice, 7) == 0, "StartIO for the concurrency test");
	pthread_t a, b;
	pthread_create(&a, NULL, WriterThread, (void*)1);
	pthread_create(&b, NULL, WriterThread, (void*)2);
	pthread_join(a, NULL);
	pthread_join(b, NULL);
	// Frames [384, 512) past the base are covered by all four offsets: 4 × (rounds/4) × 2 threads.
	const UInt32 M = 128;
	Float32 got[M * CH];
	CHECK(Read(1, CW_BASE + 384, got, M) == 0, "read after concurrent writes");
	Float32 expect = 4.0f * (CW_ROUNDS / 4) * 2;
	int bad = 0;
	for (UInt32 i = 0; i < M * CH; i++) if (got[i] != expect) bad++;
	CHECK(bad == 0, "concurrent writers lost updates: %d of %u samples != %.0f (first: %.0f)", bad, M * CH, expect, got[0]);
	CHECK(I->StopIO(D, kDevice, 7) == 0, "StopIO after the concurrency test");
}

int main(int argc, char** argv) {
	if (argc < 2) { printf("usage: harness <path to RemoteVisio.driver/Contents/MacOS/RemoteVisio>\n"); return 2; }
	TestFactory(argv[1]);
	TestTopology();
	TestPropertyWalk();
	TestClockAndIO();
	TestConcurrentWriters();
	printf("%d checks, %d failures\n", gChecks, gFails);
	return gFails == 0 ? 0 : 1;
}

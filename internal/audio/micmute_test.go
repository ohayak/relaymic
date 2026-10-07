package audio

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeMics stands in for Core Audio: devices with a mute switch, with
// volumes only, or with neither; and a check, on every change, that what is
// about to be lost is already on disk.
type fakeMics struct {
	t     *testing.T
	state string // the MicMuter's file, checked before each change

	mu   sync.Mutex
	devs map[string]*mic
	gone map[string]*mic // unplugged, with their settings
}

func newFakeMics(t *testing.T, state string, devs ...mic) *fakeMics {
	f := &fakeMics{t: t, state: state, devs: map[string]*mic{}, gone: map[string]*mic{}}
	for i := range devs {
		d := devs[i]
		d.Volumes = append([]micVolume(nil), d.Volumes...)
		f.devs[d.UID] = &d
	}
	return f
}

func (f *fakeMics) list() ([]mic, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []mic
	for _, d := range f.devs {
		c := *d
		c.Volumes = append([]micVolume(nil), d.Volumes...)
		out = append(out, c)
	}
	return out, nil
}

// onDisk reports whether the state file holds this device; a mute must
// never come before it.
func (f *fakeMics) onDisk(uid string) bool {
	raw, err := os.ReadFile(f.state)
	if err != nil {
		return false
	}
	var list []micSaved
	if json.Unmarshal(raw, &list) != nil {
		return false
	}
	for _, s := range list {
		if s.UID == uid {
			return true
		}
	}
	return false
}

func (f *fakeMics) setMute(uid string, on bool) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.devs[uid]
	if !ok {
		return errors.New("it is no longer connected")
	}
	if !d.HasMute {
		f.t.Errorf("setMute on %s, which has no mute switch", uid)
	}
	if on && !f.onDisk(uid) {
		f.t.Errorf("%s muted before its setting was written down", uid)
	}
	d.Muted = on
	return nil
}

func (f *fakeMics) setVolume(uid string, element uint32, v float32) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.devs[uid]
	if !ok {
		return errors.New("it is no longer connected")
	}
	if v == 0 && !f.onDisk(uid) {
		f.t.Errorf("%s turned down before its volume was written down", uid)
	}
	for i := range d.Volumes {
		if d.Volumes[i].Element == element {
			d.Volumes[i].Value = v
			return nil
		}
	}
	f.t.Errorf("setVolume on %s element %d, which it does not have", uid, element)
	return nil
}

func (f *fakeMics) get(uid string) mic {
	f.mu.Lock()
	defer f.mu.Unlock()
	d, ok := f.devs[uid]
	if !ok {
		d = f.gone[uid]
	}
	c := *d
	c.Volumes = append([]micVolume(nil), d.Volumes...) // a copy: the poller keeps writing the device's own
	return c
}

func (f *fakeMics) unplug(uid string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.gone[uid] = f.devs[uid]
	delete(f.devs, uid)
}

func (f *fakeMics) plug(d mic) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if old, ok := f.gone[d.UID]; ok {
		d = *old // a device keeps its settings while unplugged
		delete(f.gone, d.UID)
	} else {
		d.Volumes = append([]micVolume(nil), d.Volumes...) // never the shared fixture's
	}
	f.devs[d.UID] = &d
}

type logBuf struct {
	mu    sync.Mutex
	lines []string
}

func (l *logBuf) logf(format string, args ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.lines = append(l.lines, fmt.Sprintf(format, args...))
}

func (l *logBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return strings.Join(l.lines, "\n")
}

var (
	builtIn = mic{UID: "BuiltInMicrophoneDevice", Name: "MacBook Pro Microphone", HasMute: true,
		Volumes: []micVolume{{Element: 0, Value: 0.76}}}
	usbMic  = mic{UID: "usb-1", Name: "USB Mic", Volumes: []micVolume{{Element: 1, Value: 0.5}, {Element: 2, Value: 0.6}}}
	oddMic  = mic{UID: "odd", Name: "Odd Mic"}                                 // neither switch nor volume
	userOff = mic{UID: "headset", Name: "Headset", HasMute: true, Muted: true} // the user had muted it already
)

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	for end := time.Now().Add(3 * time.Second); time.Now().Before(end); time.Sleep(10 * time.Millisecond) {
		if cond() {
			return
		}
	}
	t.Fatalf("timed out waiting for %s", what)
}

func TestMuteMicsMutesAndRestores(t *testing.T) {
	state := filepath.Join(t.TempDir(), "mic-mute.json")
	f := newFakeMics(t, state, builtIn, usbMic, oddMic, userOff)
	var log logBuf
	m, err := startMics(state, f, true, log.logf)
	if err != nil {
		t.Fatal(err)
	}
	if !f.get("BuiltInMicrophoneDevice").Muted {
		t.Error("the built-in microphone has a mute switch: it must be on")
	}
	if v := f.get("BuiltInMicrophoneDevice").Volumes[0].Value; v != 0.76 {
		t.Errorf("a device with a switch keeps its volume, got %v", v)
	}
	for _, v := range f.get("usb-1").Volumes {
		if v.Value != 0 {
			t.Errorf("a device without a switch is turned down to 0, element %d is %v", v.Element, v.Value)
		}
	}
	if !strings.Contains(log.String(), "cannot mute Odd Mic: it has neither a mute switch nor a volume") {
		t.Errorf("the device that cannot be muted must be named in the log:\n%s", log.String())
	}
	if !strings.Contains(log.String(), "this Mac's microphones muted:") {
		t.Errorf("no startup line:\n%s", log.String())
	}

	m.Close()
	if f.get("BuiltInMicrophoneDevice").Muted {
		t.Error("Close must switch the built-in microphone's mute back off")
	}
	if got := f.get("usb-1").Volumes; got[0].Value != 0.5 || got[1].Value != 0.6 {
		t.Errorf("Close must put the volumes back, got %+v", got)
	}
	if !f.get("headset").Muted {
		t.Error("a microphone the user had muted stays muted")
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Errorf("nothing owed: the state file must be gone, stat says %v", err)
	}
	m.Close() // twice is fine
}

// A crash (no Close) leaves the devices muted and the file behind: the next
// start without -mic-mute puts them back.
func TestRestoreMicsAfterCrash(t *testing.T) {
	state := filepath.Join(t.TempDir(), "mic-mute.json")
	f := newFakeMics(t, state, builtIn, usbMic)
	if first, err := startMics(state, f, true, (&logBuf{}).logf); err != nil {
		t.Fatal(err)
	} else {
		crash(first)
	} // ... and the process dies here

	var log logBuf
	r, err := startMics(state, f, false, log.logf)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if f.get("BuiltInMicrophoneDevice").Muted || f.get("usb-1").Volumes[0].Value != 0.5 {
		t.Errorf("a start after a crash must put the microphones back: %+v %+v", f.get("BuiltInMicrophoneDevice"), f.get("usb-1"))
	}
	if _, err := os.Stat(state); !os.IsNotExist(err) {
		t.Errorf("the state file must be gone once all is put back, stat says %v", err)
	}
	if !strings.Contains(log.String(), "put back this Mac's microphones that an earlier run left muted") {
		t.Errorf("the restore must be logged:\n%s", log.String())
	}
}

// A crash, then a start with -mic-mute again: the settings saved first are
// what goes back, not the muted ones the devices have now.
func TestMuteAgainAfterCrashKeepsTheOriginals(t *testing.T) {
	state := filepath.Join(t.TempDir(), "mic-mute.json")
	f := newFakeMics(t, state, builtIn, usbMic)
	if first, err := startMics(state, f, true, (&logBuf{}).logf); err != nil {
		t.Fatal(err)
	} else {
		crash(first)
	}
	m, err := startMics(state, f, true, (&logBuf{}).logf)
	if err != nil {
		t.Fatal(err)
	}
	m.Close()
	if f.get("BuiltInMicrophoneDevice").Muted || f.get("usb-1").Volumes[1].Value != 0.6 {
		t.Errorf("the first run's saved settings must be what is put back: %+v %+v", f.get("BuiltInMicrophoneDevice"), f.get("usb-1"))
	}
}

// A microphone plugged in while muting is muted too, and put back on Close.
// One unplugged and plugged back is muted again.
func TestMuteMicsPluggedInLater(t *testing.T) {
	defer func(p time.Duration) { micPoll = p }(micPoll)
	micPoll = 20 * time.Millisecond
	state := filepath.Join(t.TempDir(), "mic-mute.json")
	f := newFakeMics(t, state, builtIn)
	var log logBuf
	m, err := startMics(state, f, true, log.logf)
	if err != nil {
		t.Fatal(err)
	}
	f.plug(usbMic)
	waitFor(t, "the USB microphone to be turned down", func() bool { return f.get("usb-1").Volumes[0].Value == 0 })
	if !strings.Contains(log.String(), "this Mac's microphone USB Mic muted (plugged in)") {
		t.Errorf("no line for the microphone plugged in:\n%s", log.String())
	}

	// The user unmutes the built-in one by hand: that is respected, not fought.
	if err := f.setMute("BuiltInMicrophoneDevice", false); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * micPoll)
	if f.get("BuiltInMicrophoneDevice").Muted {
		t.Error("a microphone the user unmuted by hand must not be muted again behind their back")
	}

	f.unplug("usb-1")
	time.Sleep(3 * micPoll)
	f.mu.Lock()
	f.gone["usb-1"].Volumes[0].Value = 0.9 // say the device reset itself while unplugged
	f.mu.Unlock()
	f.plug(usbMic)
	waitFor(t, "the USB microphone to be turned down again", func() bool { return f.get("usb-1").Volumes[0].Value == 0 })

	m.Close()
	if got := f.get("usb-1").Volumes; got[0].Value != 0.5 || got[1].Value != 0.6 {
		t.Errorf("the volumes saved when it was first muted go back, got %+v", got)
	}
}

// A microphone owed a restore that is not connected stays owed, and is put
// back when it comes back while the receiver runs.
func TestRestoreMicsWhenConnectedAgain(t *testing.T) {
	defer func(p time.Duration) { micPoll = p }(micPoll)
	micPoll = 20 * time.Millisecond
	state := filepath.Join(t.TempDir(), "mic-mute.json")
	f := newFakeMics(t, state, builtIn, usbMic)
	if first, err := startMics(state, f, true, (&logBuf{}).logf); err != nil {
		t.Fatal(err)
	} else {
		crash(first)
	} // crash
	f.unplug("usb-1")

	var log logBuf
	r, err := startMics(state, f, false, log.logf)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	if f.get("BuiltInMicrophoneDevice").Muted {
		t.Error("the connected microphone must be put back at once")
	}
	if !strings.Contains(readFile(t, state), "usb-1") {
		t.Error("the unplugged microphone stays owed in the state file")
	}
	f.plug(usbMic)
	waitFor(t, "the USB microphone to be put back", func() bool { return f.get("usb-1").Volumes[0].Value == 0.5 })
	waitFor(t, "the state file to go", func() bool { _, err := os.Stat(state); return os.IsNotExist(err) })
}

func TestRestoreMicsWithoutStateTouchesNothing(t *testing.T) {
	state := filepath.Join(t.TempDir(), "mic-mute.json")
	f := newFakeMics(t, state, builtIn)
	f.devs["BuiltInMicrophoneDevice"].Muted = true // the user's own choice
	r, err := startMics(state, f, false, (&logBuf{}).logf)
	if err != nil {
		t.Fatal(err)
	}
	r.Close()
	if !f.get("BuiltInMicrophoneDevice").Muted {
		t.Error("without a state file nothing is changed")
	}
}

// A state file that cannot be read is not overwritten: what it holds could
// no longer be put back.
func TestMuteMicsRefusesAnUnreadableStateFile(t *testing.T) {
	state := filepath.Join(t.TempDir(), "mic-mute.json")
	if err := os.WriteFile(state, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	f := newFakeMics(t, state, builtIn)
	if _, err := startMics(state, f, true, (&logBuf{}).logf); err == nil {
		t.Fatal("muting on top of an unreadable state file must fail")
	}
	if f.get("BuiltInMicrophoneDevice").Muted {
		t.Error("nothing may be muted then")
	}
	if readFile(t, state) != "{not json" {
		t.Error("the unreadable file must be left as it is")
	}
}

// crash stops a muter the way the process dying would: its polling ends,
// and nothing is put back.
func crash(m *MicMuter) {
	m.once.Do(func() {
		close(m.stop)
		<-m.done
	})
}

func readFile(t *testing.T, path string) string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return string(raw)
}

// The speakers go through the same muter, with their own words in the log and
// their own state file.
func TestMuteSpeakersMutesAndRestores(t *testing.T) {
	state := filepath.Join(t.TempDir(), "speaker-mute.json")
	out := mic{UID: "BuiltInSpeakerDevice", Name: "MacBook Pro Speakers", HasMute: true, Volumes: []micVolume{{Element: 0, Value: 0.5}}}
	hdmi := mic{UID: "hdmi", Name: "LG Display"} // no mute switch, no volume
	f := newFakeMics(t, state, out, hdmi)
	var log logBuf
	m, err := startDevices(speakers, state, f, true, log.logf)
	if err != nil {
		t.Fatal(err)
	}
	if !f.get("BuiltInSpeakerDevice").Muted {
		t.Error("the speakers must be muted")
	}
	for _, want := range []string{"this Mac's speakers muted: MacBook Pro Speakers", "cannot mute LG Display: it has neither a mute switch nor a volume"} {
		if !strings.Contains(log.String(), want) {
			t.Errorf("log lacks %q:\n%s", want, log.String())
		}
	}
	m.Close()
	if f.get("BuiltInSpeakerDevice").Muted {
		t.Error("Close must put the speakers back")
	}
	if !strings.Contains(log.String(), "this Mac's speakers restored: MacBook Pro Speakers") {
		t.Errorf("no restore line:\n%s", log.String())
	}
}

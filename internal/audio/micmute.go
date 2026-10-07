package audio

// Muting this Mac's own microphones while Remote Visio runs (-mic-mute), so
// the room the Mac stands in, and its own speakers, stay out of any app or
// page that uses them. (The remote voice itself reaches only Chromium pages,
// through the browser extension's Remote Visio Microphone; an app that uses
// the Mac's own microphones hears silence while this is on.)
//
// The same goes for the Mac's own speakers (-speaker-mute): the sound pages
// send to Remote Visio Speaker never plays here anyway, and this keeps
// everything else (other tabs, other apps, alerts) quiet too, for a Mac that
// stands in an empty office. What pages send to the sending device is taken
// before any output device, so it is not affected.
//
// A device's mute switch or volume is its own setting, and Core Audio keeps
// it after this process is gone. So each value is written down before it is
// changed, and put back when the receiver stops; after a crash or a kill,
// when it next starts (with -mic-mute/-speaker-mute or without); and by
// -restore-mutes, which the uninstaller runs.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// micVolume is one element's input volume: element 0 is the device's main
// volume, the others its channels.
type micVolume struct {
	Element uint32  `json:"element"`
	Value   float32 `json:"value"`
}

// mic is one of this Mac's microphones as the backend reports it: an input
// device that is neither virtual (BlackHole, or the audio device older Remote
// Visio versions installed) nor an aggregate (one the user made, say).
type mic struct {
	UID, Name string
	HasMute   bool        // it has a settable input mute switch
	Muted     bool        // the switch's position
	Volumes   []micVolume // its settable input volumes, used when it has no switch
}

// micBackend is Core Audio on a Mac (micmute_darwin.go), and a fake in the tests.
type micBackend interface {
	list() ([]mic, error)
	setMute(uid string, on bool) error
	setVolume(uid string, element uint32, value float32) error
}

// micSaved is what a microphone was before it was muted: the switch's
// position, or, without a switch, its volumes.
type micSaved struct {
	UID     string      `json:"uid"`
	Name    string      `json:"name"`
	Muted   *bool       `json:"muted,omitempty"`
	Volumes []micVolume `json:"volumes,omitempty"`
}

// micPoll is how often the device list is looked at again: a microphone
// plugged in while muting is muted too, and one owed a restore that was not
// connected is put back when it is.
var micPoll = 2 * time.Second

// deviceKind names what a MicMuter mutes, in its log lines.
type deviceKind struct{ one, many string }

var (
	microphones = deviceKind{"microphone", "microphones"}
	speakers    = deviceKind{"speaker", "speakers"}
)

// MicMuter keeps this Mac's microphones (or speakers) muted until Close puts
// them back (MuteMics, MuteSpeakers), or puts back the ones an earlier run
// left muted (RestoreMics, RestoreSpeakers).
type MicMuter struct {
	kind   deviceKind
	path   string
	b      micBackend
	muting bool
	poll   time.Duration
	logf   func(string, ...any)

	mu      sync.Mutex
	saved   map[string]micSaved // by UID: what to put back; on disk at path while not empty
	handled map[string]bool     // UIDs this run muted, while they stay connected

	stop chan struct{}
	done chan struct{}
	once sync.Once
}

// MuteMics mutes every microphone of this Mac, and each one plugged in
// later, until Close puts them back. state is the file their previous
// settings are kept in.
func MuteMics(state string, logf func(string, ...any)) (*MicMuter, error) {
	return startMics(state, micDevices, true, logf)
}

// RestoreMics puts back the microphones an earlier -mic-mute run left muted
// (it crashed, or was killed): those connected now at once, any other when
// it is connected again, until Close. Without the state file there is
// nothing to do.
func RestoreMics(state string, logf func(string, ...any)) (*MicMuter, error) {
	return startMics(state, micDevices, false, logf)
}

// MuteSpeakers mutes every output device of this Mac (built-in speakers,
// headphones, USB, Bluetooth, displays), and each one plugged in later,
// until Close puts them back. state is the file their previous settings are
// kept in (not the microphones' file).
func MuteSpeakers(state string, logf func(string, ...any)) (*MicMuter, error) {
	return startDevices(speakers, state, speakerDevices, true, logf)
}

// RestoreSpeakers is RestoreMics for the speakers an earlier -speaker-mute
// run left muted.
func RestoreSpeakers(state string, logf func(string, ...any)) (*MicMuter, error) {
	return startDevices(speakers, state, speakerDevices, false, logf)
}

func startMics(path string, b micBackend, muting bool, logf func(string, ...any)) (*MicMuter, error) {
	return startDevices(microphones, path, b, muting, logf)
}

func startDevices(kind deviceKind, path string, b micBackend, muting bool, logf func(string, ...any)) (*MicMuter, error) {
	m := &MicMuter{
		kind: kind, path: path, b: b, muting: muting, poll: micPoll, logf: logf,
		saved: map[string]micSaved{}, handled: map[string]bool{},
		stop: make(chan struct{}), done: make(chan struct{}),
	}
	// A state file that cannot be read holds settings that can no longer be
	// put back; muting on top of it would bury them for good.
	if err := m.load(); err != nil {
		close(m.done)
		return nil, err
	}
	if !muting && len(m.saved) == 0 {
		close(m.done)
		return m, nil
	}
	devs, err := b.list()
	if err != nil {
		close(m.done)
		return nil, err
	}
	m.mu.Lock()
	if muting {
		// Settings left from a crashed run stay as they were saved: the
		// devices are muted now, and that is not what to put back.
		m.muteNew(devs, true)
	} else {
		if names := m.restorePresent(devs); len(names) > 0 {
			m.logf("put back this Mac's %s that an earlier run left muted: %s", m.kind.many, strings.Join(names, ", "))
		}
	}
	idle := !muting && len(m.saved) == 0
	m.mu.Unlock()
	if idle {
		close(m.done)
		return m, nil
	}
	go m.loop()
	return m, nil
}

func (m *MicMuter) loop() {
	defer close(m.done)
	t := time.NewTicker(m.poll)
	defer t.Stop()
	for {
		select {
		case <-m.stop:
			return
		case <-t.C:
		}
		devs, err := m.b.list()
		if err != nil {
			continue
		}
		m.mu.Lock()
		if m.muting {
			m.muteNew(devs, false)
			m.mu.Unlock()
			continue
		}
		if names := m.restorePresent(devs); len(names) > 0 {
			m.logf("put back %s, which an earlier run left muted", strings.Join(names, ", "))
		}
		owed := len(m.saved)
		m.mu.Unlock()
		if owed == 0 {
			return
		}
	}
}

// muteNew mutes the microphones this run has not handled yet: all of them
// at the start, then each one plugged in.
func (m *MicMuter) muteNew(devs []mic, first bool) {
	present := map[string]bool{}
	var muted []string
	for _, d := range devs {
		present[d.UID] = true
		if m.handled[d.UID] {
			continue
		}
		m.handled[d.UID] = true
		if err := m.muteOne(d); err != nil {
			m.logf("cannot mute %s: %v", d.Name, err)
			continue
		}
		muted = append(muted, d.Name)
	}
	// One unplugged is muted again when it comes back.
	for uid := range m.handled {
		if !present[uid] {
			delete(m.handled, uid)
		}
	}
	switch {
	case first && len(muted) > 0:
		m.logf("this Mac's %s muted: %s", m.kind.many, strings.Join(muted, ", "))
	case first && len(devs) == 0:
		m.logf("this Mac has no %s to mute", m.kind.one)
	case !first:
		for _, name := range muted {
			m.logf("this Mac's %s %s muted (plugged in)", m.kind.one, name)
		}
	}
}

func (m *MicMuter) muteOne(d mic) error {
	if _, ok := m.saved[d.UID]; !ok {
		s := micSaved{UID: d.UID, Name: d.Name}
		switch {
		case d.HasMute:
			was := d.Muted
			s.Muted = &was
		case len(d.Volumes) > 0:
			s.Volumes = append([]micVolume(nil), d.Volumes...)
		default:
			return errors.New("it has neither a mute switch nor a volume")
		}
		// Written down before anything changes: a crash right after must
		// still find what to put back.
		m.saved[d.UID] = s
		if err := m.persist(); err != nil {
			delete(m.saved, d.UID)
			return fmt.Errorf("its settings could not be kept to put back later (%v), so it is left as it is", err)
		}
	}
	s := m.saved[d.UID]
	if s.Muted != nil {
		return m.b.setMute(d.UID, true)
	}
	for _, v := range s.Volumes {
		if err := m.b.setVolume(d.UID, v.Element, 0); err != nil {
			return err
		}
	}
	return nil
}

// restorePresent puts back every saved microphone that is connected, and
// returns their names; the others stay owed.
func (m *MicMuter) restorePresent(devs []mic) []string {
	var names []string
	for _, d := range devs {
		s, ok := m.saved[d.UID]
		if !ok {
			continue
		}
		var err error
		if s.Muted != nil {
			err = m.b.setMute(d.UID, *s.Muted)
		} else {
			for _, v := range s.Volumes {
				if e := m.b.setVolume(d.UID, v.Element, v.Value); e != nil {
					err = e
				}
			}
		}
		if err != nil {
			m.logf("could not put back %s: %v", d.Name, err)
			continue
		}
		delete(m.saved, d.UID)
		names = append(names, d.Name)
	}
	if len(names) > 0 {
		if err := m.persist(); err != nil {
			m.logf("could not update %s: %v", m.path, err)
		}
	}
	return names
}

// Close stops watching the devices and, after MuteMics, puts the
// microphones back. Safe to call more than once, and on nil.
func (m *MicMuter) Close() {
	if m == nil {
		return
	}
	m.once.Do(func() {
		close(m.stop)
		<-m.done
		m.mu.Lock()
		defer m.mu.Unlock()
		if !m.muting || len(m.saved) == 0 {
			return
		}
		devs, err := m.b.list()
		if err != nil {
			m.logf("could not put back this Mac's %s: %v (the next start does)", m.kind.many, err)
			return
		}
		if names := m.restorePresent(devs); len(names) > 0 {
			m.logf("this Mac's %s restored: %s", m.kind.many, strings.Join(names, ", "))
		}
		for _, s := range m.saved {
			m.logf("%s is not connected: it is put back at a later start, once it is", s.Name)
		}
	})
}

func (m *MicMuter) load() error {
	raw, err := os.ReadFile(m.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	var list []micSaved
	if err := json.Unmarshal(raw, &list); err != nil {
		return fmt.Errorf("%s is not readable (%v): the %s' earlier settings in it cannot be put back", m.path, err, m.kind.many)
	}
	for _, s := range list {
		if s.UID != "" && (s.Muted != nil || len(s.Volumes) > 0) {
			m.saved[s.UID] = s
		}
	}
	return nil
}

// persist writes the saved settings (or removes the file when nothing is
// owed), through a temporary file, so a crash mid-write leaves the old one.
func (m *MicMuter) persist() error {
	if len(m.saved) == 0 {
		if err := os.Remove(m.path); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	}
	list := make([]micSaved, 0, len(m.saved))
	for _, s := range m.saved {
		list = append(list, s)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].UID < list[j].UID })
	raw, err := json.MarshalIndent(list, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(m.path), 0o700); err != nil {
		return err
	}
	tmp := m.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, m.path)
}

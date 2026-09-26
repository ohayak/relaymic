package audio

import (
	"encoding/binary"
	"os"
	"sync"
)

// WAVWriter appends int16 PCM to a WAV file and patches the lengths on Close.
//
// This is a diagnostic tool, not a product feature: when "it sounds noisy"
// and "all stats are green" disagree, the only arbiter is the waveform.
// Record the raw samples at one point in the chain and splice steps, hard
// driver-gate edges and clipping are all plainly visible.
type WAVWriter struct {
	mu   sync.Mutex
	f    *os.File
	data int // data bytes written so far
}

func NewWAVWriter(path string, sampleRate, channels int) (*WAVWriter, error) {
	f, err := os.Create(path)
	if err != nil {
		return nil, err
	}
	// Standard 44-byte header; the length fields are placeholders patched on Close.
	h := make([]byte, 44)
	copy(h[0:], "RIFF")
	copy(h[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(h[16:], 16)
	binary.LittleEndian.PutUint16(h[20:], 1) // PCM
	binary.LittleEndian.PutUint16(h[22:], uint16(channels))
	binary.LittleEndian.PutUint32(h[24:], uint32(sampleRate))
	binary.LittleEndian.PutUint32(h[28:], uint32(sampleRate*channels*2))
	binary.LittleEndian.PutUint16(h[32:], uint16(channels*2))
	binary.LittleEndian.PutUint16(h[34:], 16)
	copy(h[36:], "data")
	if _, err := f.Write(h); err != nil {
		f.Close()
		return nil, err
	}
	return &WAVWriter{f: f}, nil
}

func (w *WAVWriter) Write(pcm []int16) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		return
	}
	buf := make([]byte, len(pcm)*2)
	for i, s := range pcm {
		binary.LittleEndian.PutUint16(buf[i*2:], uint16(s))
	}
	if _, err := w.f.Write(buf); err == nil {
		w.data += len(buf)
	}
}

func (w *WAVWriter) Close() error {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.f == nil {
		return nil
	}
	// Patch the RIFF total length and the data chunk length.
	b4 := make([]byte, 4)
	binary.LittleEndian.PutUint32(b4, uint32(36+w.data))
	w.f.WriteAt(b4, 4)
	binary.LittleEndian.PutUint32(b4, uint32(w.data))
	w.f.WriteAt(b4, 40)
	err := w.f.Close()
	w.f = nil
	return err
}

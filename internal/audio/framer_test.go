package audio

import (
	"math"
	"testing"
)

// TestFramerCutsContiguousFrames feeds chunks of awkward sizes, as a sound
// card would, and checks that the frames come out contiguous and in order.
func TestFramerCutsContiguousFrames(t *testing.T) {
	f := NewFramer(6, 4)
	var seq []int16
	next := int16(0)
	for _, n := range []int{4, 5, 1, 8, 6} {
		chunk := make([]int16, n)
		for i := range chunk {
			chunk[i] = next
			next++
		}
		f.Push(chunk)
		seq = append(seq, chunk...)
	}
	for want := 0; want+6 <= len(seq); want += 6 {
		select {
		case frame := <-f.Frames():
			for i, v := range frame {
				if v != seq[want+i] {
					t.Fatalf("frame at %d: sample %d = %d, want %d", want, i, v, seq[want+i])
				}
			}
			f.Recycle(frame)
		default:
			t.Fatalf("no frame for samples %d..%d", want, want+5)
		}
	}
	select {
	case frame := <-f.Frames():
		t.Fatalf("a partial frame was delivered: %v", frame)
	default:
	}
}

// TestFramerDropsWithoutBlocking holds every buffer on the consumer side and
// keeps pushing: Push must return at once, and once a buffer comes back the
// stream resumes.
func TestFramerDropsWithoutBlocking(t *testing.T) {
	f := NewFramer(4, 2)
	chunk := []int16{1, 2, 3, 4}
	for i := 0; i < 10; i++ {
		f.Push(chunk) // would deadlock here if Push ever waited for the consumer
	}
	first := <-f.Frames()
	second := <-f.Frames()
	select {
	case frame := <-f.Frames():
		t.Fatalf("more frames than buffers: %v", frame)
	default:
	}
	f.Recycle(first)
	f.Push([]int16{5, 6, 7, 8})
	got := <-f.Frames()
	if got[0] != 5 || len(got) != 4 {
		t.Fatalf("after recycling, got %v, want [5 6 7 8]", got)
	}
	f.Recycle(second)
	f.Recycle(got)
}

func TestPeakMeter(t *testing.T) {
	var m PeakMeter
	if db, ok := m.TakeDBFS(); ok || db != SilenceDBFS {
		t.Fatalf("empty meter: got %v, %v; want %v, false", db, ok, SilenceDBFS)
	}
	m.Observe([]int16{0, 0})
	if db, ok := m.TakeDBFS(); !ok || db != SilenceDBFS {
		t.Fatalf("all-zero samples: got %v, %v; want %v, true", db, ok, SilenceDBFS)
	}
	m.Observe([]int16{100, -math.MaxInt16, 50})
	if db, ok := m.TakeDBFS(); !ok || db != 0 {
		t.Fatalf("full-scale sample: got %v, %v; want 0, true", db, ok)
	}
	if db, _ := m.TakeDBFS(); db != SilenceDBFS {
		t.Fatalf("TakeDBFS did not reset: got %v", db)
	}
}

func TestPeakHandlesMinInt16(t *testing.T) {
	if got := Peak([]int16{math.MinInt16}); got != -math.MinInt16 {
		t.Fatalf("Peak of MinInt16 = %d, want %d", got, -math.MinInt16)
	}
}

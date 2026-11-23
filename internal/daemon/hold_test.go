package daemon

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestHoldEndsAtMaxOrCancel(t *testing.T) {
	start := time.Now()
	Hold(context.Background(), 20*time.Millisecond)
	if d := time.Since(start); d < 20*time.Millisecond || d > 2*time.Second {
		t.Fatalf("Hold with max lasted %v", d)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(10 * time.Millisecond); cancel() }()
	start = time.Now()
	Hold(ctx, time.Hour)
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("Hold did not finish on cancel: %v", d)
	}
}

func TestHoldEndsWhenParentChanges(t *testing.T) {
	var n atomic.Int32
	ppid := func() int {
		if n.Add(1) > 3 {
			return 1 // reparented
		}
		return 4242
	}
	start := time.Now()
	holdWith(context.Background(), time.Hour, ppid, 5*time.Millisecond)
	if d := time.Since(start); d > 2*time.Second || n.Load() < 4 {
		t.Fatalf("Hold did not finish when the parent changed: %v (%d reads)", d, n.Load())
	}
	// stable parent: ends only by max
	start = time.Now()
	holdWith(context.Background(), 40*time.Millisecond, func() int { return 7 }, 5*time.Millisecond)
	if d := time.Since(start); d < 40*time.Millisecond {
		t.Fatalf("finished before max: %v", d)
	}
}

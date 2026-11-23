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
		t.Fatalf("Hold con max duró %v", d)
	}
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(10 * time.Millisecond); cancel() }()
	start = time.Now()
	Hold(ctx, time.Hour)
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("Hold no terminó al cancelar: %v", d)
	}
}

func TestHoldEndsWhenParentChanges(t *testing.T) {
	var n atomic.Int32
	ppid := func() int {
		if n.Add(1) > 3 {
			return 1 // reparentado
		}
		return 4242
	}
	start := time.Now()
	holdWith(context.Background(), time.Hour, ppid, 5*time.Millisecond)
	if d := time.Since(start); d > 2*time.Second || n.Load() < 4 {
		t.Fatalf("Hold no terminó al cambiar el padre: %v (%d lecturas)", d, n.Load())
	}
	// padre estable: solo termina por max
	start = time.Now()
	holdWith(context.Background(), 40*time.Millisecond, func() int { return 7 }, 5*time.Millisecond)
	if d := time.Since(start); d < 40*time.Millisecond {
		t.Fatalf("terminó antes de max: %v", d)
	}
}

package daemon

import (
	"context"
	"os"
	"runtime"
	"time"
)

// HoldMax is the longest `quorumd hold` lasts: a bit more than the 20 min a tool.check
// hook can stay held by its `$` calls (the mod kills it earlier).
const HoldMax = 25 * time.Minute

// holdPollEvery is how often Hold checks whether its parent died.
const holdPollEvery = 2 * time.Second

// Hold waits doing nothing until ctx ends, max passes or the parent dies. The mod
// launches it with `$.process.spawn` from tool.check: a running `$` does not spend the hook's
// own 10 s, so waiting for a permission from the device can take minutes.
// If the parent (the Claude Code process) dies, the child is orphaned and its ppid
// changes (Linux/mac): it exits instead of waiting the 25 min. On Windows only max applies.
func Hold(ctx context.Context, max time.Duration) {
	var ppid func() int
	if runtime.GOOS != "windows" {
		ppid = os.Getppid
	}
	holdWith(ctx, max, ppid, holdPollEvery)
}

func holdWith(ctx context.Context, max time.Duration, ppid func() int, every time.Duration) {
	t := time.NewTimer(max)
	defer t.Stop()
	var poll <-chan time.Time
	var first int
	if ppid != nil {
		first = ppid()
		tk := time.NewTicker(every)
		defer tk.Stop()
		poll = tk.C
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			return
		case <-poll:
			if ppid() != first {
				return
			}
		}
	}
}

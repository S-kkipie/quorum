package daemon

import (
	"context"
	"os"
	"runtime"
	"time"
)

// HoldMax es lo más que dura `quorumd hold`: algo más que los 20 min que un hook
// tool.check puede quedar retenido por sus llamadas `$` (el mod lo mata antes).
const HoldMax = 25 * time.Minute

// holdPollEvery es cada cuánto Hold mira si su padre murió.
const holdPollEvery = 2 * time.Second

// Hold espera sin hacer nada hasta que ctx termine, pase max o muera el padre. El mod
// lo lanza con `$.process.spawn` desde tool.check: un `$` en curso no gasta los 10 s
// propios del hook, así la espera de un permiso desde el dispositivo puede durar minutos.
// Si el padre (el proceso de Claude Code) muere, el hijo queda huérfano y su ppid
// cambia (Linux/mac): termina en vez de esperar los 25 min. En Windows solo rige max.
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

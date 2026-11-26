//go:build !windows

package daemon

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// fakeLiveScript stands in for `worker.py --live`: it records its PID in $FAKE_DIR/pids, then for every
// stdin line echoes a tagged progress and result (or exits on its second line when $FAKE_DIR/mode is die2,
// or hangs on a line when it is hang).
const fakeLiveScript = `#!/bin/sh
MODE=$(cat "$FAKE_DIR/mode")
echo $$ >> "$FAKE_DIR/pids"
echo "$PWD" > "$FAKE_DIR/livework"
n=0
while read -r line; do
	n=$((n+1))
	id=$(echo "$line" | sed 's/.*"jobId":"\([^"]*\)".*/\1/')
	at=$(echo "$line" | sed 's/.*"attempt":\([0-9]*\).*/\1/')
	echo "$line" | sed 's/.*"workDir":"\([^"]*\)".*/\1/' > "$FAKE_DIR/workdir"
	if [ "$MODE" = stale ]; then echo '{"type":"error","error":"stale","jobId":"'$id'","attempt":99}'; fi
	if [ "$MODE" = die2 ] && [ $n -eq 2 ]; then exit 4; fi
	echo '{"type":"progress","pct":50,"stage":"transcribing","jobId":"'$id'","attempt":'$at'}'
	if [ "$MODE" = hang ]; then sleep 300; fi
	echo '{"type":"result","result":{"segments":[],"transcribedMs":1000},"jobId":"'$id'","attempt":'$at'}'
done
`

func newLiveFake(t *testing.T) *meetFake {
	t.Helper()
	f := newMeetFake(t)
	script := filepath.Join(f.dir, "live.sh")
	require.NoError(t, os.WriteFile(script, []byte(fakeLiveScript), 0o755))
	old, oldIdle := liveCommand, liveIdle
	liveCommand = func(ctx context.Context, _ string) (*exec.Cmd, error) {
		c := exec.CommandContext(ctx, "/bin/sh", script)
		c.Env = append(os.Environ(), "FAKE_DIR="+f.dir)
		return c, nil
	}
	t.Cleanup(func() {
		liveWorkers.shutdown()
		liveCommand, liveIdle = old, oldIdle
	})
	return f
}

func chunk(id string, attempt int) proto.MeetingJobStart {
	j := job(id, attempt)
	j.Step = proto.MeetingStepTranscribeChunk
	j.Settings = []byte(`{"fromMs":0,"liveBytes":10}`)
	return j
}

func (f *meetFake) pids() []int {
	b, _ := os.ReadFile(filepath.Join(f.dir, "pids"))
	var out []int
	for _, l := range strings.Fields(string(b)) {
		n, _ := strconv.Atoi(l)
		out = append(out, n)
	}
	return out
}

func (f *meetFake) waitPosts(n int) {
	f.t.Helper()
	require.Eventually(f.t, func() bool { return len(f.posts()) >= n }, 3*time.Second, 10*time.Millisecond)
}

func TestLiveChunksShareOneWorker(t *testing.T) {
	f := newLiveFake(t)
	_, err := f.start(chunk("c1", 1))
	require.NoError(t, err)
	f.waitPosts(1)
	// the result is posted once the job is cleared, so the next chunk is accepted
	var err2 error
	require.Eventually(t, func() bool { _, err2 = f.start(chunk("c2", 1)); return err2 == nil }, 3*time.Second, 10*time.Millisecond)
	f.waitPosts(2)
	require.Empty(t, f.posts()[0].body.Error)
	require.Len(t, f.pids(), 1)
	// the worker got the folder under tmp/live
	require.Eventually(t, func() bool {
		b, _ := os.ReadFile(filepath.Join(f.dir, "workdir"))
		return strings.TrimSpace(string(b)) == filepath.Join(f.mdir, "tmp", "live")
	}, 3*time.Second, 10*time.Millisecond)
}

func TestLiveWorkerExitsWhenIdle(t *testing.T) {
	f := newLiveFake(t)
	liveIdle = 100 * time.Millisecond
	_, err := f.start(chunk("c1", 1))
	require.NoError(t, err)
	f.waitPosts(1)
	pid := f.pids()[0]
	require.Eventually(t, func() bool { return !alive(pid) }, 2*time.Second, 10*time.Millisecond)
	require.Eventually(t, func() bool {
		_, err := os.Stat(filepath.Join(f.mdir, "tmp", "live"))
		return os.IsNotExist(err)
	}, 2*time.Second, 10*time.Millisecond)
}

func TestFullJobStopsTheLiveWorker(t *testing.T) {
	f := newLiveFake(t)
	f.mode("ok")
	_, err := f.start(chunk("c1", 1))
	require.NoError(t, err)
	f.waitPosts(1)
	live := f.pids()[0]
	require.True(t, alive(live))

	f.mode("hang") // the full worker (and the fake live one) read the same mode file; only the full one matters
	_, err = f.start(job("full", 1))
	require.NoError(t, err)
	f.pid("pid") // the full worker's PID file
	require.False(t, alive(live), "the resident worker is gone before the full worker runs")
	_, err = os.Stat(filepath.Join(f.mdir, "tmp", "live"))
	require.True(t, os.IsNotExist(err))

	_, err = f.start(chunk("c2", 1))
	require.ErrorIs(t, err, errMeetingBusy)
}

func TestLiveChunkCancelKillsTheWorker(t *testing.T) {
	f := newLiveFake(t)
	f.mode("hang")
	_, err := f.start(chunk("c1", 1))
	require.NoError(t, err)
	f.progress(func(p proto.MeetingProgress) bool { return p.JobID == "c1" && p.Pct == 50 })
	pid := f.pids()[0]
	res, err := f.cancel("c1", 1)
	require.NoError(t, err)
	require.Equal(t, map[string]bool{"cancelled": true}, res)
	require.False(t, alive(pid))
	time.Sleep(100 * time.Millisecond)
	require.Empty(t, f.posts())
	res, _ = f.cancel("c1", 1)
	require.Equal(t, map[string]bool{"cancelled": false}, res)
}

func TestLiveWorkerDeathPostsError(t *testing.T) {
	f := newLiveFake(t)
	f.mode("die2")
	_, err := f.start(chunk("c1", 1))
	require.NoError(t, err)
	f.waitPosts(1)
	require.Eventually(t, func() bool { _, err := f.start(chunk("c2", 1)); return err == nil }, 3*time.Second, 10*time.Millisecond)
	f.waitPosts(2)
	require.Empty(t, f.posts()[0].body.Error)
	require.Contains(t, f.posts()[1].body.Error, "the meeting worker failed")
	require.Len(t, f.pids(), 1)
}

func TestLiveChunkProgressForwarded(t *testing.T) {
	f := newLiveFake(t)
	_, err := f.start(chunk("c1", 2))
	require.NoError(t, err)
	p := f.progress(func(p proto.MeetingProgress) bool { return p.Pct == 50 })
	require.Equal(t, proto.MeetingProgress{JobID: "c1", Attempt: 2, Pct: 50, Stage: "transcribing"}, p)
}

func TestLiveChunkRightAfterIdleExpiryUsesANewProcess(t *testing.T) {
	f := newLiveFake(t)
	liveIdle = 30 * time.Millisecond
	_, err := f.start(chunk("c1", 1))
	require.NoError(t, err)
	f.waitPosts(1)
	// wait until the idle timer closed stdin, then send at once: the old process may still be exiting
	time.Sleep(60 * time.Millisecond)
	liveIdle = time.Hour
	_, err = f.start(chunk("c2", 1))
	require.NoError(t, err)
	f.waitPosts(2)
	require.Empty(t, f.posts()[1].body.Error)
	require.Len(t, f.pids(), 2)
	require.True(t, alive(f.pids()[1]))
	_, err = os.Stat(filepath.Join(f.mdir, "tmp", "live"))
	require.NoError(t, err, "the new process keeps its folder")
}

func TestFullJobWhileChunkInFlightKillsAfterGrace(t *testing.T) {
	f := newLiveFake(t)
	f.mode("hang")
	liveStopGrace = 100 * time.Millisecond
	t.Cleanup(func() { liveStopGrace = 5 * time.Second })
	_, err := f.start(chunk("c1", 1))
	require.NoError(t, err)
	f.progress(func(p proto.MeetingProgress) bool { return p.JobID == "c1" && p.Pct == 50 })
	live := f.pids()[0]
	_, err = f.start(job("full", 1))
	require.NoError(t, err)
	require.False(t, alive(live))
	f.waitPosts(1)
	require.Equal(t, "/api/meeting-jobs/tok/result", f.posts()[0].path)
	require.Contains(t, f.posts()[0].body.Error, "the meeting worker")
	f.pid("pid") // the full worker started
}

func TestLiveStaleAttemptLineIgnored(t *testing.T) {
	f := newLiveFake(t)
	f.mode("stale")
	_, err := f.start(chunk("c1", 1))
	require.NoError(t, err)
	f.waitPosts(1)
	time.Sleep(100 * time.Millisecond)
	require.Len(t, f.posts(), 1)
	require.Empty(t, f.posts()[0].body.Error)
}

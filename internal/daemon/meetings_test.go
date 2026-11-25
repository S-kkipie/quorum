//go:build !windows

package daemon

import (
	"context"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	meetingworker "github.com/S-kkipie/quorum/worker/meetings"
	"github.com/stretchr/testify/require"
)

// fakeWorkerScript stands in for worker.py: it saves its job, prints JSON lines like the real worker and
// behaves as $FAKE_DIR/mode says (ok, hang, error, crash).
const fakeWorkerScript = `#!/bin/sh
MODE=$(cat "$FAKE_DIR/mode")
cat > "$FAKE_DIR/job-$$.json"
echo $$ > "$FAKE_DIR/pid"
echo "$TMPDIR" > "$FAKE_DIR/work"
echo "private audio" > "$TMPDIR/source"
echo '{"type":"progress","pct":10,"stage":"transcribing"}'
echo 'not json'
echo '{"type":"log","message":"loading the model"}'
case "$MODE" in
ok)
	echo '{"type":"progress","pct":60,"stage":"diarizing"}'
	echo '{"type":"result","result":{"segments":[{"start_ms":0,"end_ms":900,"speaker":"Me","text":"hello"}],"duration_s":1.5,"language":"es"}}'
	;;
hang)
	sleep 300 &
	echo $! > "$FAKE_DIR/child"
	wait
	;;
error)
	echo '{"type":"error","error":"CUDA error: out of memory"}'
	exit 1
	;;
crash)
	echo "Traceback (most recent call last):" >&2
	echo "ImportError: libcudnn.so.9: cannot open shared object file" >&2
	exit 3
	;;
esac
`

type meetFake struct {
	t    *testing.T
	dir  string
	mdir string // the meetings folder (its tmp/ holds the job folders)
	hub  *httptest.Server
	reg  *Registry
	host *Host
	mu   sync.Mutex
	post []postedResult
}

type postedResult struct {
	path string
	body proto.MeetingJobResult
}

func newMeetFake(t *testing.T) *meetFake {
	t.Helper()
	f := &meetFake{t: t, dir: t.TempDir(), reg: NewRegistry("m1")}
	f.mdir = t.TempDir()
	t.Setenv("QUORUM_MEETINGS_DIR", f.mdir)
	script := filepath.Join(f.dir, "worker.sh")
	require.NoError(t, os.WriteFile(script, []byte(fakeWorkerScript), 0o755))
	f.mode("ok")
	old, oldHB, oldWait := meetingCommand, meetingHeartbeat, meetingPostWait
	meetingCommand = func(ctx context.Context, _ string) (*exec.Cmd, error) {
		c := exec.CommandContext(ctx, "/bin/sh", script)
		c.Env = append(os.Environ(), "FAKE_DIR="+f.dir)
		return c, nil
	}
	meetingHeartbeat, meetingPostWait = time.Hour, 10*time.Millisecond
	t.Cleanup(func() {
		meetingJobs.shutdown()
		meetingCommand, meetingHeartbeat, meetingPostWait = old, oldHB, oldWait
	})
	f.hub = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body proto.MeetingJobResult
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.post = append(f.post, postedResult{r.URL.Path, body})
		f.mu.Unlock()
		w.WriteHeader(200)
	}))
	t.Cleanup(f.hub.Close)
	f.host = &Host{HubURL: f.hub.URL}
	return f
}

func (f *meetFake) mode(m string) {
	require.NoError(f.t, os.WriteFile(filepath.Join(f.dir, "mode"), []byte(m), 0o644))
}

func (f *meetFake) start(job proto.MeetingJobStart) (any, error) {
	p, _ := json.Marshal(job)
	return invokeRPC(context.Background(), f.host, f.reg, proto.RPC{ReqID: "r", Method: "meeting_job_start", Params: p})
}

func (f *meetFake) cancel(jobID string, attempt int) (any, error) {
	p, _ := json.Marshal(proto.MeetingJobCancel{JobID: jobID, Attempt: attempt})
	return invokeRPC(context.Background(), f.host, f.reg, proto.RPC{ReqID: "r", Method: "meeting_job_cancel", Params: p})
}

func (f *meetFake) posts() []postedResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]postedResult(nil), f.post...)
}

// progress reads meeting_progress envelopes until one matches want.
func (f *meetFake) progress(want func(proto.MeetingProgress) bool) proto.MeetingProgress {
	f.t.Helper()
	deadline := time.After(3 * time.Second)
	for {
		select {
		case env := <-f.reg.Out():
			if env.Type != "meeting_progress" {
				continue
			}
			var p proto.MeetingProgress
			require.NoError(f.t, json.Unmarshal(env.Payload, &p))
			if want(p) {
				return p
			}
		case <-deadline:
			f.t.Fatal("no matching meeting_progress")
		}
	}
}

func (f *meetFake) pid(name string) int {
	f.t.Helper()
	var pid int
	require.Eventually(f.t, func() bool {
		b, err := os.ReadFile(filepath.Join(f.dir, name))
		if err != nil {
			return false
		}
		pid, err = strconv.Atoi(strings.TrimSpace(string(b)))
		return err == nil && pid > 0
	}, 3*time.Second, 10*time.Millisecond)
	return pid
}

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }

func job(id string, attempt int) proto.MeetingJobStart {
	return proto.MeetingJobStart{JobID: id, Attempt: attempt, MeetingID: "mt1", Step: proto.MeetingStepTranscribe,
		AudioURL: "/api/meeting-jobs/tok/audio", ResultURL: "/api/meeting-jobs/tok/result",
		Settings: json.RawMessage(`{"language":"es","channels":"me|others"}`)}
}

func TestMeetingJobProgressForwardedAndResultPosted(t *testing.T) {
	f := newMeetFake(t)
	t0 := time.Now()
	res, err := f.start(job("j1", 1))
	require.NoError(t, err)
	require.Equal(t, map[string]bool{"ok": true}, res)
	require.Less(t, time.Since(t0), time.Second, "the rpc returns at once")

	p := f.progress(func(p proto.MeetingProgress) bool { return p.Pct == 60 })
	require.Equal(t, proto.MeetingProgress{JobID: "j1", Attempt: 1, Pct: 60, Stage: "diarizing"}, p)
	require.Eventually(t, func() bool { return len(f.posts()) == 1 }, 3*time.Second, 10*time.Millisecond)
	got := f.posts()[0]
	require.Equal(t, "/api/meeting-jobs/tok/result", got.path)
	require.Empty(t, got.body.Error)
	var tr proto.MeetingTranscript
	require.NoError(t, json.Unmarshal(got.body.Result, &tr))
	require.Equal(t, "hello", tr.Segments[0].Text)
	require.Equal(t, "Me", tr.Segments[0].Speaker)

	// the worker got the job with the audio URL resolved against the hub, and no result URL
	files, _ := filepath.Glob(filepath.Join(f.dir, "job-*.json"))
	require.Len(t, files, 1)
	var in map[string]any
	b, _ := os.ReadFile(files[0])
	require.NoError(t, json.Unmarshal(b, &in))
	require.Equal(t, f.hub.URL+"/api/meeting-jobs/tok/audio", in["audioURL"])
	require.Equal(t, "", in["resultURL"])
	require.Nil(t, in["transcriptURL"])
	require.Equal(t, "me|others", in["settings"].(map[string]any)["channels"])
	require.Eventually(t, func() bool { _, ok := meetingJobs.running(); return !ok }, 3*time.Second, 10*time.Millisecond)
}

func TestMeetingJobTranscriptURLResolved(t *testing.T) {
	f := newMeetFake(t)
	j := job("j1", 1)
	j.Step, j.AudioURL, j.TranscriptURL = proto.MeetingStepSummarizeLocal, "", "/api/meeting-jobs/tok/transcript"
	_, err := f.start(j)
	require.NoError(t, err)
	var in map[string]any
	require.Eventually(t, func() bool {
		files, _ := filepath.Glob(filepath.Join(f.dir, "job-*.json"))
		if len(files) != 1 {
			return false
		}
		b, _ := os.ReadFile(files[0])
		return json.Unmarshal(b, &in) == nil
	}, 3*time.Second, 10*time.Millisecond)
	require.Equal(t, f.hub.URL+"/api/meeting-jobs/tok/transcript", in["transcriptURL"])
	require.Equal(t, "", in["audioURL"])
	require.Eventually(t, func() bool { _, ok := meetingJobs.running(); return !ok }, 3*time.Second, 10*time.Millisecond)
}

func TestMeetingJobOneAtATime(t *testing.T) {
	f := newMeetFake(t)
	f.mode("hang")
	_, err := f.start(job("j1", 1))
	require.NoError(t, err)
	pid := f.pid("pid")
	// another job is refused while one runs
	_, err = f.start(job("j2", 1))
	require.ErrorContains(t, err, "busy")
	// the same attempt again is a no-op
	_, err = f.start(job("j1", 1))
	require.NoError(t, err)
	require.True(t, alive(pid))
	// a newer attempt of the same job replaces the old one (the hub re-queued it)
	require.NoError(t, os.Remove(filepath.Join(f.dir, "pid")))
	f.mode("ok")
	_, err = f.start(job("j1", 2))
	require.NoError(t, err)
	require.False(t, alive(pid), "the old attempt's worker is gone")
	require.Eventually(t, func() bool { return len(f.posts()) == 1 }, 3*time.Second, 10*time.Millisecond)
	require.Empty(t, f.posts()[0].body.Error) // only attempt 2 posted
	time.Sleep(50 * time.Millisecond)
	require.Len(t, f.posts(), 1)
}

func TestMeetingJobKilledOnCancel(t *testing.T) {
	f := newMeetFake(t)
	f.mode("hang")
	_, err := f.start(job("j1", 1))
	require.NoError(t, err)
	pid, child := f.pid("pid"), f.pid("child")
	require.True(t, alive(child))

	res, err := f.cancel("j1", 2) // another attempt: not this worker
	require.NoError(t, err)
	require.Equal(t, map[string]bool{"cancelled": false}, res)
	res, err = f.cancel("j1", 1)
	require.NoError(t, err)
	require.Equal(t, map[string]bool{"cancelled": true}, res)
	require.Eventually(t, func() bool { return !alive(pid) && !alive(child) }, 3*time.Second, 10*time.Millisecond,
		"the worker and what it started (ffmpeg) are killed")
	_, running := meetingJobs.running()
	require.False(t, running)
	time.Sleep(50 * time.Millisecond)
	require.Empty(t, f.posts(), "a cancelled job posts nothing")
	// the machine takes the next job
	f.mode("ok")
	_, err = f.start(job("j2", 1))
	require.NoError(t, err)
	require.Eventually(t, func() bool { return len(f.posts()) == 1 }, 3*time.Second, 10*time.Millisecond)
}

func TestMeetingJobKilledOnShutdown(t *testing.T) {
	f := newMeetFake(t)
	f.mode("hang")
	_, err := f.start(job("j1", 1))
	require.NoError(t, err)
	pid := f.pid("pid")
	meetingJobs.shutdown()
	require.False(t, alive(pid))
	require.Empty(t, f.posts())
}

func TestMeetingJobWorkerErrorsArePosted(t *testing.T) {
	f := newMeetFake(t)
	f.mode("error")
	_, err := f.start(job("j1", 1))
	require.NoError(t, err)
	require.Eventually(t, func() bool { return len(f.posts()) == 1 }, 3*time.Second, 10*time.Millisecond)
	require.Equal(t, "CUDA error: out of memory", f.posts()[0].body.Error)

	f.mode("crash") // no error line: the exit status and stderr's last line explain it
	_, err = f.start(job("j2", 1))
	require.NoError(t, err)
	require.Eventually(t, func() bool { return len(f.posts()) == 2 }, 3*time.Second, 10*time.Millisecond)
	msg := f.posts()[1].body.Error
	require.Contains(t, msg, "exit status 3")
	require.Contains(t, msg, "libcudnn.so.9")
}

func TestMeetingJobHeartbeat(t *testing.T) {
	f := newMeetFake(t)
	meetingHeartbeat = 30 * time.Millisecond
	f.mode("hang")
	_, err := f.start(job("j1", 1))
	require.NoError(t, err)
	n := 0
	f.progress(func(p proto.MeetingProgress) bool {
		if p.Pct == 10 {
			n++
		}
		return n >= 3 // the last progress keeps coming while the worker is busy
	})
}

func TestMeetingResultRetriesUntilTheHubAnswers(t *testing.T) {
	var mu sync.Mutex
	codes := []int{502, 503, 200}
	var seen int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		io.Copy(io.Discard, r.Body)
		mu.Lock()
		c := codes[seen]
		seen++
		mu.Unlock()
		w.WriteHeader(c)
	}))
	defer srv.Close()
	postMeetingResult(context.Background(), srv.URL, proto.MeetingJobResult{Error: "x"}, 5, time.Millisecond)
	mu.Lock()
	require.Equal(t, 3, seen)
	mu.Unlock()
	// a 409 (stale attempt) is final
	mu.Lock()
	codes, seen = []int{409, 200}, 0
	mu.Unlock()
	postMeetingResult(context.Background(), srv.URL, proto.MeetingJobResult{Error: "x"}, 5, time.Millisecond)
	mu.Lock()
	require.Equal(t, 1, seen)
	mu.Unlock()
	// a cancelled run (cancel or shutdown) stops retrying at once
	mu.Lock()
	codes, seen = []int{503, 503, 503, 503, 503}, 0
	mu.Unlock()
	ctx, cancel := context.WithCancel(context.Background())
	go func() { time.Sleep(50 * time.Millisecond); cancel() }()
	t0 := time.Now()
	postMeetingResult(ctx, srv.URL, proto.MeetingJobResult{Error: "x"}, 5, time.Hour)
	require.Less(t, time.Since(t0), 2*time.Second)
	mu.Lock()
	require.Equal(t, 1, seen)
	mu.Unlock()
}

func TestMeetingCapsFollowTheSetup(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("QUORUM_MEETINGS_DIR", dir)
	h := noHerdrHost(t)
	c := h.Caps(context.Background())
	require.False(t, c.Transcribe)
	require.Equal(t, "", c.MeetingWorker)

	require.NoError(t, os.MkdirAll(filepath.Join(dir, "venv", "bin"), 0o755))
	require.Equal(t, "incomplete", h.Caps(context.Background()).MeetingWorker)
	require.NoError(t, os.WriteFile(filepath.Join(dir, "venv", "bin", "python"), nil, 0o755))
	require.Equal(t, "incomplete", h.Caps(context.Background()).MeetingWorker)

	require.NoError(t, os.WriteFile(filepath.Join(dir, meetingsReadyFile), []byte(`{"cuda":false,"error":"no GPU"}`), 0o644))
	c = h.Caps(context.Background())
	require.Equal(t, "no_gpu", c.MeetingWorker)
	require.False(t, c.Transcribe)

	require.NoError(t, os.WriteFile(filepath.Join(dir, meetingsReadyFile), []byte(`{"cuda":true}`), 0o644))
	c = h.Caps(context.Background())
	require.Equal(t, "ready", c.MeetingWorker)
	require.True(t, c.Transcribe)
}

func TestResolveHubURL(t *testing.T) {
	u, err := resolveHubURL("https://hub.example:8443/", "/api/meeting-jobs/a.b/result")
	require.NoError(t, err)
	require.Equal(t, "https://hub.example:8443/api/meeting-jobs/a.b/result", u)
	_, err = resolveHubURL("", "/api/x")
	require.Error(t, err)
	u, err = resolveHubURL("https://hub.example:8443", "https://hub.example:8443/api/x")
	require.NoError(t, err)
	require.Equal(t, "https://hub.example:8443/api/x", u)
	for _, bad := range []string{"https://evil.example/api/x", "http://hub.example:8443/api/x", "//evil.example/x",
		"https://hub.example/api/x", "file:///etc/passwd"} {
		_, err = resolveHubURL("https://hub.example:8443", bad)
		require.Error(t, err, bad)
	}
}

func TestInstallModelFromArchive(t *testing.T) {
	if _, err := exec.LookPath("bzip2"); err != nil {
		t.Skip("bzip2 is not installed")
	}
	dir := t.TempDir()
	src := filepath.Join(dir, "src", "pkg")
	require.NoError(t, os.MkdirAll(src, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(src, "model.onnx"), []byte("fake model"), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(src, "README.md"), []byte("readme"), 0o644))
	archive := filepath.Join(dir, "m.tar.bz2")
	require.NoError(t, exec.Command("tar", "cjf", archive, "-C", filepath.Join(dir, "src"), "pkg").Run())
	sum := "9a1b2d03a7b3c3d6f1bd1e3a7f1b15f8a9ae2ea1d1b2b5ee8a5c3f2a4cc3e0a4" // wrong on purpose first
	open := func() *os.File {
		f, err := os.Open(archive)
		require.NoError(t, err)
		t.Cleanup(func() { f.Close() })
		return f
	}
	dest := filepath.Join(dir, "out.onnx")
	err := installModel(open(), diarModel{member: "pkg/model.onnx", sha256: sum}, dest)
	require.ErrorContains(t, err, "checksum mismatch")
	require.NoFileExists(t, dest)

	h, _ := fileSHA256(filepath.Join(src, "model.onnx"))
	require.NoError(t, installModel(open(), diarModel{member: "pkg/model.onnx", sha256: h}, dest))
	b, _ := os.ReadFile(dest)
	require.Equal(t, "fake model", string(b))
	require.ErrorContains(t, installModel(open(), diarModel{member: "pkg/other.onnx", sha256: h}, dest), "not in the archive")
	// a plain file
	require.NoError(t, installModel(strings.NewReader("fake model"), diarModel{sha256: h}, filepath.Join(dir, "plain.onnx")))
}

func TestEnsureWorkerFileDeploysTheEmbeddedWorker(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, ensureWorkerFile(dir))
	b, err := os.ReadFile(filepath.Join(dir, "worker.py"))
	require.NoError(t, err)
	require.Contains(t, string(b), "Quorum meeting worker")
	require.NoError(t, os.WriteFile(filepath.Join(dir, "worker.py"), []byte("old"), 0o644))
	require.NoError(t, ensureWorkerFile(dir))
	b, _ = os.ReadFile(filepath.Join(dir, "worker.py"))
	require.Contains(t, string(b), "Quorum meeting worker")
	// the shared prompts go next to it
	b, err = os.ReadFile(filepath.Join(dir, "prompts.json"))
	require.NoError(t, err)
	require.Equal(t, meetingworker.Prompts, b)
}

func TestWorkerEnvAddsCUDALibraries(t *testing.T) {
	dir := t.TempDir()
	lib := filepath.Join(dir, "venv", "lib", "python3.12", "site-packages", "nvidia", "cublas", "lib")
	require.NoError(t, os.MkdirAll(lib, 0o755))
	t.Setenv("LD_LIBRARY_PATH", "/usr/lib/wsl/lib")
	t.Setenv("QUORUM_SECRET_TOKEN", "s3cret")
	t.Setenv("CUDA_VISIBLE_DEVICES", "0")
	t.Setenv("LC_ALL", "C.UTF-8")
	env := strings.Join(workerEnv(dir, true), "\n")
	require.NotContains(t, env, "s3cret", "only allow-listed variables reach the worker")
	require.Contains(t, env, "CUDA_VISIBLE_DEVICES=0")
	require.Contains(t, env, "LC_ALL=C.UTF-8")
	require.Contains(t, env, "LD_LIBRARY_PATH="+lib+":/usr/lib/wsl/lib")
	require.Contains(t, env, "HF_HOME="+filepath.Join(dir, "models", "hf"))
	require.Contains(t, env, "HF_HUB_OFFLINE=1")
}

// workDir returns the job folder the fake worker saw (its TMPDIR).
func (f *meetFake) workDir() string {
	f.t.Helper()
	var w string
	require.Eventually(f.t, func() bool {
		b, err := os.ReadFile(filepath.Join(f.dir, "work"))
		w = strings.TrimSpace(string(b))
		return err == nil && w != ""
	}, 3*time.Second, 10*time.Millisecond)
	return w
}

func idle() bool { _, ok := meetingJobs.running(); return !ok }

func TestMeetingJobFolderIsRemovedWhateverHappens(t *testing.T) {
	f := newMeetFake(t)
	for _, mode := range []string{"ok", "crash", "hang"} {
		require.NoError(t, os.RemoveAll(filepath.Join(f.dir, "work")))
		f.mode(mode)
		id := "job-" + mode
		_, err := f.start(job(id, 1))
		require.NoError(t, err)
		w := f.workDir()
		require.Equal(t, filepath.Join(f.mdir, "tmp", id+"-1"), w)
		st, err := os.Stat(w)
		if err == nil { // the folder may already be gone after a fast run
			require.Equal(t, os.FileMode(0o700), st.Mode().Perm())
		}
		if mode == "hang" {
			require.FileExists(t, filepath.Join(w, "source"))
			_, err := f.cancel(id, 1) // killed: the worker never cleans up itself
			require.NoError(t, err)
		}
		require.Eventually(t, idle, 3*time.Second, 10*time.Millisecond)
		require.NoDirExists(t, w, mode)
	}
	// the worker read its folder from stdin as well
	files, _ := filepath.Glob(filepath.Join(f.dir, "job-*.json"))
	require.NotEmpty(t, files)
	b, _ := os.ReadFile(files[0])
	require.Contains(t, string(b), `"workDir":"`+filepath.Join(f.mdir, "tmp"))
}

func TestMeetingStaleJobFoldersAreSwept(t *testing.T) {
	f := newMeetFake(t)
	stale := filepath.Join(f.mdir, "tmp", "old-1")
	require.NoError(t, os.MkdirAll(stale, 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(stale, "source"), []byte("private"), 0o600))
	SweepMeetingTmp() // the daemon's start
	require.NoDirExists(t, stale)

	require.NoError(t, os.MkdirAll(stale, 0o700))
	_, err := f.start(job("j1", 1)) // and any start with no worker running
	require.NoError(t, err)
	require.NoDirExists(t, stale)
	require.Eventually(t, idle, 3*time.Second, 10*time.Millisecond)
}

func TestMeetingJobRefusesForeignURLs(t *testing.T) {
	f := newMeetFake(t)
	j := job("j1", 1)
	j.AudioURL = "https://elsewhere.example/audio"
	_, err := f.start(j)
	require.ErrorContains(t, err, "not on the hub")
	j = job("j2", 1)
	j.ResultURL = "http://elsewhere.example/result"
	_, err = f.start(j)
	require.ErrorContains(t, err, "not on the hub")
	j = job("j3", 1)
	j.TranscriptURL = "//elsewhere.example/transcript"
	_, err = f.start(j)
	require.ErrorContains(t, err, "not on the hub")
	j = job("../../etc", 1)
	_, err = f.start(j)
	require.ErrorContains(t, err, "invalid")
	require.True(t, idle())
}

// syncBuf is a log sink safe for concurrent writes.
type syncBuf struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *syncBuf) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *syncBuf) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

func TestMeetingResultPostErrorsLogNoURL(t *testing.T) {
	var buf syncBuf
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(os.Stderr) })
	srv := httptest.NewServer(http.NotFoundHandler())
	u := srv.URL + "/api/meeting-jobs/secret-token-123/result"
	srv.Close() // the hub is unreachable: every post is a network error
	postMeetingResult(context.Background(), u, proto.MeetingJobResult{Error: "x"}, 2, time.Millisecond)
	out := buf.String()
	require.Contains(t, out, "meetings: post result: Post: ")
	require.NotContains(t, out, "secret-token-123")
	require.NotContains(t, out, srv.URL)
}

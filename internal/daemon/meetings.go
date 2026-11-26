package daemon

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	meetingworker "github.com/S-kkipie/quorum/worker/meetings"
)

// The meeting worker: a Python program in a venv under ~/.local/share/quorum/meetings that
// `quorumd meetings setup` creates. The daemon runs it as a subprocess, one job at a time: the job goes on
// its stdin, its stdout is JSON lines (progress, log, then result or error), progress is forwarded to the
// hub as meeting_progress envelopes (re-sent as a heartbeat), and the result is POSTed to the job's signed
// result URL. A cancel from the hub, a newer attempt of the same job, or the daemon's shutdown kills it.

// meetingsReadyFile is written by the setup after the CUDA check.
const meetingsReadyFile = "ready.json"

var (
	// meetingHeartbeat: how often the last progress is re-sent while a job runs (the hub re-queues a job
	// whose machine is silent for 2 min).
	meetingHeartbeat = 20 * time.Second
	// meetingPostRetries and meetingPostWait bound the result upload on a flaky network.
	meetingPostRetries = 5
	meetingPostWait    = 3 * time.Second
	// meetingCommand builds the worker's command (replaced in tests by a fake script).
	meetingCommand = defaultMeetingCommand
)

// maxWorkerLine bounds one stdout line of the worker (the result of a long meeting is a few MB).
const maxWorkerLine = 64 << 20

// MeetingsDir is the worker's folder: $QUORUM_MEETINGS_DIR, else $XDG_DATA_HOME/quorum/meetings, else
// ~/.local/share/quorum/meetings.
func MeetingsDir() (string, error) {
	if d := os.Getenv("QUORUM_MEETINGS_DIR"); d != "" {
		return d, nil
	}
	if d := os.Getenv("XDG_DATA_HOME"); d != "" {
		return filepath.Join(d, "quorum", "meetings"), nil
	}
	h, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(h, ".local", "share", "quorum", "meetings"), nil
}

func venvPython(dir string) string { return filepath.Join(dir, "venv", "bin", "python") }

// meetingsReady is what the setup records after its CUDA check.
type meetingsReady struct {
	CUDA      bool   `json:"cuda"`
	Error     string `json:"error,omitempty"`
	CheckedAt int64  `json:"checkedAt"`
	Model     string `json:"model,omitempty"`
}

// meetingWorkerState returns the worker's state for the caps: "" (not set up), "incomplete", "no_gpu"
// or "ready". Only Linux (including WSL) runs the worker.
func meetingWorkerState() string {
	if runtime.GOOS != "linux" {
		return ""
	}
	dir, err := MeetingsDir()
	if err != nil {
		return ""
	}
	if _, err := os.Stat(filepath.Join(dir, "venv")); err != nil {
		return ""
	}
	if _, err := os.Stat(venvPython(dir)); err != nil {
		return "incomplete"
	}
	b, err := os.ReadFile(filepath.Join(dir, meetingsReadyFile))
	if err != nil {
		return "incomplete"
	}
	var r meetingsReady
	if json.Unmarshal(b, &r) != nil {
		return "incomplete"
	}
	if !r.CUDA {
		return "no_gpu"
	}
	return "ready"
}

// ensureWorkerFile writes the embedded worker.py and its prompts.json into dir when they differ (an
// updated quorumd brings its own worker).
func ensureWorkerFile(dir string) error {
	for _, f := range []struct {
		name string
		data []byte
	}{{"prompts.json", meetingworker.Prompts}, {"worker.py", meetingworker.Worker}} {
		path := filepath.Join(dir, f.name)
		if b, err := os.ReadFile(path); err == nil && bytes.Equal(b, f.data) {
			continue
		}
		if err := writeFileAtomic(path, f.data, 0o644); err != nil {
			return err
		}
	}
	return nil
}

func writeFileAtomic(path string, data []byte, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// workerEnv is the worker's environment: an allow-list of the daemon's variables (never its tokens),
// the CUDA libraries of the venv's nvidia packages on LD_LIBRARY_PATH and the Hugging Face cache inside
// the worker folder. offline keeps faster-whisper from contacting the Hub at job time (the setup
// downloaded the model).
func workerEnv(dir string, offline bool) []string {
	libs, _ := filepath.Glob(filepath.Join(dir, "venv", "lib", "python3*", "site-packages", "nvidia", "*", "lib"))
	env := []string{}
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		switch {
		case k == "LD_LIBRARY_PATH":
			if v != "" {
				libs = append(libs, v)
			}
		case k == "HF_HOME" || k == "HF_HUB_OFFLINE":
			// set below
		case k == "PATH" || k == "HOME" || k == "LANG" || k == "TMPDIR" || k == "XDG_CACHE_HOME",
			strings.HasPrefix(k, "LC_"), strings.HasPrefix(k, "CUDA_"), strings.HasPrefix(k, "HF_"):
			env = append(env, kv)
		}
	}
	env = append(env, "HF_HOME="+filepath.Join(dir, "models", "hf"), "PYTHONUNBUFFERED=1")
	if len(libs) > 0 {
		env = append(env, "LD_LIBRARY_PATH="+strings.Join(libs, ":"))
	}
	if offline {
		env = append(env, "HF_HUB_OFFLINE=1")
	}
	return env
}

func defaultMeetingCommand(ctx context.Context, dir string) (*exec.Cmd, error) {
	if err := ensureWorkerFile(dir); err != nil {
		return nil, err
	}
	py := venvPython(dir)
	if _, err := os.Stat(py); err != nil {
		return nil, errors.New("the meeting worker is not set up on this machine; run `quorumd meetings setup`")
	}
	cmd := exec.CommandContext(ctx, py, "-u", filepath.Join(dir, "worker.py"))
	cmd.Dir = dir
	cmd.Env = workerEnv(dir, true)
	return cmd, nil
}

// meetingSupervisor runs at most one worker at a time for the whole daemon (it outlives hub links).
type meetingSupervisor struct {
	mu  sync.Mutex
	cur *meetingRun
}

// workerJob is what the worker reads on stdin.
type workerJob struct {
	proto.MeetingJobStart
	// WorkDir is the job's private folder (0700), created and removed by the daemon.
	WorkDir string `json:"workDir"`
}

var jobIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// sweepMeetingTmp removes the job folders left by workers that died with an earlier daemon.
func sweepMeetingTmp(dir string) {
	ents, err := os.ReadDir(filepath.Join(dir, "tmp"))
	if err != nil {
		return
	}
	for _, e := range ents {
		if err := os.RemoveAll(filepath.Join(dir, "tmp", e.Name())); err != nil {
			log.Printf("meetings: remove stale %s: %v", e.Name(), err)
		}
	}
}

// SweepMeetingTmp is sweepMeetingTmp for the daemon's start (no worker runs yet).
func SweepMeetingTmp() {
	if dir, err := MeetingsDir(); err == nil {
		sweepMeetingTmp(dir)
	}
}

type meetingRun struct {
	job  proto.MeetingJobStart
	ctx  context.Context // cancelled by kill: also stops the result upload
	work string
	// read once at start (tests change the package values)
	heartbeat time.Duration
	retries   int
	wait      time.Duration
	cancel    context.CancelFunc
	done      chan struct{}
	mu        sync.Mutex
	killed    bool // cancelled: no result is posted
}

func (r *meetingRun) kill() {
	r.mu.Lock()
	r.killed = true
	r.mu.Unlock()
	r.cancel()
}

func (r *meetingRun) wasKilled() bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.killed
}

var meetingJobs = &meetingSupervisor{}

var errMeetingBusy = errors.New("busy: another meeting job is running on this machine")

// start launches the job's worker and returns at once. The same attempt again is a no-op; a newer
// attempt of the running job replaces it (the hub re-queued it while this machine was away); any other
// job while one runs is refused as busy.
func (s *meetingSupervisor) start(hubURL, ollamaURL string, reg *Registry, job proto.MeetingJobStart) error {
	if !jobIDRe.MatchString(job.JobID) || job.Attempt < 1 || job.ResultURL == "" {
		return errors.New("invalid meeting job")
	}
	if job.Step == proto.MeetingStepTranscribeChunk {
		// chunk jobs go to the resident worker, never while a full job runs
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.cur != nil {
			return errMeetingBusy
		}
		return liveWorkers.run(hubURL, reg, job)
	}
	for {
		s.mu.Lock()
		cur := s.cur
		if cur == nil {
			break // keeps s.mu until the new run is registered
		}
		s.mu.Unlock()
		switch {
		case cur.job.JobID == job.JobID && cur.job.Attempt == job.Attempt:
			return nil
		case cur.job.JobID == job.JobID && cur.job.Attempt < job.Attempt:
			cur.kill()
			select {
			case <-cur.done:
			case <-time.After(5 * time.Second):
				return errMeetingBusy
			}
		default:
			return errMeetingBusy
		}
	}
	defer s.mu.Unlock()
	resultURL, err := resolveHubURL(hubURL, job.ResultURL)
	if err != nil {
		return err
	}
	in := workerJob{MeetingJobStart: job}
	in.ResultURL = "" // the worker never needs it: the daemon posts the result
	if job.AudioURL != "" {
		if in.AudioURL, err = resolveHubURL(hubURL, job.AudioURL); err != nil {
			return err
		}
	}
	if job.TranscriptURL != "" {
		if in.TranscriptURL, err = resolveHubURL(hubURL, job.TranscriptURL); err != nil {
			return err
		}
	}
	dir, err := MeetingsDir()
	if err != nil {
		return err
	}
	// a full job never runs beside the resident live worker (one GPU user at a time)
	liveWorkers.stop()
	// nothing runs now: whatever is left in tmp/ belongs to a worker that was killed with the daemon
	sweepMeetingTmp(dir)
	// the daemon owns the job's folder (the downloaded recording and its WAV files), so it is removed
	// whatever happens to the worker, even after a SIGKILL
	work := filepath.Join(dir, "tmp", fmt.Sprintf("%s-%d", job.JobID, job.Attempt))
	if err := os.MkdirAll(filepath.Dir(work), 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(work, 0o700); err != nil {
		return err
	}
	in.WorkDir = work
	ctx, cancel := context.WithCancel(context.Background())
	fail := func(err error) error {
		cancel()
		os.RemoveAll(work)
		return err
	}
	cmd, err := meetingCommand(ctx, dir)
	if err != nil {
		return fail(err)
	}
	if cmd.Env != nil {
		cmd.Env = append(cmd.Env, "TMPDIR="+work)
		if ollamaURL != "" {
			cmd.Env = append(cmd.Env, "QUORUM_OLLAMA_URL="+ollamaURL)
		}
	}
	stdin, _ := json.Marshal(in)
	cmd.Stdin = bytes.NewReader(stdin)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return fail(err)
	}
	stderr := &tailBuffer{max: 8 << 10}
	cmd.Stderr = stderr
	setProcessGroup(cmd)
	cmd.Cancel = func() error { return killProcessGroup(cmd) }
	cmd.WaitDelay = 5 * time.Second
	if err := cmd.Start(); err != nil {
		return fail(fmt.Errorf("could not start the meeting worker: %w", err))
	}
	run := &meetingRun{job: job, ctx: ctx, cancel: cancel, work: work, done: make(chan struct{}),
		heartbeat: meetingHeartbeat, retries: meetingPostRetries, wait: meetingPostWait}
	s.cur = run
	log.Printf("meetings: job %s attempt %d (%s) started", job.JobID, job.Attempt, job.Step)
	go s.supervise(run, cmd, stdout, stderr, reg, resultURL)
	return nil
}

// cancel kills the running worker of jobID (any attempt when attempt is 0); false when it is not running.
func (s *meetingSupervisor) cancelJob(jobID string, attempt int) bool {
	s.mu.Lock()
	cur := s.cur
	s.mu.Unlock()
	if cur == nil || cur.job.JobID != jobID || (attempt != 0 && cur.job.Attempt != attempt) {
		return false
	}
	cur.kill()
	<-cur.done
	return true
}

// shutdown kills the running worker and waits for it (the daemon is stopping).
func (s *meetingSupervisor) shutdown() {
	s.mu.Lock()
	cur := s.cur
	s.mu.Unlock()
	if cur != nil {
		cur.kill()
		<-cur.done
	}
}

// running returns the running job (tests and logs).
func (s *meetingSupervisor) running() (proto.MeetingJobStart, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cur == nil {
		return proto.MeetingJobStart{}, false
	}
	return s.cur.job, true
}

type workerLine struct {
	Type    string          `json:"type"`
	Pct     int             `json:"pct"`
	Stage   string          `json:"stage"`
	Message string          `json:"message"`
	Error   string          `json:"error"`
	Result  json.RawMessage `json:"result"`
	// JobID and Attempt tag the lines of the resident live worker.
	JobID   string `json:"jobId"`
	Attempt int    `json:"attempt"`
}

func (s *meetingSupervisor) supervise(run *meetingRun, cmd *exec.Cmd, stdout io.Reader, stderr *tailBuffer, reg *Registry, resultURL string) {
	defer close(run.done)
	defer func() {
		s.mu.Lock()
		if s.cur == run {
			s.cur = nil
		}
		s.mu.Unlock()
	}()
	defer run.cancel()
	job := run.job
	var (
		pmu  sync.Mutex
		last = proto.MeetingProgress{JobID: job.JobID, Attempt: job.Attempt, Stage: "starting"}
	)
	send := func() {
		pmu.Lock()
		p := last
		pmu.Unlock()
		if reg != nil {
			b, _ := json.Marshal(p)
			reg.EmitDroppable(proto.Envelope{Type: "meeting_progress", Machine: reg.machine, Payload: b})
		}
	}
	send()
	hbDone := make(chan struct{})
	go func() {
		t := time.NewTicker(run.heartbeat)
		defer t.Stop()
		for {
			select {
			case <-hbDone:
				return
			case <-t.C:
				send()
			}
		}
	}()
	var result json.RawMessage
	var workerErr string
	rd := bufio.NewReaderSize(stdout, 64<<10)
	for {
		line, err := readLine(rd, maxWorkerLine)
		if len(line) > 0 {
			var wl workerLine
			if json.Unmarshal(line, &wl) != nil {
				log.Printf("meetings: worker: %s", truncate(string(line), 300))
			} else {
				switch wl.Type {
				case "progress":
					pmu.Lock()
					last.Pct, last.Stage = wl.Pct, wl.Stage
					pmu.Unlock()
					send()
				case "log":
					log.Printf("meetings: job %s: %s", job.JobID, truncate(wl.Message, 500))
				case "result":
					result = wl.Result
				case "error":
					workerErr = wl.Error
				}
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Printf("meetings: job %s: reading the worker: %v", job.JobID, err)
			}
			break
		}
	}
	io.Copy(io.Discard, stdout) // a line that was too long: let the worker finish
	waitErr := cmd.Wait()
	close(hbDone)
	if err := os.RemoveAll(run.work); err != nil {
		log.Printf("meetings: remove %s: %v", run.work, err)
	}
	if run.wasKilled() {
		log.Printf("meetings: job %s attempt %d stopped", job.JobID, job.Attempt)
		return
	}
	var body proto.MeetingJobResult
	switch {
	case waitErr == nil && workerErr == "" && len(result) > 0:
		body.Result = result
	case workerErr != "":
		body.Error = workerErr
	default:
		msg := "the meeting worker stopped without a result"
		if waitErr != nil {
			msg = "the meeting worker failed (" + waitErr.Error() + ")"
		}
		if tail := stderr.lastLine(); tail != "" {
			msg += ": " + tail
		}
		body.Error = msg
	}
	if body.Error != "" {
		log.Printf("meetings: job %s attempt %d failed: %s", job.JobID, job.Attempt, truncate(body.Error, 500))
	} else {
		log.Printf("meetings: job %s attempt %d done", job.JobID, job.Attempt)
	}
	postMeetingResult(run.ctx, resultURL, body, run.retries, run.wait)
}

// readLine reads one '\n'-terminated line of at most max bytes (a longer line is an error).
func readLine(rd *bufio.Reader, max int) ([]byte, error) {
	var buf []byte
	for {
		chunk, err := rd.ReadSlice('\n')
		buf = append(buf, chunk...)
		if len(buf) > max {
			return nil, errors.New("worker output line too long")
		}
		if err == bufio.ErrBufferFull {
			continue
		}
		return bytes.TrimSpace(buf), err
	}
}

// postMeetingResult POSTs the result, retrying network errors and 5xx; 4xx answers are final (a stale
// attempt, an expired link, an invalid result).
func postMeetingResult(ctx context.Context, u string, body proto.MeetingJobResult, retries int, wait time.Duration) {
	b, _ := json.Marshal(body)
	client := &http.Client{Timeout: 2 * time.Minute}
	for i := 0; i < retries; i++ {
		if i > 0 {
			select {
			case <-time.After(wait):
			case <-ctx.Done():
				return // cancelled or the daemon is stopping
			}
			wait *= 2
		}
		req, err := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(b))
		if err != nil {
			return
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("meetings: post result: %v", withoutURL(err))
			continue
		}
		msg, _ := io.ReadAll(io.LimitReader(resp.Body, 1024))
		resp.Body.Close()
		switch {
		case resp.StatusCode < 300:
			return
		case resp.StatusCode < 500:
			log.Printf("meetings: the hub refused the result (%s): %s", resp.Status, strings.TrimSpace(string(msg)))
			return
		default:
			log.Printf("meetings: post result: %s", resp.Status)
		}
	}
}

// withoutURL drops the URL from a request error: the result URL carries the job's signed token, which
// never goes to the log.
func withoutURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return fmt.Errorf("%s: %w", ue.Op, ue.Err)
	}
	return err
}

// resolveHubURL resolves a URL relative to the hub (the hub sends paths) against its base URL. An
// absolute URL must point at the hub itself (same scheme and host): a job never sends the worker elsewhere.
func resolveHubURL(hub, ref string) (string, error) {
	r, err := url.Parse(ref)
	if err != nil {
		return "", err
	}
	base, err := url.Parse(strings.TrimRight(hub, "/") + "/")
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") {
		return "", errors.New("this machine has no hub URL")
	}
	if r.IsAbs() || r.Host != "" {
		if r.Scheme != base.Scheme || r.Host != base.Host {
			return "", errors.New("a meeting job URL that is not on the hub was refused")
		}
	}
	return base.ResolveReference(r).String(), nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// tailBuffer keeps the last max bytes written (the worker's stderr, for error messages).
type tailBuffer struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = append([]byte(nil), t.b[len(t.b)-t.max:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) lastLine() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	lines := strings.Split(strings.TrimSpace(string(t.b)), "\n")
	return truncate(strings.TrimSpace(lines[len(lines)-1]), 300)
}

func init() {
	rpcHandlers["meeting_job_start"] = func(ctx context.Context, h *Host, params json.RawMessage) (any, error) {
		var job proto.MeetingJobStart
		if err := json.Unmarshal(params, &job); err != nil {
			return nil, err
		}
		hub, ollama := "", ""
		if h != nil {
			hub, ollama = h.HubURL, h.OllamaURL
		}
		if err := meetingJobs.start(hub, ollama, linkOf(ctx).reg, job); err != nil {
			return nil, err
		}
		return map[string]bool{"ok": true}, nil
	}
	rpcHandlers["meeting_job_cancel"] = func(_ context.Context, _ *Host, params json.RawMessage) (any, error) {
		var c proto.MeetingJobCancel
		if err := json.Unmarshal(params, &c); err != nil {
			return nil, err
		}
		cancelled := meetingJobs.cancelJob(c.JobID, c.Attempt) || liveWorkers.cancelJob(c.JobID, c.Attempt)
		return map[string]bool{"cancelled": cancelled}, nil
	}
}

package daemon

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

// The resident live worker: `worker.py --live` takes one transcribe_chunk job per stdin line and tags every
// output line with the job's jobId and attempt, so Whisper is loaded once per live meeting. It lives under
// the daemon while chunks keep coming, exits after liveIdle without one, and never runs together with a
// full meeting job (the GPU turns on and off on demand, as it does for every other job).

var (
	// liveIdle: how long the resident worker waits for the next chunk before its stdin is closed.
	liveIdle = 5 * time.Minute
	// liveCommand builds the resident worker's command (replaced in tests by a fake script).
	liveCommand = defaultLiveCommand
	liveWorkers = &liveSupervisor{}
	// liveStopGrace: how long stop waits for the worker to exit after its stdin is closed.
	liveStopGrace = 5 * time.Second
)

func defaultLiveCommand(ctx context.Context, dir string) (*exec.Cmd, error) {
	cmd, err := defaultMeetingCommand(ctx, dir)
	if err != nil {
		return nil, err
	}
	cmd.Args = append(cmd.Args, "--live")
	return cmd, nil
}

// liveWorkDir is the one folder of the resident process (the worker mirrors the meeting's audio in it and
// fetches only new bytes), created when it starts and removed when it exits.
func liveWorkDir(dir string) string { return filepath.Join(dir, "tmp", "live") }

type liveSupervisor struct {
	mu   sync.Mutex
	proc *liveProc
	job  *liveJob // the chunk in flight
	wg   sync.WaitGroup
}

type liveProc struct {
	cmd     *exec.Cmd
	stdin   io.WriteCloser
	work    string
	cancel  context.CancelFunc
	done    chan struct{}
	idle    *time.Timer
	closing bool // stdin closed: the process is exiting and takes no more jobs
	stderr  *tailBuffer
}

type liveJob struct {
	job       proto.MeetingJobStart
	resultURL string
	reg       *Registry
	ctx       context.Context // cancelled by a cancel or the shutdown: also stops the result upload
	cancel    context.CancelFunc
	heartbeat time.Duration
	retries   int
	wait      time.Duration
	last      proto.MeetingProgress
	killed    bool
}

// run hands one chunk job to the resident worker (starting it when none runs) and returns at once. The same
// attempt again is a no-op, a newer attempt of the job in flight replaces it, and any other chunk while one
// is in flight is refused as busy.
func (s *liveSupervisor) run(hubURL string, reg *Registry, job proto.MeetingJobStart) error {
	if !jobIDRe.MatchString(job.JobID) || job.Attempt < 1 || job.ResultURL == "" {
		return errors.New("invalid meeting job")
	}
	s.mu.Lock()
	if cur := s.job; cur != nil {
		switch {
		case cur.job.JobID == job.JobID && cur.job.Attempt == job.Attempt:
			s.mu.Unlock()
			return nil
		case cur.job.JobID == job.JobID && cur.job.Attempt < job.Attempt:
			s.mu.Unlock()
			s.cancelJob(job.JobID, 0)
			s.mu.Lock()
			if s.job != nil {
				s.mu.Unlock()
				return errMeetingBusy
			}
		default:
			s.mu.Unlock()
			return errMeetingBusy
		}
	}
	defer s.mu.Unlock()
	resultURL, err := resolveHubURL(hubURL, job.ResultURL)
	if err != nil {
		return err
	}
	in := workerJob{MeetingJobStart: job}
	in.ResultURL = ""
	if job.AudioURL != "" {
		if in.AudioURL, err = resolveHubURL(hubURL, job.AudioURL); err != nil {
			return err
		}
	}
	dir, err := MeetingsDir()
	if err != nil {
		return err
	}
	for s.proc != nil && s.proc.closing {
		// an exiting process takes no job: wait for it, then start a fresh one
		p := s.proc
		s.mu.Unlock()
		<-p.done
		s.mu.Lock()
		if s.job != nil {
			return errMeetingBusy
		}
	}
	if s.proc == nil {
		if s.proc, err = s.startProc(dir); err != nil {
			return err
		}
	}
	p := s.proc
	if p.idle != nil {
		p.idle.Stop()
	}
	in.WorkDir = p.work
	line, _ := json.Marshal(in)
	ctx, cancel := context.WithCancel(context.Background())
	s.job = &liveJob{job: job, resultURL: resultURL, reg: reg, ctx: ctx, cancel: cancel,
		heartbeat: meetingHeartbeat, retries: meetingPostRetries, wait: meetingPostWait,
		last: proto.MeetingProgress{JobID: job.JobID, Attempt: job.Attempt, Stage: "starting"}}
	if _, err := p.stdin.Write(append(line, '\n')); err != nil {
		// the process is dying: whoever reads its end posts the error for this job
		log.Printf("meetings: live worker: write job %s: %v", job.JobID, err)
	}
	s.wg.Add(1)
	go s.heartbeat(s.job)
	log.Printf("meetings: live chunk %s attempt %d sent to the resident worker", job.JobID, job.Attempt)
	return nil
}

// startProc starts the resident process. s.mu is held.
func (s *liveSupervisor) startProc(dir string) (*liveProc, error) {
	work := liveWorkDir(dir)
	if err := os.MkdirAll(filepath.Dir(work), 0o700); err != nil {
		return nil, err
	}
	os.RemoveAll(work) // left by a worker that died with an earlier daemon
	if err := os.Mkdir(work, 0o700); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	fail := func(err error) (*liveProc, error) {
		cancel()
		os.RemoveAll(work)
		return nil, err
	}
	cmd, err := liveCommand(ctx, dir)
	if err != nil {
		return fail(err)
	}
	if cmd.Env != nil {
		cmd.Env = append(cmd.Env, "TMPDIR="+work)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return fail(err)
	}
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
		return fail(errors.New("could not start the live meeting worker: " + err.Error()))
	}
	p := &liveProc{cmd: cmd, stdin: stdin, work: work, cancel: cancel, done: make(chan struct{}), stderr: stderr}
	log.Printf("meetings: resident live worker started")
	go s.supervise(p, stdout)
	return p, nil
}

func (s *liveSupervisor) heartbeat(j *liveJob) {
	defer s.wg.Done()
	t := time.NewTicker(j.heartbeat)
	defer t.Stop()
	for {
		select {
		case <-j.ctx.Done():
			return
		case <-t.C:
			s.mu.Lock()
			p := j.last
			s.mu.Unlock()
			sendProgress(j.reg, p)
		}
	}
}

func sendProgress(reg *Registry, p proto.MeetingProgress) {
	if reg == nil {
		return
	}
	b, _ := json.Marshal(p)
	reg.EmitDroppable(proto.Envelope{Type: "meeting_progress", Machine: reg.machine, Payload: b})
}

// finish ends the chunk in flight if it is j, arms the idle timer and posts the body.
func (s *liveSupervisor) finish(p *liveProc, j *liveJob, body *proto.MeetingJobResult) {
	s.mu.Lock()
	if s.job != j {
		s.mu.Unlock()
		return
	}
	s.job = nil
	killed := j.killed
	if s.proc == p && !killed {
		p.idle = time.AfterFunc(liveIdle, func() { s.idleExpired(p) })
	}
	s.mu.Unlock()
	if killed || body == nil {
		j.cancel()
		return
	}
	if body.Error != "" {
		log.Printf("meetings: live chunk %s attempt %d failed: %s", j.job.JobID, j.job.Attempt, truncate(body.Error, 500))
	}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		postMeetingResult(j.ctx, j.resultURL, *body, j.retries, j.wait)
		j.cancel()
	}()
}

func (s *liveSupervisor) idleExpired(p *liveProc) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.proc == p && s.job == nil {
		log.Printf("meetings: resident live worker idle, closing it")
		p.closing = true
		p.stdin.Close()
	}
}

// supervise reads the resident worker's output until it exits.
func (s *liveSupervisor) supervise(p *liveProc, stdout io.Reader) {
	defer close(p.done)
	rd := bufio.NewReaderSize(stdout, 64<<10)
	for {
		line, err := readLine(rd, maxWorkerLine)
		if len(line) > 0 {
			s.handleLine(p, line)
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Printf("meetings: reading the live worker: %v", err)
			}
			break
		}
	}
	waitErr := p.cmd.Wait()
	p.cancel()
	s.mu.Lock()
	if p.idle != nil {
		p.idle.Stop()
	}
	// the folder goes before the slot is freed: a newer process reuses the same path
	if err := os.RemoveAll(p.work); err != nil {
		log.Printf("meetings: remove %s: %v", p.work, err)
	}
	if s.proc == p {
		s.proc = nil
	}
	j := s.job
	s.mu.Unlock()
	if j != nil {
		msg := "the meeting worker stopped without a result"
		if waitErr != nil {
			msg = "the meeting worker failed (" + waitErr.Error() + ")"
		}
		if tail := p.stderr.lastLine(); tail != "" {
			msg += ": " + tail
		}
		s.finish(p, j, &proto.MeetingJobResult{Error: msg})
	}
	log.Printf("meetings: resident live worker exited")
}

func (s *liveSupervisor) handleLine(p *liveProc, line []byte) {
	var wl workerLine
	if json.Unmarshal(line, &wl) != nil {
		log.Printf("meetings: live worker: %s", truncate(string(line), 300))
		return
	}
	s.mu.Lock()
	j := s.job
	if j != nil && (wl.JobID != j.job.JobID || wl.Attempt != j.job.Attempt) {
		j = nil
	}
	s.mu.Unlock()
	if wl.Type == "log" {
		log.Printf("meetings: live worker: %s", truncate(wl.Message, 500))
		return
	}
	if j == nil {
		return // a line of a job that was cancelled or replaced
	}
	switch wl.Type {
	case "progress":
		s.mu.Lock()
		j.last.Pct, j.last.Stage = wl.Pct, wl.Stage
		pr := j.last
		s.mu.Unlock()
		sendProgress(j.reg, pr)
	case "result":
		s.finish(p, j, &proto.MeetingJobResult{Result: wl.Result})
	case "error":
		s.finish(p, j, &proto.MeetingJobResult{Error: wl.Error})
	}
}

// cancelJob kills the resident worker when the job (any attempt when attempt is 0) is in flight, posting no
// result; false when it is not.
func (s *liveSupervisor) cancelJob(jobID string, attempt int) bool {
	s.mu.Lock()
	j, p := s.job, s.proc
	if j == nil || p == nil || j.job.JobID != jobID || (attempt != 0 && j.job.Attempt != attempt) {
		s.mu.Unlock()
		return false
	}
	j.killed = true
	j.cancel()
	s.mu.Unlock()
	killProcessGroup(p.cmd)
	<-p.done
	s.mu.Lock()
	if s.job == j {
		s.job = nil
	}
	s.mu.Unlock()
	return true
}

// stop ends the resident worker: it closes stdin, waits up to 5 s and then kills the process group. The
// folder goes with it.
func (s *liveSupervisor) stop() {
	s.mu.Lock()
	p := s.proc
	if p != nil {
		p.closing = true
		p.stdin.Close()
	}
	s.mu.Unlock()
	if p == nil {
		if dir, err := MeetingsDir(); err == nil {
			os.RemoveAll(liveWorkDir(dir))
		}
		return
	}
	select {
	case <-p.done:
	case <-time.After(liveStopGrace):
		killProcessGroup(p.cmd)
		<-p.done
	}
}

// shutdown stops the worker and abandons pending result uploads (the daemon is stopping).
func (s *liveSupervisor) shutdown() {
	s.mu.Lock()
	if j := s.job; j != nil {
		j.killed = true
		j.cancel()
	}
	p := s.proc
	s.mu.Unlock()
	if p != nil {
		killProcessGroup(p.cmd)
		<-p.done
	}
	s.wg.Wait()
}

package daemon

import (
	"archive/tar"
	"compress/bzip2"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	meetingworker "github.com/S-kkipie/quorum/worker/meetings"
)

// `quorumd meetings setup` installs the meeting worker on this machine: the venv with the pinned
// packages, ffmpeg (checked), the speaker models, the Whisper model, and a GPU check. Ollama is optional
// (only the local summary provider uses it); the setup only says how to install it.

const (
	setupWhisperModel = "large-v3-turbo"
	setupOllamaModel  = "gemma3:12b"
	setupOllamaURL    = "http://127.0.0.1:11434"
)

// diarModel is a speaker model from the sherpa-onnx releases, checked by its SHA-256.
type diarModel struct {
	url    string
	member string // inside a .tar.bz2 ("" = the file itself)
	file   string // under models/diarization
	sha256 string // of the file written
}

var diarModels = []diarModel{
	{
		url:    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2",
		member: "sherpa-onnx-pyannote-segmentation-3-0/model.onnx",
		file:   "pyannote-segmentation-3-0.onnx",
		sha256: "220ad67ca923bef2fa91f2390c786097bf305bceb5e261d4af67b38e938e1079",
	},
	{
		url:    "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_large.onnx",
		file:   "nemo_en_titanet_large.onnx",
		sha256: "d51abcf31717ef28162f26acb9d44dd4127c3d44c9b8624f699f3425daca8e77",
	},
}

// MeetingsSetup runs the setup, printing its steps to out.
func MeetingsSetup(ctx context.Context, out io.Writer) error {
	say := func(f string, a ...any) { fmt.Fprintf(out, f+"\n", a...) }
	if runtime.GOOS != "linux" {
		return errors.New("the meeting worker runs on Linux or WSL only")
	}
	dir, err := MeetingsDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	say("Meeting worker folder: %s", dir)
	// the machine stops advertising transcribe until the setup finishes again
	os.Remove(filepath.Join(dir, meetingsReadyFile))

	for _, tool := range []string{"ffmpeg", "ffprobe"} {
		if _, err := exec.LookPath(tool); err != nil {
			return fmt.Errorf("%s is missing: install it (e.g. `sudo apt install ffmpeg`) and run the setup again", tool)
		}
	}
	say("ffmpeg: found")

	if err := ensureWorkerFile(dir); err != nil {
		return err
	}
	reqs := filepath.Join(dir, "requirements.txt")
	if err := writeFileAtomic(reqs, meetingworker.Requirements, 0o644); err != nil {
		return err
	}
	if err := setupVenv(ctx, dir, reqs, out); err != nil {
		return err
	}

	mdir := filepath.Join(dir, "models", "diarization")
	for _, m := range diarModels {
		if err := ensureDiarModel(ctx, mdir, m, out); err != nil {
			return fmt.Errorf("speaker model %s: %w", m.file, err)
		}
	}

	say("Downloading the Whisper model %s (about 1.6 GB, once)…", setupWhisperModel)
	if err := runWorker(ctx, dir, out, false, "--download-model", setupWhisperModel); err != nil {
		return fmt.Errorf("the Whisper model could not be downloaded: %w", err)
	}

	say("Checking the GPU (5 s of test audio through %s)…", setupWhisperModel)
	ready := meetingsReady{CheckedAt: time.Now().UnixMilli(), Model: setupWhisperModel}
	cctx, cancel := context.WithTimeout(ctx, 5*time.Minute)
	b, err := workerOutput(cctx, dir, "--check-cuda")
	cancel()
	var check struct {
		CUDA  bool   `json:"cuda"`
		Error string `json:"error"`
	}
	if err != nil {
		ready.Error = err.Error()
	} else if jerr := json.Unmarshal(lastLine(b), &check); jerr != nil {
		ready.Error = "unexpected answer: " + strings.TrimSpace(string(b))
	} else {
		ready.CUDA, ready.Error = check.CUDA, check.Error
	}
	rb, _ := json.Marshal(ready)
	if err := writeFileAtomic(filepath.Join(dir, meetingsReadyFile), rb, 0o644); err != nil {
		return err
	}
	if !ready.CUDA {
		say("GPU check failed: %s", ready.Error)
		say("The worker is installed but this machine will not take meeting jobs until the check passes.")
		say("Check `nvidia-smi` (in WSL the Windows NVIDIA driver provides CUDA), then run the setup again.")
		return errors.New("no usable CUDA GPU")
	}
	say("GPU check passed.")

	ollamaAdvice(ctx, out)
	say("The meeting worker is ready. A running quorumd advertises transcribe to the hub within 30 s.")
	return nil
}

// setupVenv creates the venv (Python 3.12) and installs the pinned requirements, with uv when it is
// available and pip otherwise.
func setupVenv(ctx context.Context, dir, reqs string, out io.Writer) error {
	venv := filepath.Join(dir, "venv")
	py := venvPython(dir)
	uv, _ := exec.LookPath("uv")
	if uv == "" {
		if h, err := os.UserHomeDir(); err == nil {
			if p := filepath.Join(h, ".local", "bin", "uv"); fileExists(p) {
				uv = p
			}
		}
	}
	if !fileExists(py) {
		fmt.Fprintln(out, "Creating the Python 3.12 venv…")
		var cmd *exec.Cmd
		if uv != "" {
			cmd = exec.CommandContext(ctx, uv, "venv", "--python", "3.12", venv)
		} else {
			python, err := exec.LookPath("python3.12")
			if err != nil {
				return errors.New("Python 3.12 is missing: install it (e.g. `sudo apt install python3.12-venv`) or uv (https://docs.astral.sh/uv/), then run the setup again")
			}
			cmd = exec.CommandContext(ctx, python, "-m", "venv", venv)
		}
		cmd.Stdout, cmd.Stderr = out, out
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("could not create the venv: %w", err)
		}
	}
	fmt.Fprintln(out, "Installing faster-whisper, sherpa-onnx and the CUDA libraries (pinned, hash-checked)…")
	var cmd *exec.Cmd
	if uv != "" {
		cmd = exec.CommandContext(ctx, uv, "pip", "install", "--python", py, "--require-hashes", "-r", reqs)
	} else {
		cmd = exec.CommandContext(ctx, py, "-m", "pip", "install", "--require-hashes", "-r", reqs)
	}
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("could not install the worker's packages: %w", err)
	}
	return nil
}

func fileExists(p string) bool { _, err := os.Stat(p); return err == nil }

// runWorker runs worker.py with args in the venv, streaming its output.
func runWorker(ctx context.Context, dir string, out io.Writer, offline bool, args ...string) error {
	cmd := exec.CommandContext(ctx, venvPython(dir), append([]string{filepath.Join(dir, "worker.py")}, args...)...)
	cmd.Dir, cmd.Env = dir, workerEnv(dir, offline)
	cmd.Stdout, cmd.Stderr = out, out
	return cmd.Run()
}

// workerOutput runs worker.py with args (offline, the model is downloaded) and returns its stdout.
func workerOutput(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, venvPython(dir), append([]string{filepath.Join(dir, "worker.py")}, args...)...)
	cmd.Dir, cmd.Env = dir, workerEnv(dir, true)
	tail := &tailBuffer{max: 4 << 10}
	cmd.Stderr = tail
	b, err := cmd.Output()
	if err != nil {
		if l := tail.lastLine(); l != "" {
			return b, fmt.Errorf("%w: %s", err, l)
		}
	}
	return b, err
}

func lastLine(b []byte) []byte {
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	return []byte(lines[len(lines)-1])
}

// ensureDiarModel downloads a speaker model unless it is already there with the right checksum.
func ensureDiarModel(ctx context.Context, mdir string, m diarModel, out io.Writer) error {
	dest := filepath.Join(mdir, m.file)
	if sum, err := fileSHA256(dest); err == nil && sum == m.sha256 {
		fmt.Fprintf(out, "Speaker model %s: present\n", m.file)
		return nil
	}
	if err := os.MkdirAll(mdir, 0o755); err != nil {
		return err
	}
	fmt.Fprintf(out, "Downloading the speaker model %s…\n", m.file)
	req, err := http.NewRequestWithContext(ctx, "GET", m.url, nil)
	if err != nil {
		return err
	}
	resp, err := (&http.Client{Timeout: 30 * time.Minute}).Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download: %s", resp.Status)
	}
	return installModel(resp.Body, m, dest)
}

// installModel writes the model (the file itself, or one member of a .tar.bz2) to dest after checking its
// SHA-256; nothing else of the archive is written.
func installModel(r io.Reader, m diarModel, dest string) error {
	src := r
	if m.member != "" {
		tr := tar.NewReader(bzip2.NewReader(r))
		for {
			h, err := tr.Next()
			if errors.Is(err, io.EOF) {
				return fmt.Errorf("%s is not in the archive", m.member)
			}
			if err != nil {
				return err
			}
			if h.Typeflag == tar.TypeReg && path.Clean(h.Name) == m.member {
				src = tr
				break
			}
		}
	}
	tmp := dest + ".part"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	hs := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, hs), io.LimitReader(src, 1<<30))
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(tmp)
		return err
	}
	if got := hex.EncodeToString(hs.Sum(nil)); got != m.sha256 {
		os.Remove(tmp)
		return fmt.Errorf("checksum mismatch (got %s)", got)
	}
	return os.Rename(tmp, dest)
}

func fileSHA256(p string) (string, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// ollamaAdvice says whether Ollama and the default summary model are there, and how to get them.
func ollamaAdvice(ctx context.Context, out io.Writer) {
	cctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(cctx, "GET", setupOllamaURL+"/api/tags", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		if _, lerr := exec.LookPath("ollama"); lerr == nil {
			fmt.Fprintf(out, "Ollama is installed but not answering on %s: start it (`ollama serve`) to use the local summary provider.\n", setupOllamaURL)
			return
		}
		fmt.Fprintln(out, "Ollama is optional (only the local summary provider uses it). To install it:")
		fmt.Fprintln(out, "  curl -fsSL https://ollama.com/install.sh | sh")
		fmt.Fprintf(out, "  ollama pull %s\n", setupOllamaModel)
		return
	}
	defer resp.Body.Close()
	var tags struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	_ = json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&tags)
	for _, m := range tags.Models {
		if m.Name == setupOllamaModel {
			fmt.Fprintf(out, "Ollama: running, with %s.\n", setupOllamaModel)
			return
		}
	}
	fmt.Fprintf(out, "Ollama is running but %s is not pulled; for the local summary provider run: ollama pull %s\n", setupOllamaModel, setupOllamaModel)
}

// MeetingsStatus prints the worker's state (quorumd meetings status).
func MeetingsStatus(out io.Writer) {
	dir, _ := MeetingsDir()
	st := meetingWorkerState()
	if st == "" {
		st = "not set up (run `quorumd meetings setup`)"
	}
	fmt.Fprintf(out, "folder: %s\nstate: %s\n", dir, st)
	if b, err := os.ReadFile(filepath.Join(dir, meetingsReadyFile)); err == nil {
		fmt.Fprintf(out, "last check: %s\n", strings.TrimSpace(string(b)))
	}
}

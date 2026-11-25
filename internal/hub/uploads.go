package hub

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
)

// uploadMaxSize is the largest file a device may attach to a message (a variable for tests).
var uploadMaxSize int64 = 100 << 20

const (
	// uploadChunk is the size of each upload_chunk sent to the machine (the daemon's maximum).
	uploadChunk = 1 << 20
	// uploadKeep: the machines delete uploads after 30 days; the hub forgets them then too.
	uploadKeep    = 30 * 24 * time.Hour
	uploadNameMax = 1024
	uploadMimeMax = 200
)

// uploadMime keeps the media type of a Content-Type (lowercase, no parameters), or "" when unusable.
func uploadMime(ct string) string {
	mt := strings.ToLower(strings.TrimSpace(strings.SplitN(ct, ";", 2)[0]))
	if mt == "" || len(mt) > uploadMimeMax || !strings.Contains(mt, "/") || strings.ContainsAny(mt, " \t\r\n\"\\") {
		return ""
	}
	return mt
}

// uploadFail maps an error of the upload RPCs to the device's response.
func uploadFail(w http.ResponseWriter, err error) {
	var de daemonError
	switch {
	case errors.Is(err, errOffline):
		apiErr(w, 409, "machine is offline")
	case errors.Is(err, errTimeout):
		apiErr(w, 504, errTimeout.Error())
	case errors.As(err, &de) && string(de) == "file too large":
		apiErr(w, 413, "file too large")
	case errors.As(err, &de) && string(de) == "unknown method":
		apiErr(w, 501, "the machine's quorumd is too old to receive files; update it")
	case errors.As(err, &de):
		apiErr(w, 502, string(de))
	default:
		apiErr(w, 502, "error talking to the machine")
	}
}

// handleUpload streams POST /api/sessions/{id}/files?name=<name> (the raw file as body, its
// mime as Content-Type) to the session's machine in chunks, without holding the whole file, and
// records it as an upload of the session. A failure drops the partial file on the machine.
func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if strings.TrimSpace(name) == "" || len(name) > uploadNameMax || strings.ContainsRune(name, 0) {
		apiErr(w, 400, "invalid file name")
		return
	}
	if r.ContentLength > uploadMaxSize {
		apiErr(w, 413, "file too large")
		return
	}
	si, ok := s.target(w, r)
	if !ok {
		return
	}
	mime := uploadMime(r.Header.Get("Content-Type"))
	body := http.MaxBytesReader(w, r.Body, uploadMaxSize)
	ctx := r.Context()
	m := si.Machine
	begin := map[string]any{"name": name, "mime": mime}
	if r.ContentLength >= 0 {
		begin["size"] = r.ContentLength
	}
	var started struct {
		Token string `json:"token"`
		Path  string `json:"path"`
	}
	if err := s.hub.call(ctx, m, "upload_begin", begin, &started); err != nil {
		uploadFail(w, err)
		return
	}
	if started.Token == "" || !isAbsAnyOS(started.Path) {
		apiErr(w, 502, "error talking to the machine")
		return
	}
	done := false
	defer func() {
		if done {
			return
		}
		// the device or the machine went away: drop the partial file (best effort)
		actx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.hub.call(actx, m, "upload_abort", map[string]string{"token": started.Token}, nil)
	}()
	buf := make([]byte, uploadChunk)
	var off int64
	for {
		n, rerr := io.ReadFull(body, buf)
		if n > 0 {
			p := map[string]any{"token": started.Token, "offset": off, "data": base64.StdEncoding.EncodeToString(buf[:n])}
			if err := s.hub.call(ctx, m, "upload_chunk", p, nil); err != nil {
				uploadFail(w, err)
				return
			}
			off += int64(n)
		}
		if rerr == io.EOF || rerr == io.ErrUnexpectedEOF {
			break
		}
		if rerr != nil {
			var mbe *http.MaxBytesError
			if errors.As(rerr, &mbe) {
				apiErr(w, 413, "file too large")
			} else {
				apiErr(w, 400, "the upload was interrupted")
			}
			return
		}
	}
	var end struct {
		Path string `json:"path"`
		Name string `json:"name"`
		Size int64  `json:"size"`
	}
	if err := s.hub.call(ctx, m, "upload_end", map[string]string{"token": started.Token}, &end); err != nil {
		uploadFail(w, err)
		return
	}
	done = true // upload_end consumed the token either way
	if end.Path != started.Path || end.Size != off {
		apiErr(w, 502, "error talking to the machine")
		return
	}
	if end.Name == "" {
		end.Name = end.Path[strings.LastIndexAny(end.Path, `/\`)+1:]
	}
	u := store.Upload{SessionID: si.ID, Path: end.Path, Name: end.Name, Mime: mime, Size: end.Size}
	if err := s.st.AddUpload(u); err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	writeJSON(w, 200, map[string]any{"path": u.Path, "name": u.Name, "size": u.Size, "mime": u.Mime})
}

// uploadBase returns the folder of p and its file name when p is an upload recorded for the
// session: an absolute path with no "." or ".." segment. Otherwise ok is false.
func (s *Server) uploadBase(sid, p string) (base, file string, ok bool, err error) {
	if !isAbsAnyOS(p) || strings.ContainsRune(p, 0) {
		return "", "", false, nil
	}
	for _, seg := range strings.FieldsFunc(p, func(r rune) bool { return r == '/' || r == '\\' }) {
		if seg == "." || seg == ".." {
			return "", "", false, nil
		}
	}
	if _, found, err := s.st.UploadOf(sid, p); err != nil || !found {
		return "", "", false, err
	}
	i := strings.LastIndexAny(p, `/\`)
	if i <= 0 || i == len(p)-1 || (i == 2 && p[1] == ':') {
		return "", "", false, nil // never a file right in a root
	}
	return p[:i], p[i+1:], true, nil
}

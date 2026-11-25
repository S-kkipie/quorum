package hub

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// upFx: m1 implements the upload RPCs in memory (and file_read of the saved files); sessions
// s1 and s2 live on m1, s3 on m3 (never connected).
type upFx struct {
	*appFx
	mu      sync.Mutex
	calls   []string          // methods in order
	chunks  []int             // decoded size of each chunk
	offsets []int64           // offset of each chunk
	pending map[string][]byte // token -> bytes so far
	paths   map[string]string // token -> path
	files   map[string][]byte // saved files
	reads   []map[string]any
	n       int
	// chunkErr: the daemon's answer to the nth chunk (1-based), if set
	chunkErr   map[int]string
	beginParam map[string]any
}

func newUpFx(t *testing.T) *upFx {
	t.Helper()
	f := &upFx{appFx: newAppFx(t), pending: map[string][]byte{}, paths: map[string]string{}, files: map[string][]byte{}, chunkErr: map[int]string{}}
	fakeMachine(t, f.appFx, f.machTok, "m1", func(r proto.RPC) *proto.RPCResult {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.calls = append(f.calls, r.Method)
		var p struct {
			Token  string `json:"token"`
			Offset int64  `json:"offset"`
			Data   string `json:"data"`
			Name   string `json:"name"`
			Path   string `json:"path"`
			Base   string `json:"base"`
			Length int    `json:"length"`
		}
		_ = json.Unmarshal(r.Params, &p)
		switch r.Method {
		case "upload_begin":
			_ = json.Unmarshal(r.Params, &f.beginParam)
			f.n++
			tok := fmt.Sprintf("tok%d", f.n)
			path := fmt.Sprintf("/home/u/.cache/quorum/uploads/2026-11-25/abc%03d-%s", f.n, p.Name)
			f.pending[tok], f.paths[tok] = []byte{}, path
			return okResult(map[string]string{"token": tok, "path": path, "name": path[strings.LastIndex(path, "/")+1:]})
		case "upload_chunk":
			data, _ := base64.StdEncoding.DecodeString(p.Data)
			f.chunks = append(f.chunks, len(data))
			f.offsets = append(f.offsets, p.Offset)
			if e, ok := f.chunkErr[len(f.chunks)]; ok {
				return &proto.RPCResult{Error: e}
			}
			buf, ok := f.pending[p.Token]
			if !ok {
				return &proto.RPCResult{Error: "unknown upload"}
			}
			if int64(len(buf)) != p.Offset {
				return &proto.RPCResult{Error: "offset mismatch"}
			}
			f.pending[p.Token] = append(buf, data...)
			return okResult(map[string]int{"size": len(f.pending[p.Token])})
		case "upload_end":
			buf, ok := f.pending[p.Token]
			if !ok {
				return &proto.RPCResult{Error: "unknown upload"}
			}
			path := f.paths[p.Token]
			delete(f.pending, p.Token)
			f.files[path] = buf
			return okResult(map[string]any{"path": path, "name": path[strings.LastIndex(path, "/")+1:], "size": len(buf)})
		case "upload_abort":
			delete(f.pending, p.Token)
			return okResult(map[string]bool{"ok": true})
		case "file_read":
			var raw map[string]any
			_ = json.Unmarshal(r.Params, &raw)
			f.reads = append(f.reads, raw)
			data, ok := f.files[p.Path]
			if !ok {
				return &proto.RPCResult{Error: "does not exist"}
			}
			if p.Offset > int64(len(data)) {
				return &proto.RPCResult{Error: "invalid offset"}
			}
			end := min(p.Offset+int64(p.Length), int64(len(data)))
			return okResult(map[string]any{"data": base64.StdEncoding.EncodeToString(data[p.Offset:end]), "size": len(data), "eof": end >= int64(len(data))})
		}
		return &proto.RPCResult{Error: "unknown method"}
	})
	eventually(t, func() bool { return f.srv.hub.Connected("m1") })
	// onHello (which closes the sessions the hello does not list) runs under smu after attach
	f.srv.hub.smu.Lock()
	f.srv.hub.smu.Unlock() //nolint:staticcheck // a barrier
	for _, s := range []proto.SessionInfo{
		{ID: "s1", Machine: "m1", Root: "/work/proj", Cwd: "/work/proj", State: proto.StateIdle},
		{ID: "s2", Machine: "m1", Root: "/work/other", Cwd: "/work/other", State: proto.StateIdle},
		{ID: "s3", Machine: "m3", Root: "/work/x", Cwd: "/work/x", State: proto.StateIdle},
	} {
		require.NoError(t, f.st.UpsertSession(s))
	}
	return f
}

func (f *upFx) upload(t *testing.T, sid, name, mime string, body io.Reader, size int64) (int, map[string]any) {
	t.Helper()
	req, _ := http.NewRequest("POST", f.ts.URL+"/api/sessions/"+sid+"/files?name="+strings.ReplaceAll(name, " ", "%20"), body)
	req.Header.Set("Authorization", "Bearer "+f.devTok)
	if mime != "" {
		req.Header.Set("Content-Type", mime)
	}
	req.ContentLength = size
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func (f *upFx) callsOf(m string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		if c == m {
			n++
		}
	}
	return n
}

func TestUploadStreamsInChunks(t *testing.T) {
	f := newUpFx(t)
	data := make([]byte, 2*uploadChunk+777)
	_, _ = rand.Read(data)
	code, out := f.upload(t, "s1", "clip one.mp4", "video/mp4", bytes.NewReader(data), int64(len(data)))
	require.Equal(t, 200, code, out)
	path := out["path"].(string)
	require.Equal(t, "/home/u/.cache/quorum/uploads/2026-11-25/abc001-clip one.mp4", path)
	require.EqualValues(t, len(data), out["size"])
	require.Equal(t, "video/mp4", out["mime"])
	f.mu.Lock()
	require.Equal(t, []int{uploadChunk, uploadChunk, 777}, f.chunks)
	require.Equal(t, []int64{0, uploadChunk, 2 * uploadChunk}, f.offsets)
	require.True(t, bytes.Equal(data, f.files[path]), "the machine got exactly the bytes")
	require.Equal(t, "clip one.mp4", f.beginParam["name"])
	require.EqualValues(t, len(data), f.beginParam["size"])
	f.mu.Unlock()
	u, ok, err := f.st.UploadOf("s1", path)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "video/mp4", u.Mime)
	require.EqualValues(t, len(data), u.Size)
	_, ok, _ = f.st.UploadOf("s2", path)
	require.False(t, ok, "recorded only for its own session")
}

func TestUploadUnknownLengthStreams(t *testing.T) {
	f := newUpFx(t)
	data := bytes.Repeat([]byte("ab"), uploadChunk) // 2 MiB, chunked transfer
	code, out := f.upload(t, "s1", "a.txt", "text/plain; charset=utf-8", io.MultiReader(bytes.NewReader(data)), -1)
	require.Equal(t, 200, code, out)
	require.Equal(t, "text/plain", out["mime"])
	f.mu.Lock()
	defer f.mu.Unlock()
	require.NotContains(t, f.beginParam, "size")
	require.Equal(t, []int{uploadChunk, uploadChunk}, f.chunks)
}

func TestUploadSizeCap(t *testing.T) {
	old := uploadMaxSize
	uploadMaxSize = 3 << 20
	t.Cleanup(func() { uploadMaxSize = old })
	f := newUpFx(t)
	// a declared size over the cap never reaches the machine
	data := make([]byte, 3<<20+1)
	code, _ := f.upload(t, "s1", "big.bin", "", bytes.NewReader(data), int64(len(data)))
	require.Equal(t, 413, code)
	require.Zero(t, f.callsOf("upload_begin"))
	// an undeclared size over the cap is cut and the partial file dropped
	code, _ = f.upload(t, "s1", "big.bin", "", io.MultiReader(bytes.NewReader(data)), -1)
	require.Equal(t, 413, code)
	eventually(t, func() bool { return f.callsOf("upload_abort") == 1 })
	require.Zero(t, f.callsOf("upload_end"))
	_, ok, _ := f.st.UploadOf("s1", "/home/u/.cache/quorum/uploads/2026-11-25/abc001-big.bin")
	require.False(t, ok)
}

func TestUploadOfflineMachine409(t *testing.T) {
	f := newUpFx(t)
	code, out := f.upload(t, "s3", "a.txt", "text/plain", strings.NewReader("abc"), 3)
	require.Equal(t, 409, code)
	require.Equal(t, "machine is offline", out["error"])
	code, _ = f.upload(t, "nope", "a.txt", "text/plain", strings.NewReader("abc"), 3)
	require.Equal(t, 404, code)
	code, _ = f.upload(t, "s1", "", "text/plain", strings.NewReader("abc"), 3)
	require.Equal(t, 400, code)
}

func TestUploadChunkFailureAborts(t *testing.T) {
	f := newUpFx(t)
	f.chunkErr[2] = "could not write the file"
	data := make([]byte, 2*uploadChunk)
	code, out := f.upload(t, "s1", "a.bin", "", bytes.NewReader(data), int64(len(data)))
	require.Equal(t, 502, code)
	require.Equal(t, "could not write the file", out["error"])
	eventually(t, func() bool { return f.callsOf("upload_abort") == 1 })
	require.Zero(t, f.callsOf("upload_end"))
	f.mu.Lock()
	require.Empty(t, f.pending, "the partial upload is dropped")
	f.mu.Unlock()
}

// a device that goes away mid-upload: the partial file is dropped on the machine
func TestUploadClientGoneAborts(t *testing.T) {
	f := newUpFx(t)
	pr, pw := io.Pipe()
	done := make(chan struct{})
	go func() {
		defer close(done)
		req, _ := http.NewRequest("POST", f.ts.URL+"/api/sessions/s1/files?name=a.bin", pr)
		req.Header.Set("Authorization", "Bearer "+f.devTok)
		req.ContentLength = 3 * uploadChunk
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
		}
	}()
	_, _ = pw.Write(make([]byte, uploadChunk+10))
	eventually(t, func() bool { return f.callsOf("upload_chunk") == 1 })
	pw.CloseWithError(fmt.Errorf("gone"))
	<-done
	eventually(t, func() bool { return f.callsOf("upload_abort") == 1 })
	require.Zero(t, f.callsOf("upload_end"))
	require.True(t, f.srv.hub.Connected("m1"), "the machine link survives the device going away")
}

func (f *upFx) view(t *testing.T, sid, path string) (int, string) {
	t.Helper()
	code, body := f.do("POST", "/api/machines/m1/views", string(mustJSON(map[string]any{"sessionId": sid, "path": path, "upload": true})))
	if code != 200 {
		return code, body
	}
	var out struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	return code, out.URL
}

func TestUploadViewLinkOnlyForRecordedUploads(t *testing.T) {
	f := newUpFx(t)
	pdf := []byte("%PDF-1.4 hello")
	code, out := f.upload(t, "s1", "doc.pdf", "application/pdf", bytes.NewReader(pdf), int64(len(pdf)))
	require.Equal(t, 200, code, out)
	mine := out["path"].(string)
	code, out = f.upload(t, "s2", "other.png", "image/png", strings.NewReader("PNG"), 3)
	require.Equal(t, 200, code, out)
	theirs := out["path"].(string)
	f.mu.Lock()
	f.files["/home/u/.cache/quorum/uploads/2026-11-25/zzz999-x.txt"] = []byte("secret")
	f.mu.Unlock()

	code, u := f.view(t, "s1", mine)
	require.Equal(t, 200, code, u)
	require.Equal(t, "/v/", u[:3])
	require.True(t, strings.HasSuffix(u, "/abc001-doc.pdf"), u)
	cl := &http.Client{}
	resp, err := cl.Get(f.ts.URL + u)
	require.NoError(t, err)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "application/pdf", resp.Header.Get("Content-Type"))
	require.Equal(t, pdf, body)
	f.mu.Lock()
	require.Equal(t, "/home/u/.cache/quorum/uploads/2026-11-25", f.reads[0]["base"])
	require.NotContains(t, f.reads[0], "imageOnly", "an upload may be any type")
	f.mu.Unlock()
	// the link serves that one file, not its neighbours
	tok := strings.Split(u, "/")[2]
	resp, err = cl.Get(f.ts.URL + "/v/" + tok + "/zzz999-x.txt")
	require.NoError(t, err)
	resp.Body.Close()
	require.Equal(t, 403, resp.StatusCode)

	// another session's upload, an unrecorded file, a path outside, a traversal: refused
	for _, p := range []string{theirs, "/home/u/.cache/quorum/uploads/2026-11-25/zzz999-x.txt", "/etc/passwd",
		"/home/u/.cache/quorum/uploads/2026-11-25/../2026-11-25/abc001-doc.pdf", "abc001-doc.pdf"} {
		code, body := f.view(t, "s1", p)
		require.Equal(t, 403, code, p+" "+body)
	}
	// an upload flag mixed with another mode is refused
	code, _ = f.do("POST", "/api/machines/m1/views", string(mustJSON(map[string]any{"sessionId": "s1", "path": mine, "upload": true, "read": true})))
	require.Equal(t, 403, code)
	// s2 sees its own
	code, _ = f.view(t, "s2", theirs)
	require.Equal(t, 200, code)
}

func TestUploadsPruned(t *testing.T) {
	f := newUpFx(t)
	code, out := f.upload(t, "s1", "a.png", "image/png", strings.NewReader("PNG"), 3)
	require.Equal(t, 200, code, out)
	p := out["path"].(string)
	n, err := f.st.PruneUploads(time.Now().Add(-uploadKeep).UnixMilli())
	require.NoError(t, err)
	require.Zero(t, n)
	n, err = f.st.PruneUploads(time.Now().Add(time.Minute).UnixMilli())
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	_, ok, _ := f.st.UploadOf("s1", p)
	require.False(t, ok)
}

func TestUploadVideoRange(t *testing.T) {
	f := newUpFx(t)
	data := make([]byte, uploadChunk+100)
	_, _ = rand.Read(data)
	code, out := f.upload(t, "s1", "v.mp4", "video/mp4", bytes.NewReader(data), int64(len(data)))
	require.Equal(t, 200, code, out)
	code, u := f.view(t, "s1", out["path"].(string))
	require.Equal(t, 200, code, u)
	get := func(rng string) (*http.Response, []byte) {
		req, _ := http.NewRequest("GET", f.ts.URL+u, nil)
		if rng != "" {
			req.Header.Set("Range", rng)
		}
		resp, err := http.DefaultClient.Do(req)
		require.NoError(t, err)
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return resp, b
	}
	resp, b := get("")
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "video/mp4", resp.Header.Get("Content-Type"))
	require.Equal(t, "bytes", resp.Header.Get("Accept-Ranges"))
	require.Equal(t, data, b)
	resp, b = get("bytes=10-19")
	require.Equal(t, 206, resp.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes 10-19/%d", len(data)), resp.Header.Get("Content-Range"))
	require.Equal(t, data[10:20], b)
	resp, b = get(fmt.Sprintf("bytes=%d-", uploadChunk-5))
	require.Equal(t, 206, resp.StatusCode)
	require.Equal(t, data[uploadChunk-5:], b)
	resp, _ = get(fmt.Sprintf("bytes=%d-", len(data)+10))
	require.Equal(t, 416, resp.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes */%d", len(data)), resp.Header.Get("Content-Range"))
	resp, _ = get(fmt.Sprintf("bytes=%d-", len(data)))
	require.Equal(t, 416, resp.StatusCode)
	require.Equal(t, fmt.Sprintf("bytes */%d", len(data)), resp.Header.Get("Content-Range"))
}

// a device that stops sending: the read deadline ends the request and the partial file is dropped
func TestUploadStalledClientTimesOut(t *testing.T) {
	old := uploadReadWait
	uploadReadWait = 300 * time.Millisecond
	t.Cleanup(func() { uploadReadWait = old })
	f := newUpFx(t)
	pr, pw := io.Pipe()
	t.Cleanup(func() { pw.Close() })
	go func() {
		req, _ := http.NewRequest("POST", f.ts.URL+"/api/sessions/s1/files?name=a.bin", pr)
		req.Header.Set("Authorization", "Bearer "+f.devTok)
		req.ContentLength = 2 * uploadChunk
		if resp, err := http.DefaultClient.Do(req); err == nil {
			resp.Body.Close()
		}
	}()
	// more than the client's write buffer, so the request surely reaches the hub
	_, _ = pw.Write(make([]byte, 64<<10))
	eventually(t, func() bool { return f.callsOf("upload_begin") == 1 })
	eventually(t, func() bool { return f.callsOf("upload_abort") == 1 })
	require.Zero(t, f.callsOf("upload_end"))
	require.True(t, f.srv.hub.Connected("m1"), "the machine link survives the device going away")
}

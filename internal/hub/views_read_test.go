package hub

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// Images Claude read with the Read tool: a view link that serves exactly that one file, only
// when the session's own events show a Read of that exact path.

var readSeq int

// readEvent stores a tool_start of tool on p and, unless end is "none", its tool_end (ok unless end is "denied").
func (vf *viewFx) readEvent(t *testing.T, sid, tool, p string, end ...string) {
	t.Helper()
	readSeq++
	id := fmt.Sprintf("toolu_%d", readSeq)
	_, err := vf.st.AppendEvent(proto.Event{Session: sid, Kind: proto.KindToolStart,
		Data: mustJSON(proto.ToolStart{ID: id, Name: tool, Summary: p, Input: mustJSON(map[string]string{"file_path": p})})})
	require.NoError(t, err)
	if len(end) > 0 && end[0] == "none" {
		return
	}
	_, err = vf.st.AppendEvent(proto.Event{Session: sid, Kind: proto.KindToolEnd,
		Data: mustJSON(proto.ToolEnd{ID: id, OK: len(end) == 0 || end[0] != "denied", MS: 1})})
	require.NoError(t, err)
}

func (vf *viewFx) readLink(t *testing.T, m, sid, p string) (int, string) {
	t.Helper()
	return vf.do("POST", "/api/machines/"+m+"/views", string(mustJSON(map[string]any{"sessionId": sid, "path": p, "read": true})))
}

func newReadFx(t *testing.T) *viewFx {
	t.Helper()
	vf := newViewFx(t)
	require.NoError(t, vf.st.UpsertSession(proto.SessionInfo{ID: "s2", Machine: "m1", Root: "/work/proj", Cwd: "/work/proj", State: proto.StateIdle}))
	require.NoError(t, vf.st.UpsertSession(proto.SessionInfo{ID: "o1", Machine: "m2", Root: "/work/proj", Cwd: "/work/proj", State: proto.StateIdle}))
	return vf
}

func readURL(t *testing.T, body string) string {
	t.Helper()
	var out struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	return out.URL
}

func TestViewReadLinkAndServe(t *testing.T) {
	vf := newReadFx(t)
	vf.readEvent(t, "s1", "Read", "/home/u/Pictures/shot.PNG")
	vf.put("/home/u/Pictures/shot.PNG", []byte("IMG"))
	code, body := vf.readLink(t, "m1", "s1", "/home/u/Pictures/shot.PNG")
	require.Equal(t, 200, code, body)
	u := readURL(t, body)
	require.Regexp(t, `^/v/[0-9a-f]{32}/shot\.PNG$`, u)
	resp, got := vf.get(t, u)
	require.Equal(t, 200, resp.StatusCode, got)
	requireViewHeaders(t, resp)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.Equal(t, "IMG", got)
	vf.mu.Lock()
	defer vf.mu.Unlock()
	require.Equal(t, "/home/u/Pictures", vf.reads[0]["base"])
	require.Equal(t, "/home/u/Pictures/shot.PNG", vf.reads[0]["path"])
	require.Equal(t, true, vf.reads[0]["imageOnly"])
}

func TestViewReadRefused(t *testing.T) {
	vf := newReadFx(t)
	for _, p := range []string{"/work/proj/.env", "/work/proj/a.ts", "/work/proj/b.png", "/home/u/.ssh/x.png",
		"/work/proj/../../etc/x.png", "/work/proj/./c.png", "work/proj/rel.png", "/work/proj/n.png\x00.txt", "/work/proj/s2.png", "/work/proj/w.png"} {
		vf.readEvent(t, "s1", "Read", p)
	}
	vf.readEvent(t, "s2", "Read", "/work/proj/other.png") // read in another session
	vf.readEvent(t, "o1", "Read", "/work/proj/m2.png")    // read on another machine
	vf.readEvent(t, "s1", "Write", "/work/proj/written.png")
	vf.readEvent(t, "s1", "Read", "/work/proj/denied.png", "denied") // the owner denied the Read
	vf.readEvent(t, "s1", "Read", "/work/proj/pending.png", "none")  // no tool_end
	for _, c := range []struct{ m, sid, p string }{
		{"m1", "s1", "/work/proj/never.png"},       // never read
		{"m1", "s1", "/work/proj/.env"},            // read, not an image
		{"m1", "s1", "/work/proj/a.ts"},            // read, not an image
		{"m1", "s1", "/home/u/.ssh/x.png"},         // denylisted
		{"m1", "s1", "/work/proj/../../etc/x.png"}, // traversal, even though read
		{"m1", "s1", "/work/proj/./c.png"},         // dot segment
		{"m1", "s1", "work/proj/rel.png"},          // relative
		{"m1", "s1", "/work/proj/n.png\x00.txt"},   // NUL
		{"m1", "s1", "/work/proj/other.png"},       // read in another session
		{"m1", "s1", "/work/proj/m2.png"},          // read on another machine's session
		{"m1", "o1", "/work/proj/m2.png"},          // that session is not on m1
		{"m1", "s1", "/work/proj/written.png"},     // written, not read
		{"m1", "s1", "/work/proj/denied.png"},      // denied Read
		{"m1", "s1", "/work/proj/pending.png"},     // Read with no tool_end
		{"m1", "s1", "/work/proj/B.png"},           // not the exact path
		{"m1", "s1", ""},
	} {
		code, body := vf.readLink(t, c.m, c.sid, c.p)
		require.NotEqual(t, 200, code, c.p)
		if c.sid != "o1" {
			require.Equal(t, 403, code, c.p)
			require.Contains(t, body, "This image is not available.", c.p)
		}
	}
	// images and read together is not a mode
	code, _ := vf.do("POST", "/api/machines/m1/views", string(mustJSON(map[string]any{"sessionId": "s1", "path": "/work/proj/b.png", "read": true, "images": true})))
	require.Equal(t, 403, code)
	vf.mu.Lock()
	defer vf.mu.Unlock()
	require.Empty(t, vf.reads)
}

// The link serves only the image it was made for: no sibling, no traversal out of dir(path).
func TestViewReadLinkServesOnlyItsFile(t *testing.T) {
	vf := newReadFx(t)
	vf.readEvent(t, "s1", "Read", "/work/proj/img/a.png")
	vf.readEvent(t, "s1", "Read", "/work/proj/img/b.png")
	vf.put("/work/proj/img/a.png", []byte("one"))
	vf.put("/work/proj/img/b.png", []byte("two"))
	vf.put("/work/proj/.env", []byte("SECRET"))
	code, body := vf.readLink(t, "m1", "s1", "/work/proj/img/a.png")
	require.Equal(t, 200, code, body)
	tok := strings.Split(readURL(t, body), "/")[2]
	for _, p := range []string{"/b.png", "/", "", "/../.env", "/%2e%2e/.env", "/x/../b.png", "/a.png/x"} {
		resp, got := vf.get(t, "/v/"+tok+p)
		require.Equal(t, 403, resp.StatusCode, p)
		require.Contains(t, got, "This image is not available.", p)
		require.NotContains(t, got, "two", p)
		require.NotContains(t, got, "SECRET", p)
	}
	vf.mu.Lock()
	require.Empty(t, vf.reads)
	vf.mu.Unlock()
	resp, got := vf.get(t, "/v/"+tok+"/a.png")
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "one", got)
}

// A read image that is a symbolic link leading out of its folder: the daemon's containment
// against base = dir(path) refuses it, and the hub maps that to 403.
func TestViewReadSymlinkEscapeIs403(t *testing.T) {
	vf := newReadFx(t)
	vf.readEvent(t, "s1", "Read", "/work/proj/img/link.png")
	vf.mu.Lock()
	vf.fail["/work/proj/img/link.png"] = "outside the project folder"
	vf.mu.Unlock()
	code, body := vf.readLink(t, "m1", "s1", "/work/proj/img/link.png")
	require.Equal(t, 200, code, body)
	resp, got := vf.get(t, readURL(t, body))
	require.Equal(t, 403, resp.StatusCode, got)
	require.Contains(t, got, "This image is not available.")
	vf.mu.Lock()
	defer vf.mu.Unlock()
	require.Equal(t, "/work/proj/img", vf.reads[0]["base"])
}

// Windows paths keep their separators; the base is the folder.
func TestViewReadWindowsPath(t *testing.T) {
	vf := newReadFx(t)
	p := `C:\Users\u\Desktop\shot.jpg`
	vf.readEvent(t, "s1", "Read", p)
	vf.put(p, []byte("JPG"))
	code, body := vf.readLink(t, "m1", "s1", p)
	require.Equal(t, 200, code, body)
	require.Regexp(t, `^/v/[0-9a-f]{32}/shot\.jpg$`, readURL(t, body))
}

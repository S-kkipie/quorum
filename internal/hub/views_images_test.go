package hub

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// Plan 6 Task 10: view links for the images the owner pasted into a session in the terminal.
// Session s1 lives in /work/proj (cwd /work/proj/sub); Claude Code keeps its pasted images in
// /tmp/claude-1000/-work-proj/s1/images, which the mod reports as imagesDir.
const (
	s1Images = "/tmp/claude-1000/-work-proj/s1/images"
	s2Images = "/tmp/claude-1000/-work-proj/s2/images"
)

func newImagesFx(t *testing.T) *viewFx {
	t.Helper()
	vf := newViewFx(t)
	require.NoError(t, vf.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", Root: "/work/proj", Cwd: "/work/proj/sub", State: proto.StateIdle, ImagesDir: s1Images}))
	require.NoError(t, vf.st.UpsertSession(proto.SessionInfo{ID: "s2", Machine: "m1", Root: "/work/proj", Cwd: "/work/proj", State: proto.StateIdle, ImagesDir: s2Images}))
	return vf
}

func (vf *viewFx) imageLink(t *testing.T, sid, p string) (int, string) {
	t.Helper()
	return vf.do("POST", "/api/machines/m1/views", string(mustJSON(map[string]any{"sessionId": sid, "path": p, "images": true})))
}

func TestViewImagesLinkAndServe(t *testing.T) {
	vf := newImagesFx(t)
	vf.put(s1Images+"/1.png", []byte("PNG1"))
	code, body := vf.imageLink(t, "s1", s1Images+"/1.png")
	require.Equal(t, 200, code, body)
	var out struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	require.Regexp(t, `^/v/[0-9a-f]{32}/1\.png$`, out.URL)
	resp, got := vf.get(t, out.URL)
	require.Equal(t, 200, resp.StatusCode)
	requireViewHeaders(t, resp)
	require.Equal(t, "image/png", resp.Header.Get("Content-Type"))
	require.Equal(t, "PNG1", got)
	vf.mu.Lock()
	defer vf.mu.Unlock()
	require.Equal(t, s1Images, vf.reads[0]["base"])
	require.Equal(t, s1Images+"/1.png", vf.reads[0]["path"])
	// the cwd-named folder is Claude Code's other choice: also accepted
	require.NoError(t, vf.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", Root: "/work/proj", Cwd: "/work/proj/sub", State: proto.StateIdle,
		ImagesDir: "/var/tmp/claude-501/-work-proj-sub/s1/images"}))
	code, body = vf.imageLink(t, "s1", "/var/tmp/claude-501/-work-proj-sub/s1/images/12.jpeg")
	require.Equal(t, 200, code, body)
}

func TestViewImagesRefusedOutsideTheSessionImages(t *testing.T) {
	vf := newImagesFx(t)
	for _, p := range []string{
		s2Images + "/1.png",                          // another session's images
		s1Images + "/../../s2/images/1.png",          // traversal into another session
		s1Images + "/../../../../../etc/passwd",      // traversal out
		s1Images + "/%2e%2e/1.png",                   // an odd name, not an image
		s1Images,                                     // the folder itself
		s1Images + "/sub/1.png",                      // nested
		s1Images + "/1.sh",                           // not an image
		s1Images + "/a.png",                          // not a pasted image name
		s1Images + "/1.png\x00.txt",                  // NUL
		"/tmp/claude-1000/-work-proj/s1/1.png",       // above images/
		"/work/proj/a.png",                           // the project: not in images mode
		"tmp/claude-1000/-work-proj/s1/images/1.png", // relative
		"",
	} {
		code, body := vf.imageLink(t, "s1", p)
		require.Equal(t, 403, code, p)
		require.Contains(t, body, "This image is not available.", p)
	}
	vf.mu.Lock()
	defer vf.mu.Unlock()
	require.Empty(t, vf.reads)
}

func TestViewImagesNeedAReportedImagesDirOfThisSession(t *testing.T) {
	vf := newImagesFx(t)
	for _, dir := range []string{
		"",                                       // the mod did not report one
		"/",                                      // a whole disk
		"/home/u",                                // a home folder
		"/work/proj",                             // the project
		s2Images,                                 // another session's id
		"/tmp/claude-1000/-other-proj/s1/images", // not named after root or cwd
		"/tmp/claude-x/-work-proj/s1/images",     // not claude-<uid>
		"/tmp/claude-1000/-work-proj/s1/images/..", // traversal in the reported folder
		"/tmp/claude-1000/-work-proj/s1/../s1/images",
		"claude-1000/-work-proj/s1/images", // relative
	} {
		require.NoError(t, vf.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", Root: "/work/proj", Cwd: "/work/proj/sub", State: proto.StateIdle, ImagesDir: dir}))
		vf.put(dir+"/1.png", []byte("x"))
		code, body := vf.imageLink(t, "s1", strings.TrimRight(dir, "/")+"/1.png")
		require.Equal(t, 403, code, dir+" "+body)
	}
	vf.mu.Lock()
	defer vf.mu.Unlock()
	require.Empty(t, vf.reads)
}

// An images link serves only the image it was made for: no sibling, no traversal.
func TestViewImagesLinkServesOnlyItsFile(t *testing.T) {
	vf := newImagesFx(t)
	vf.put(s1Images+"/1.png", []byte("one"))
	vf.put(s1Images+"/2.png", []byte("two"))
	vf.put(s2Images+"/1.png", []byte("other"))
	code, body := vf.imageLink(t, "s1", s1Images+"/1.png")
	require.Equal(t, 200, code, body)
	var out struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	tok := strings.Split(out.URL, "/")[2]
	for _, p := range []string{"/2.png", "/", "", "/../../s2/images/1.png", "/%2e%2e/%2e%2e/s2/images/1.png", "/x/../2.png", "/1.png/x"} {
		resp, got := vf.get(t, "/v/"+tok+p)
		require.Equal(t, 403, resp.StatusCode, p)
		require.Contains(t, got, "This image is not available.", p)
		requireViewHeaders(t, resp)
		require.NotContains(t, got, "two", p)
		require.NotContains(t, got, "other", p)
	}
	vf.mu.Lock()
	require.Empty(t, vf.reads)
	vf.mu.Unlock()
	resp, got := vf.get(t, "/v/"+tok+"/./1.png")
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "one", got)
}

// A symbolic link in the images folder that leads out is refused by the daemon (EvalSymlinks
// containment against the images folder as base): the hub maps it to 403.
func TestViewImagesSymlinkEscapeIs403(t *testing.T) {
	vf := newImagesFx(t)
	vf.mu.Lock()
	vf.fail[s1Images+"/3.png"] = "outside the project folder"
	vf.mu.Unlock()
	code, body := vf.imageLink(t, "s1", s1Images+"/3.png")
	require.Equal(t, 200, code, body)
	var out struct {
		URL string `json:"url"`
	}
	require.NoError(t, json.Unmarshal([]byte(body), &out))
	resp, got := vf.get(t, out.URL)
	require.Equal(t, 403, resp.StatusCode, got)
	require.Contains(t, got, "This image is not available.")
	vf.mu.Lock()
	defer vf.mu.Unlock()
	require.Equal(t, s1Images, vf.reads[0]["base"])
}

// The plain mode is unchanged: images:false (or absent) keeps the project base.
func TestViewImagesFlagOffKeepsProjectBase(t *testing.T) {
	vf := newImagesFx(t)
	code, _ := vf.do("POST", "/api/machines/m1/views", string(mustJSON(map[string]any{"sessionId": "s1", "path": s1Images + "/1.png"})))
	require.Equal(t, 403, code)
	code, _ = vf.do("POST", "/api/machines/m1/views", string(mustJSON(map[string]any{"sessionId": "s1", "path": "/work/proj/a.html", "images": false})))
	require.Equal(t, 200, code)
}

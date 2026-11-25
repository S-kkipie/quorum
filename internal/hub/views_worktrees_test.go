package hub

import (
	"strings"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// withWorktrees re-registers s1 (root /work/proj) with the given git worktrees.
func (vf *viewFx) withWorktrees(t *testing.T, wts ...string) {
	t.Helper()
	require.NoError(t, vf.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", Root: "/work/proj", Cwd: "/work/proj/sub",
		State: proto.StateIdle, Worktrees: wts}))
}

func (vf *viewFx) statCalls() int {
	vf.mu.Lock()
	defer vf.mu.Unlock()
	return len(vf.stats)
}

func TestViewAbsolutePathInWorktree(t *testing.T) {
	vf := newViewFx(t)
	vf.withWorktrees(t, "/work/proj", "/work/proj-rewrite")
	vf.put("/work/proj-rewrite/docs/decisions/x.md", []byte("rewrite"))
	vf.put("/work/proj-rewrite/docs/decisions/y.md", []byte("sibling"))
	u := vf.link(t, "/work/proj-rewrite/docs/decisions/x.md")
	require.Regexp(t, `^/v/[0-9a-f]{32}/docs/decisions/x\.md$`, u)
	resp, body := vf.get(t, u)
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "rewrite", body)
	// the link's base is the worktree: its siblings are served from there too
	tok := strings.Split(u, "/")[2]
	_, body = vf.get(t, "/v/"+tok+"/docs/decisions/y.md")
	require.Equal(t, "sibling", body)
	require.Zero(t, vf.statCalls()) // inside a worktree already: nothing to ask
}

func TestViewOutsideAllWorktrees403(t *testing.T) {
	vf := newViewFx(t)
	vf.withWorktrees(t, "/work/proj-rewrite")
	for _, p := range []string{"/work/other/x.md", "/work/proj-rewrite-2/x.md", "/work"} {
		code, body := vf.do("POST", "/api/machines/m1/views", string(mustJSON(map[string]string{"sessionId": "s1", "path": p})))
		require.Equal(t, 403, code, p)
		require.Contains(t, body, viewOutside)
	}
}

// The app joins a relative path onto the session base; the file lives in a worktree.
func TestViewRelativePathFoundInWorktree(t *testing.T) {
	vf := newViewFx(t)
	vf.withWorktrees(t, "/work/proj", "/work/proj-old", "/work/proj-rewrite")
	vf.put("/work/proj-rewrite/docs/decisions/x.md", []byte("rewrite"))
	u := vf.link(t, "/work/proj/docs/decisions/x.md")
	resp, body := vf.get(t, u)
	require.Equal(t, 200, resp.StatusCode)
	require.Equal(t, "rewrite", body)
	vf.mu.Lock()
	st := vf.stats[0]
	last := vf.reads[len(vf.reads)-1]
	vf.mu.Unlock()
	require.Equal(t, []any{"/work/proj/docs/decisions/x.md", "/work/proj-old/docs/decisions/x.md", "/work/proj-rewrite/docs/decisions/x.md"}, st["paths"])
	require.Equal(t, []any{"/work/proj", "/work/proj-old", "/work/proj-rewrite"}, st["bases"])
	require.Equal(t, "/work/proj-rewrite", last["base"])
	require.Equal(t, "/work/proj-rewrite/docs/decisions/x.md", last["path"])
}

func TestViewRelativePathPrefersSessionBase(t *testing.T) {
	vf := newViewFx(t)
	vf.withWorktrees(t, "/work/proj-rewrite")
	vf.put("/work/proj/a.md", []byte("main"))
	vf.put("/work/proj-rewrite/a.md", []byte("rewrite"))
	_, body := vf.get(t, vf.link(t, "/work/proj/a.md"))
	require.Equal(t, "main", body)
}

func TestViewMissingEverywhereNotFoundText(t *testing.T) {
	vf := newViewFx(t)
	vf.withWorktrees(t, "/work/proj-rewrite")
	resp, body := vf.get(t, vf.link(t, "/work/proj/nope.md"))
	require.Equal(t, 404, resp.StatusCode)
	require.Equal(t, "File not found in this project's folders", strings.TrimSpace(body))
}

// A session without worktrees (an older daemon) never asks file_stat: today's behaviour.
func TestViewNoWorktreesUnchanged(t *testing.T) {
	vf := newViewFx(t)
	vf.put("/work/proj/a.md", []byte("main"))
	_, body := vf.get(t, vf.link(t, "/work/proj/a.md"))
	require.Equal(t, "main", body)
	resp, _ := vf.get(t, vf.link(t, "/work/proj/missing.md"))
	require.Equal(t, 404, resp.StatusCode)
	code, _ := vf.do("POST", "/api/machines/m1/views", string(mustJSON(map[string]string{"sessionId": "s1", "path": "/work/proj-rewrite/a.md"})))
	require.Equal(t, 403, code)
	require.Zero(t, vf.statCalls())
}

func TestViewBasesSanitized(t *testing.T) {
	si := proto.SessionInfo{Root: "/work/proj", Worktrees: []string{"", "relative", "/work/proj/", "/work/a", "/work/a", "/x\x00y"}}
	require.Equal(t, []string{"/work/proj", "/work/a"}, viewBases(si, false))
	many := make([]string, 30)
	for i := range many {
		many[i] = "/w/" + string(rune('a'+i))
	}
	require.Len(t, viewBases(proto.SessionInfo{Root: "/r", Worktrees: many}, false), 1+maxViewWorktrees)
}

func TestStoreKeepsWorktrees(t *testing.T) {
	vf := newViewFx(t)
	vf.withWorktrees(t, "/work/proj-rewrite")
	si, err := vf.st.Session("s1")
	require.NoError(t, err)
	require.Equal(t, []string{"/work/proj-rewrite"}, si.Worktrees)
	vf.withWorktrees(t) // a later report without worktrees clears them
	si, err = vf.st.Session("s1")
	require.NoError(t, err)
	require.Empty(t, si.Worktrees)
}

// linkBase is the base folder of the /v/ link u.
func (vf *viewFx) linkBase(t *testing.T, u string) string {
	t.Helper()
	l, ok := vf.srv.views.get(strings.Split(u, "/")[2])
	require.True(t, ok)
	return l.base
}

// A file_stat failure (an error, an older daemon without the method) keeps the session base.
func TestViewStatFailureKeepsSessionBase(t *testing.T) {
	for _, e := range []string{"boom", "unknown method"} {
		vf := newViewFx(t)
		vf.withWorktrees(t, "/work/proj-rewrite")
		vf.put("/work/proj-rewrite/x.md", []byte("rewrite"))
		vf.statErr = e
		u := vf.link(t, "/work/proj/x.md")
		require.Equal(t, "/work/proj", vf.linkBase(t, u), e)
		resp, body := vf.get(t, u)
		require.Equal(t, 404, resp.StatusCode, e)
		require.Equal(t, viewNotFound, strings.TrimSpace(body))
		require.Equal(t, 1, vf.statCalls())
	}
}

// With the machine offline the link is still made, from the session base, as before.
func TestViewStatOfflineKeepsSessionBase(t *testing.T) {
	vf := newViewFx(t)
	vf.withWorktrees(t, "/work/proj-rewrite")
	vf.srv.hub.mu.Lock()
	c := vf.srv.hub.conns["m1"]
	vf.srv.hub.mu.Unlock()
	c.ws.CloseNow()
	eventually(t, func() bool { return !vf.srv.hub.Connected("m1") })
	u := vf.link(t, "/work/proj/x.md")
	require.Equal(t, "/work/proj", vf.linkBase(t, u))
	resp, _ := vf.get(t, u)
	require.Equal(t, 503, resp.StatusCode)
}

// A sensitive relative path is never looked up in the worktrees (and never served).
func TestViewSensitiveSkipsStat(t *testing.T) {
	vf := newViewFx(t)
	vf.withWorktrees(t, "/work/proj-rewrite")
	vf.put("/work/proj-rewrite/.env", []byte("SECRET=1"))
	for _, p := range []string{"/work/proj/.env", "/work/proj/.git/config"} {
		u := vf.link(t, p)
		require.Equal(t, "/work/proj", vf.linkBase(t, u))
		resp, _ := vf.get(t, u)
		require.Equal(t, 403, resp.StatusCode)
	}
	require.Zero(t, vf.statCalls())
}

func TestViewWorktreesCaseFoldOnWindows(t *testing.T) {
	vf := newViewFx(t)
	require.NoError(t, vf.st.UpsertMachine("m1", "windows", "windows", proto.Version, true, proto.MachineCaps{}))
	require.NoError(t, vf.st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m1", Root: `C:\Work\Proj`, State: proto.StateIdle,
		Worktrees: []string{`c:\work\proj`, `C:\Work\Proj-Rewrite`}}))
	vf.put("C:/Work/Proj-Rewrite/Docs/R.html", []byte("win"))
	// absolute, in another case
	u := vf.link(t, `c:\work\proj-rewrite\Docs\R.html`)
	require.Equal(t, `C:\Work\Proj-Rewrite`, vf.linkBase(t, u))
	_, body := vf.get(t, u)
	require.Equal(t, "win", body)
	// joined onto the session base: found in the worktree; the duplicate of the root is not a candidate
	u = vf.link(t, `c:\work\proj\Docs\R.html`)
	require.Equal(t, `C:\Work\Proj-Rewrite`, vf.linkBase(t, u))
	vf.mu.Lock()
	st := vf.stats[len(vf.stats)-1]
	vf.mu.Unlock()
	require.Equal(t, []any{`C:\Work\Proj`, `C:\Work\Proj-Rewrite`}, st["bases"])
}

func TestViewBasesRejectDotsAndRoots(t *testing.T) {
	si := proto.SessionInfo{Root: "/work/proj", Worktrees: []string{"/", `C:\`, "C:/", `\\`, "/work/../etc", "/work/./x", `C:\a\..\b`, "/work/ok"}}
	require.Equal(t, []string{"/work/proj", "/work/ok"}, viewBases(si, false))
}

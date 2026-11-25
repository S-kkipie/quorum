package hub

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestPendingsDeviceCRUD(t *testing.T) {
	f := newAppFx(t)
	p := briefingProject(t, f.st, "Ana")
	_, ch := f.live(t)
	base := "/api/projects/" + p.ID + "/pendings"
	var a proto.Pending
	f.reqJSON(t, "POST", base, `{"text":"  Call Zorvan  ","detail":"d","clientKey":"k1"}`, 201, &a)
	require.Equal(t, "Call Zorvan", a.Text)
	require.Equal(t, "manual", a.Source)
	var again proto.Pending
	f.reqJSON(t, "POST", base, `{"text":"other","clientKey":"k1"}`, 200, &again)
	require.Equal(t, a.ID, again.ID)

	var got proto.Pending
	f.reqJSON(t, "PATCH", "/api/pendings/"+a.ID, `{"status":"done","note":"sent"}`, 200, &got)
	require.Equal(t, "done", got.Status)
	require.Equal(t, "sent", got.Note)
	require.NotZero(t, got.DoneAt)

	var list []proto.Pending
	f.get(t, base, &list)
	require.Empty(t, list)
	f.get(t, base+"?status=all", &list)
	require.Len(t, list, 1)
	waitBriefingEnv(t, ch)

	require.Equal(t, 204, f.del(t, "/api/pendings/"+a.ID))
	require.Equal(t, 404, f.del(t, "/api/pendings/"+a.ID))
	list = nil
	f.get(t, base+"?status=all", &list)
	require.Empty(t, list)
}

func TestPendingsValidation(t *testing.T) {
	f := newAppFx(t)
	p := briefingProject(t, f.st, "Ana")
	base := "/api/projects/" + p.ID + "/pendings"
	item, _, err := f.st.AddPending(proto.Pending{ProjectID: p.ID, Text: "x", Source: "manual"}, "", 1)
	require.NoError(t, err)
	patch := "/api/pendings/" + item.ID
	for _, c := range []struct{ method, path, body, want string }{
		{"POST", base, `{"text":"   "}`, "text is required"},
		{"POST", base, `{"text":"` + strings.Repeat("é", 301) + `"}`, "text is longer than 300 characters"},
		{"POST", base, `{"text":"a","detail":"` + strings.Repeat("é", 4001) + `"}`, "detail is longer than 4000 characters"},
		{"POST", base, `{"text":"a","clientKey":"` + strings.Repeat("k", 65) + `"}`, "clientKey is longer than 64 characters"},
		{"PATCH", patch, `{"text":" "}`, "text is required"},
		{"PATCH", patch, `{"note":"` + strings.Repeat("n", 2001) + `"}`, "note is longer than 2000 characters"},
		{"PATCH", patch, `{"status":"later"}`, "status must be open, done or dropped"},
	} {
		code, body := f.req(t, c.method, c.path, c.body)
		require.Equal(t, 400, code, c.want)
		require.Contains(t, body, c.want)
	}
	code, _ := f.req(t, "POST", "/api/projects/nope/pendings", `{"text":"x"}`)
	require.Equal(t, 404, code)
	code, _ = f.req(t, "GET", "/api/projects/nope/pendings", "")
	require.Equal(t, 404, code)
	code, _ = f.req(t, "PATCH", "/api/pendings/nope", `{"note":"x"}`)
	require.Equal(t, 404, code)
}

func TestBriefingIncludesOpenPendings(t *testing.T) {
	f := newAppFx(t)
	p := briefingProject(t, f.st, "Ana")
	for i, txt := range []string{"first", "second", "third"} {
		_, _, err := f.st.AddPending(proto.Pending{ProjectID: p.ID, Text: txt, Source: "manual"}, "", int64(100+i))
		require.NoError(t, err)
	}
	all, err := f.st.Pendings(p.ID, true)
	require.NoError(t, err)
	st := "done"
	_, err = f.st.UpdatePending(all[1].ID, store.PendingPatch{Status: &st}, 500)
	require.NoError(t, err)
	var b proto.Briefing
	f.get(t, "/api/projects/"+p.ID+"/briefing", &b)
	require.Len(t, b.Pendings, 2)
	require.Equal(t, "first", b.Pendings[0].Text)
	require.Equal(t, "third", b.Pendings[1].Text)
}

func TestMeetingPendingOnceAndNeedsProject(t *testing.T) {
	f := newAppFx(t)
	p := briefingProject(t, f.st, "Ana")
	mk := func(pid string) proto.Meeting {
		u, err := f.st.CreateMeetingUpload(store.MeetingUpload{Size: 10, Name: "a.ogg", Mime: "audio/ogg", ProjectID: pid, Title: "Weekly"}, nil)
		require.NoError(t, err)
		require.NoError(t, f.st.SetMeetingUploadOffset(u.ID, 10))
		m, err := f.st.CompleteMeetingUpload(u.ID, "/x/a.ogg")
		require.NoError(t, err)
		return m
	}
	m := mk(p.ID)
	var a proto.Pending
	f.reqJSON(t, "POST", "/api/meetings/"+m.ID+"/pendings", `{"text":"Send the quote"}`, 201, &a)
	require.Equal(t, "meeting", a.Source)
	require.Equal(t, m.ID, a.SourceRef)
	require.Equal(t, p.ID, a.ProjectID)
	code, body := f.req(t, "POST", "/api/meetings/"+m.ID+"/pendings", `{"text":"send the  quote"}`)
	require.Equal(t, 409, code)
	require.Contains(t, body, a.ID)
	require.Contains(t, body, "already added")

	// an open manual item with the same text also blocks it
	_, _, err := f.st.AddPending(proto.Pending{ProjectID: p.ID, Text: "Book room", Source: "manual"}, "", 1)
	require.NoError(t, err)
	code, _ = f.req(t, "POST", "/api/meetings/"+m.ID+"/pendings", `{"text":"book room"}`)
	require.Equal(t, 409, code)

	code, body = f.req(t, "POST", "/api/meetings/"+mk("").ID+"/pendings", `{"text":"x"}`)
	require.Equal(t, 400, code)
	require.Contains(t, body, "assign the meeting to a project first")
	code, _ = f.req(t, "POST", "/api/meetings/nope/pendings", `{"text":"x"}`)
	require.Equal(t, 404, code)
}

func (f *appFx) machReq(t *testing.T, tok, method, path, body string) (int, string) {
	t.Helper()
	r, _ := http.NewRequest(method, f.ts.URL+path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(r)
	require.NoError(t, err)
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b)
}

// machinePendingFx has session s1 (machine m1) in a repo, plus a project linked to that repo.
func machinePendingFx(t *testing.T, link bool) (*appFx, proto.Project) {
	f := newAppFx(t)
	f.upsert(t, "s1", "/w/r", "git@github.com:o/r.git", "main")
	eventually(t, func() bool { _, err := f.st.Session("s1"); return err == nil })
	var p proto.Project
	if link {
		p = linkRepoProject(t, f)
	}
	return f, p
}

func linkRepoProject(t *testing.T, f *appFx) proto.Project {
	var ws proto.Workspace
	require.Equal(t, 201, f.postJSON(t, "/api/workspaces", `{"name":"T"}`, &ws))
	var p proto.Project
	require.Equal(t, 201, f.postJSON(t, "/api/projects", `{"workspaceId":"`+ws.ID+`","name":"R","repoURL":"https://github.com/o/r"}`, &p))
	return p
}

const mpath = "/api/machine/sessions/s1/pendings"

func TestMachinePendingsResolveProject(t *testing.T) {
	f, p := machinePendingFx(t, true)
	var add struct {
		Item    proto.Pending `json:"item"`
		Created bool          `json:"created"`
	}
	code, body := f.machReq(t, f.machTok, "POST", mpath, `{"text":"Ping Quillon"}`)
	require.Equal(t, 200, code, body)
	require.NoError(t, json.Unmarshal([]byte(body), &add))
	require.True(t, add.Created)
	require.Equal(t, "agent", add.Item.Source)
	require.Equal(t, "s1", add.Item.SourceRef)
	require.Equal(t, p.ID, add.Item.ProjectID)
	var list struct {
		ProjectID, ProjectName string
		Items                  []proto.Pending
	}
	code, body = f.machReq(t, f.machTok, "GET", mpath, "")
	require.Equal(t, 200, code, body)
	require.NoError(t, json.Unmarshal([]byte(body), &list))
	require.Equal(t, p.ID, list.ProjectID)
	require.Equal(t, "R", list.ProjectName)
	require.Len(t, list.Items, 1)

	tok, _ := NewToken()
	require.NoError(t, f.st.AddToken("machine", "m2", tok))
	for _, m := range []string{"GET", "POST"} {
		code, body = f.machReq(t, tok, m, mpath, `{"text":"x"}`)
		require.Equal(t, 404, code)
		require.Contains(t, body, "unknown session")
	}
	code, _ = f.machReq(t, f.machTok, "GET", "/api/machine/sessions/nope/pendings", "")
	require.Equal(t, 404, code)
}

func TestMachinePendingsNoProjectThenLinked(t *testing.T) {
	f, _ := machinePendingFx(t, false)
	code, body := f.machReq(t, f.machTok, "POST", mpath, `{"text":"a"}`)
	require.Equal(t, 409, code)
	require.Contains(t, body, "This session has no Quorum project; link the folder to a project in Quorum first")
	code, _ = f.machReq(t, f.machTok, "GET", mpath, "")
	require.Equal(t, 409, code)
	linkRepoProject(t, f)
	code, body = f.machReq(t, f.machTok, "POST", mpath, `{"text":"a"}`)
	require.Equal(t, 200, code, body)
}

func TestMachinePendingsClientKeyRetry(t *testing.T) {
	f, _ := machinePendingFx(t, true)
	var ids []string
	for i, created := range []bool{true, false} {
		code, body := f.machReq(t, f.machTok, "POST", mpath, `{"text":"t`+strings.Repeat("x", i)+`","clientKey":"k1"}`)
		require.Equal(t, 200, code, body)
		var r struct {
			Item    proto.Pending `json:"item"`
			Created bool          `json:"created"`
		}
		require.NoError(t, json.Unmarshal([]byte(body), &r))
		require.Equal(t, created, r.Created)
		ids = append(ids, r.Item.ID)
	}
	require.Equal(t, ids[0], ids[1])
	_, body := f.machReq(t, f.machTok, "GET", mpath+"?status=all", "")
	require.Equal(t, 1, strings.Count(body, `"clientKey"`)+strings.Count(body, `"id"`))
}

func TestMachinePendingsDoneOtherProject(t *testing.T) {
	f, _ := machinePendingFx(t, true)
	other := briefingProject(t, f.st, "Ana")
	foreign, _, err := f.st.AddPending(proto.Pending{ProjectID: other.ID, Text: "foreign", Source: "manual"}, "", 1)
	require.NoError(t, err)
	code, body := f.machReq(t, f.machTok, "POST", mpath+"/"+foreign.ID+"/done", `{}`)
	require.Equal(t, 404, code)
	require.Contains(t, body, "unknown pending item")
	got, err := f.st.Pending(foreign.ID)
	require.NoError(t, err)
	require.Equal(t, "open", got.Status)
	code, _ = f.machReq(t, f.machTok, "POST", mpath+"/nope/done", "")
	require.Equal(t, 404, code)

	_, ch := f.live(t)
	_, body = f.machReq(t, f.machTok, "POST", mpath, `{"text":"mine"}`)
	var r struct{ Item proto.Pending }
	require.NoError(t, json.Unmarshal([]byte(body), &r))
	waitBriefingEnv(t, ch)
	code, body = f.machReq(t, f.machTok, "POST", mpath+"/"+r.Item.ID+"/done", `{"note":"shipped"}`)
	require.Equal(t, 200, code, body)
	require.Contains(t, body, `"done"`)
	require.Contains(t, body, "shipped")
	waitBriefingEnv(t, ch)
}

func TestMachinePendingsCapAndTrim(t *testing.T) {
	f, _ := machinePendingFx(t, true)
	for i := 0; i < 50; i++ {
		detail := ""
		if i == 0 {
			detail = strings.Repeat("é", 300)
		}
		code, body := f.machReq(t, f.machTok, "POST", mpath, fmt.Sprintf(`{"text":"item %d","detail":%q}`, i, detail))
		require.Equal(t, 200, code, body)
	}
	code, body := f.machReq(t, f.machTok, "POST", mpath, `{"text":"one too many"}`)
	require.Equal(t, 429, code)
	require.Contains(t, body, "This project already has 50 open pending items from agents; ask the owner to close some first")
	var list struct{ Items []proto.Pending }
	code, body = f.machReq(t, f.machTok, "GET", mpath, "")
	require.Equal(t, 200, code)
	require.NoError(t, json.Unmarshal([]byte(body), &list))
	require.Len(t, list.Items, 50)
	found := false
	for _, it := range list.Items {
		if it.Text == "item 0" {
			found = true
			require.Equal(t, strings.Repeat("é", 200)+"…", it.Detail)
		}
	}
	require.True(t, found)
}

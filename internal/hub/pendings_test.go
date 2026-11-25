package hub

import (
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

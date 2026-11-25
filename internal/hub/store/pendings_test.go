package store

import (
	"fmt"
	"sync"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func pend(pid, text, source string) proto.Pending {
	return proto.Pending{ProjectID: pid, Text: text, Source: source}
}

func TestPendingAddDedupeAndOrder(t *testing.T) {
	s, p := briefingStore(t)
	a, created, err := s.AddPending(pend(p.ID, "Ask Zorvan about the  thickness", "manual"), "", 100)
	require.NoError(t, err)
	require.True(t, created)
	b, created, err := s.AddPending(pend(p.ID, "ask zorvan about the thickness", "manual"), "", 200)
	require.NoError(t, err)
	require.False(t, created)
	require.Equal(t, a.ID, b.ID)

	done := "done"
	_, err = s.UpdatePending(a.ID, PendingPatch{Status: &done}, 300)
	require.NoError(t, err)
	c, created, err := s.AddPending(pend(p.ID, "ask zorvan about the thickness", "manual"), "", 400)
	require.NoError(t, err)
	require.True(t, created)
	require.NotEqual(t, a.ID, c.ID)

	d, _, err := s.AddPending(pend(p.ID, "Second", "manual"), "", 500)
	require.NoError(t, err)
	open, err := s.Pendings(p.ID, false)
	require.NoError(t, err)
	require.Equal(t, []string{c.ID, d.ID}, []string{open[0].ID, open[1].ID})
	all, err := s.Pendings(p.ID, true)
	require.NoError(t, err)
	require.Len(t, all, 3)
	require.Equal(t, a.ID, all[0].ID)
}

func TestPendingClientKeyIdempotent(t *testing.T) {
	s, p := briefingStore(t)
	a, created, err := s.AddPending(pend(p.ID, "one", "agent"), "k1", 1)
	require.NoError(t, err)
	require.True(t, created)
	b, created, err := s.AddPending(pend(p.ID, "other", "agent"), "k1", 2)
	require.NoError(t, err)
	require.False(t, created)
	require.Equal(t, a.ID, b.ID)
	require.Equal(t, "one", b.Text)
	all, err := s.Pendings(p.ID, true)
	require.NoError(t, err)
	require.Len(t, all, 1)
}

func TestPendingAgentCap(t *testing.T) {
	s, p := briefingStore(t)
	var first proto.Pending
	for i := 0; i < 50; i++ {
		x, _, err := s.AddPending(pend(p.ID, fmt.Sprintf("item %d", i), "agent"), "", int64(i))
		require.NoError(t, err)
		if i == 0 {
			first = x
		}
	}
	_, _, err := s.AddPending(pend(p.ID, "item 51", "agent"), "", 99)
	require.ErrorIs(t, err, ErrPendingCap)
	_, created, err := s.AddPending(pend(p.ID, "mine", "manual"), "", 100)
	require.NoError(t, err)
	require.True(t, created)
	done := "done"
	_, err = s.UpdatePending(first.ID, PendingPatch{Status: &done}, 101)
	require.NoError(t, err)
	_, created, err = s.AddPending(pend(p.ID, "item 51", "agent"), "", 102)
	require.NoError(t, err)
	require.True(t, created)
}

func TestPendingUpdateStatus(t *testing.T) {
	s, p := briefingStore(t)
	a, _, err := s.AddPending(pend(p.ID, "x", "manual"), "", 1)
	require.NoError(t, err)
	done, note, open := "done", "waiting on Quillon", "open"
	u, err := s.UpdatePending(a.ID, PendingPatch{Status: &done, Note: &note}, 50)
	require.NoError(t, err)
	require.Equal(t, int64(50), u.DoneAt)
	require.Equal(t, "waiting on Quillon", u.Note)
	u, err = s.UpdatePending(a.ID, PendingPatch{Status: &open}, 60)
	require.NoError(t, err)
	require.Zero(t, u.DoneAt)
	got, err := s.Pending(a.ID)
	require.NoError(t, err)
	require.Equal(t, u, got)
	require.Equal(t, "waiting on Quillon", got.Note)
}

func TestPendingDeletedWithProject(t *testing.T) {
	s, p := briefingStore(t)
	a, _, err := s.AddPending(pend(p.ID, "x", "manual"), "", 1)
	require.NoError(t, err)
	require.NoError(t, s.DeleteProject(p.ID))
	_, err = s.Pending(a.ID)
	require.Error(t, err)
}

func TestPendingDeleteAndMeetingExists(t *testing.T) {
	s, p := briefingStore(t)
	m := pend(p.ID, "Send the Report", "meeting")
	m.SourceRef = "m1"
	a, _, err := s.AddPending(m, "", 1)
	require.NoError(t, err)
	id, ok, err := s.MeetingPendingExists("m1", "send  the report")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, a.ID, id)
	_, ok, err = s.MeetingPendingExists("m2", "send the report")
	require.NoError(t, err)
	require.False(t, ok)
	pid, err := s.DeletePending(a.ID)
	require.NoError(t, err)
	require.Equal(t, p.ID, pid)
}

func TestPendingAddConcurrent(t *testing.T) {
	s, p := briefingStore(t)
	var wg sync.WaitGroup
	var mu sync.Mutex
	created, capped := 0, 0
	for i := 0; i < 60; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, c, err := s.AddPending(pend(p.ID, fmt.Sprintf("agent item %d", i), "agent"), fmt.Sprintf("k%d", i), 100)
			mu.Lock()
			defer mu.Unlock()
			if c {
				created++
			} else if err == ErrPendingCap {
				capped++
			}
		}()
	}
	for i := 0; i < 20; i++ { // same clientKey: exactly one row
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, c, _ := s.AddPending(pend(p.ID, "same", "manual"), "same-key", 100)
			if c {
				mu.Lock()
				created++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	all, err := s.Pendings(p.ID, true)
	require.NoError(t, err)
	require.Equal(t, created, len(all))
	require.Equal(t, 50+1, created)
	require.Equal(t, 10, capped)
}

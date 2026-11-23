package store

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func openMem(t *testing.T) *Store {
	t.Helper()
	s, err := Open(":memory:")
	require.NoError(t, err)
	t.Cleanup(func() { s.Close() })
	return s
}

func TestDeltasAreNotPersisted(t *testing.T) {
	s := openMem(t)
	seq, err := s.AppendEvent(proto.Event{Session: "a", Kind: proto.KindAssistantDelta})
	require.NoError(t, err)
	require.Zero(t, seq)
	evs, err := s.Events("a", 0, 10)
	require.NoError(t, err)
	require.Empty(t, evs)
}

func TestEventRetention(t *testing.T) {
	s := openMem(t)
	for i := 0; i < 2100; i++ {
		seq, err := s.AppendEvent(proto.Event{Session: "a", Kind: proto.KindToolStart, Data: json.RawMessage(`{}`)})
		require.NoError(t, err)
		require.EqualValues(t, i+1, seq)
	}
	evs, err := s.Events("a", 0, 5000)
	require.NoError(t, err)
	require.Len(t, evs, 2000)
	require.EqualValues(t, 2100, evs[0].Seq)
	require.EqualValues(t, 101, evs[len(evs)-1].Seq)
}

func TestEventsPagination(t *testing.T) {
	s := openMem(t)
	for i := 0; i < 10; i++ {
		_, err := s.AppendEvent(proto.Event{Session: "a", Kind: proto.KindInfo, Data: json.RawMessage(`1`)})
		require.NoError(t, err)
	}
	evs, err := s.Events("a", 6, 3)
	require.NoError(t, err)
	require.Len(t, evs, 3)
	require.EqualValues(t, 5, evs[0].Seq)
	require.EqualValues(t, 3, evs[2].Seq)
}

func TestSessionRenameOnClear(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "old", Machine: "m"}))
	_, err := s.AppendEvent(proto.Event{Session: "old", Kind: proto.KindUser, Data: json.RawMessage(`"hi"`)})
	require.NoError(t, err)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "new", PreviousID: "old", Machine: "m"}))
	ss, err := s.ListSessions(true)
	require.NoError(t, err)
	require.Len(t, ss, 1)
	require.Equal(t, "new", ss[0].ID)
	evs, _ := s.Events("new", 0, 10)
	require.Len(t, evs, 1)
	evs, _ = s.Events("old", 0, 10)
	require.Empty(t, evs)
}

func TestSessionRenameMerge(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "old", Machine: "m"}))
	// /resume of a closed session: its history merges with the current one's
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "new", Machine: "m", State: proto.StateClosed}))
	for _, x := range []struct{ id, d string }{{"old", `"o1"`}, {"old", `"o2"`}, {"new", `"n1"`}} {
		_, err := s.AppendEvent(proto.Event{Session: x.id, Kind: proto.KindInfo, Data: json.RawMessage(x.d)})
		require.NoError(t, err)
	}
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "new", PreviousID: "old", Machine: "m"}))
	ss, _ := s.ListSessions(true)
	require.Len(t, ss, 1)
	evs, _ := s.Events("new", 0, 10)
	require.Len(t, evs, 3)
	require.EqualValues(t, 3, evs[0].Seq)
	// newest first: n1, o2, o1
	require.JSONEq(t, `"n1"`, string(evs[0].Data))
	require.JSONEq(t, `"o2"`, string(evs[1].Data))
	require.JSONEq(t, `"o1"`, string(evs[2].Data))
}

func TestUsedCodeNotRevived(t *testing.T) {
	s := openMem(t)
	seq := []string{"111111", "111111", "222222"}
	s.genCode = func() (string, error) { c := seq[0]; seq = seq[1:]; return c, nil }
	c1, err := s.CreateCode("pair")
	require.NoError(t, err)
	require.NoError(t, s.ConsumeCode("pair", c1))
	c2, err := s.CreateCode("pair")
	require.NoError(t, err)
	require.Equal(t, "222222", c2)
	require.ErrorIs(t, s.ConsumeCode("pair", c1), ErrInvalidCode)
}

func TestSessionsClosed(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m1", State: proto.StateWorking}))
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "b", Machine: "m2", State: proto.StateWorking}))
	closed, err := s.MarkMachineSessionsClosed("m1")
	require.NoError(t, err)
	require.Equal(t, []string{"a"}, closed)
	open, _ := s.ListSessions(false)
	require.Len(t, open, 1)
	require.Equal(t, "b", open[0].ID)
	all, _ := s.ListSessions(true)
	require.Len(t, all, 2)
}

func TestMachines(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertMachine("m", "linux", "wsl", "1", true, proto.MachineCaps{}))
	require.NoError(t, s.UpsertMachine("m", "linux", "wsl", "2", false, proto.MachineCaps{}))
	ms, err := s.ListMachines()
	require.NoError(t, err)
	require.Len(t, ms, 1)
	require.Equal(t, "2", ms[0].Version)
	require.False(t, ms[0].Online)
	require.NotZero(t, ms[0].LastSeen)
}

func TestCodeSingleUseAndExpiry(t *testing.T) {
	s := openMem(t)
	code, err := s.CreateCode("pair")
	require.NoError(t, err)
	require.Len(t, code, 6)
	require.NoError(t, s.ConsumeCode("pair", code))
	require.ErrorIs(t, s.ConsumeCode("pair", code), ErrInvalidCode)

	code, err = s.CreateCode("link")
	require.NoError(t, err)
	require.Error(t, s.ConsumeCode("pair", code), "kind must match")
	base := s.now()
	s.now = func() time.Time { return base.Add(11 * time.Minute) }
	require.Error(t, s.ConsumeCode("link", code))
}

func TestTokenStoredHashed(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.AddToken("device", "phone", "secret-token"))
	var n int
	require.NoError(t, s.db.QueryRow(`SELECT count(*) FROM tokens WHERE hash LIKE '%secret-token%' OR name LIKE '%secret-token%'`).Scan(&n))
	require.Zero(t, n)
	name, ok := s.CheckToken("device", "secret-token")
	require.True(t, ok)
	require.Equal(t, "phone", name)
	_, ok = s.CheckToken("machine", "secret-token")
	require.False(t, ok)
	_, ok = s.CheckToken("device", "nope")
	require.False(t, ok)
	ds, err := s.ListDevices()
	require.NoError(t, err)
	require.Len(t, ds, 1)
	require.Equal(t, "phone", ds[0].Name)
	require.NoError(t, s.RevokeToken("device", "phone"))
	_, ok = s.CheckToken("device", "secret-token")
	require.False(t, ok)
}

func TestConcurrentAppend(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "h.db"))
	require.NoError(t, err)
	defer s.Close()
	var wg sync.WaitGroup
	errs := make(chan error, 400)
	for g := 0; g < 8; g++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < 50; i++ {
				_, err := s.AppendEvent(proto.Event{Session: "a", Kind: proto.KindInfo, Data: json.RawMessage(`1`)})
				if err != nil {
					errs <- err
				}
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
	evs, _ := s.Events("a", 0, 1000)
	require.Len(t, evs, 400)
}

func TestCloseSessionAndExcept(t *testing.T) {
	s, err := Open(":memory:")
	require.NoError(t, err)
	defer s.Close()
	for _, id := range []string{"a", "b", "c"} {
		require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: id, Machine: "m1", State: proto.StateIdle}))
	}
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "z", Machine: "m2", State: proto.StateIdle}))
	require.NoError(t, s.CloseSession("m2", "a")) // another machine: nothing changes
	l0, _ := s.ListSessions(false)
	require.Len(t, l0, 4)
	ow, ok, err := s.SessionOwner("a")
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, "m1", ow)
	_, ok, _ = s.SessionOwner("nope")
	require.False(t, ok)
	require.NoError(t, s.CloseSession("m1", "a"))
	_, err = s.CloseMachineSessionsExcept("m1", []string{"b"})
	require.NoError(t, err)
	list, err := s.ListSessions(false)
	require.NoError(t, err)
	ids := []string{}
	for _, x := range list {
		ids = append(ids, x.ID)
	}
	require.ElementsMatch(t, []string{"b", "z"}, ids)
	closed, err := s.CloseMachineSessionsExcept("m1", nil)
	require.NoError(t, err)
	require.Equal(t, []string{"b"}, closed)
	list, _ = s.ListSessions(false)
	require.Len(t, list, 1)
}

func TestUpsertSessionRejectsOtherOwner(t *testing.T) {
	s, err := Open(":memory:")
	require.NoError(t, err)
	defer s.Close()
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "A", Name: "orig", State: proto.StateIdle}))
	require.ErrorIs(t, s.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "B", Name: "theft"}), ErrNotOwner)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "s2", Machine: "B"}))
	// renaming A's session from B is also rejected
	require.ErrorIs(t, s.UpsertSession(proto.SessionInfo{ID: "s3", Machine: "B", PreviousID: "s1"}), ErrNotOwner)
	l, _ := s.ListSessions(false)
	for _, x := range l {
		if x.ID == "s1" {
			require.Equal(t, "A", x.Machine)
			require.Equal(t, "orig", x.Name)
		}
	}
	require.Len(t, l, 2)
}

func TestPrependEventsSeqOrderingAndSkip(t *testing.T) {
	s := openMem(t)
	_, err := s.AppendEvent(proto.Event{Session: "a", Kind: proto.KindInfo})
	require.NoError(t, err)
	mk := func(ts ...int64) []proto.Event {
		var out []proto.Event
		for _, x := range ts {
			out = append(out, proto.Event{TS: x, Kind: proto.KindUser, Data: json.RawMessage(`{"text":"x"}`)})
		}
		return out
	}
	ins, err := s.PrependEvents("a", mk(10, 20, 30))
	require.NoError(t, err)
	require.True(t, ins)
	evs, err := s.Events("a", 0, 10)
	require.NoError(t, err)
	var seqs, tss []int64
	for _, e := range evs {
		seqs, tss = append(seqs, e.Seq), append(tss, e.TS)
	}
	require.Equal(t, []int64{1, -1, -2, -3}, seqs)
	require.Equal(t, []int64{0, 30, 20, 10}, tss)
	// already backfilled: nothing changes
	ins, err = s.PrependEvents("a", mk(99))
	require.NoError(t, err)
	require.False(t, ins)
	evs, _ = s.Events("a", 0, 10)
	require.Len(t, evs, 4)
	// AppendEvent continues in positives
	seq, err := s.AppendEvent(proto.Event{Session: "a", Kind: proto.KindInfo})
	require.NoError(t, err)
	require.EqualValues(t, 2, seq)
	// pagination backwards crossing zero
	evs, _ = s.Events("a", -1, 10)
	require.Len(t, evs, 2)
	require.EqualValues(t, -2, evs[0].Seq)
}

func seqsOf(t *testing.T, s *Store, id string) []int64 {
	t.Helper()
	evs, err := s.Events(id, 0, 100)
	require.NoError(t, err)
	var out []int64
	for _, e := range evs {
		out = append(out, e.Seq)
	}
	return out
}

func TestAppendAfterOnlyBackfilledNeverSeqZero(t *testing.T) {
	s := openMem(t)
	_, err := s.PrependEvents("a", []proto.Event{{Kind: proto.KindUser}, {Kind: proto.KindUser}})
	require.NoError(t, err)
	seq, err := s.AppendEvent(proto.Event{Session: "a", Kind: proto.KindInfo})
	require.NoError(t, err)
	require.EqualValues(t, 1, seq)
}

func TestRenameAfterBackfillOnlyNegativesInOld(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "old", Machine: "m1"}))
	_, err := s.PrependEvents("old", []proto.Event{{Kind: proto.KindUser}, {Kind: proto.KindUser}})
	require.NoError(t, err)
	_, err = s.AppendEvent(proto.Event{Session: "new", Kind: proto.KindInfo})
	require.NoError(t, err)
	_, err = s.AppendEvent(proto.Event{Session: "new", Kind: proto.KindInfo})
	require.NoError(t, err)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "new", PreviousID: "old", Machine: "m1"}))
	require.Equal(t, []int64{2, 1, -1, -2}, seqsOf(t, s, "new"))
}

func TestRenameMergeBothBackfilled(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "old", Machine: "m1"}))
	_, err := s.PrependEvents("old", []proto.Event{{Kind: proto.KindUser}, {Kind: proto.KindUser}})
	require.NoError(t, err)
	_, err = s.AppendEvent(proto.Event{Session: "old", Kind: proto.KindInfo})
	require.NoError(t, err)
	_, err = s.PrependEvents("new", []proto.Event{{Kind: proto.KindUser}, {Kind: proto.KindUser}, {Kind: proto.KindUser}})
	require.NoError(t, err)
	_, err = s.AppendEvent(proto.Event{Session: "new", Kind: proto.KindInfo})
	require.NoError(t, err)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "new", PreviousID: "old", Machine: "m1"}))
	require.Equal(t, []int64{2, 1, -1, -2}, seqsOf(t, s, "new"))
}

// A DB created before previous_id is migrated and keeps its sessions.
func TestMigratesOldSessionsTable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+path)
	require.NoError(t, err)
	_, err = db.Exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, machine TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '',
		cwd TEXT NOT NULL DEFAULT '', root TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT '',
		state TEXT NOT NULL DEFAULT '', context_pct INTEGER NOT NULL DEFAULT 0, started_at INTEGER NOT NULL DEFAULT 0,
		updated_at INTEGER NOT NULL DEFAULT 0, passive INTEGER NOT NULL DEFAULT 0, passive_reason TEXT NOT NULL DEFAULT '');
		INSERT INTO sessions(id,machine,state) VALUES('a','m1','idle');`)
	require.NoError(t, err)
	require.NoError(t, db.Close())
	s, err := Open(path)
	require.NoError(t, err)
	defer s.Close()
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "b", PreviousID: "a", Machine: "m1", State: proto.StateIdle}))
	si, err := s.Session("b")
	require.NoError(t, err)
	require.Equal(t, "a", si.PreviousID)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "c", Machine: "m1", State: proto.StateIdle, HerdrPane: "p_9"}))
	si, err = s.Session("c")
	require.NoError(t, err)
	require.Equal(t, "p_9", si.HerdrPane)
}

// Ruling Q: after /clear A→B, `claude --resume A` revives A while B lives. B's
// old previous_id must not be reapplied or keep showing up in the snapshot/REST.
func TestResumedOldIDClearsStalePreviousID(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "A", Machine: "m", State: proto.StateIdle}))
	_, err := s.AppendEvent(proto.Event{Session: "A", Kind: proto.KindInfo, Data: json.RawMessage(`"a1"`)})
	require.NoError(t, err)
	applied, err := s.SaveSession(proto.SessionInfo{ID: "B", PreviousID: "A", Machine: "m", State: proto.StateIdle})
	require.NoError(t, err)
	require.Equal(t, "A", applied)
	si, err := s.Session("B")
	require.NoError(t, err)
	require.Equal(t, "A", si.PreviousID)

	// A comes back (resume): it is inserted alive and B stops pointing to it
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "A", Machine: "m", State: proto.StateIdle}))
	si, _ = s.Session("B")
	require.Empty(t, si.PreviousID)
	_, err = s.AppendEvent(proto.Event{Session: "A", Kind: proto.KindInfo, Data: json.RawMessage(`"a2"`)})
	require.NoError(t, err)

	// an upsert/hello that still carries B.previousId=A neither merges nor renames
	applied, err = s.SaveSession(proto.SessionInfo{ID: "B", PreviousID: "A", Machine: "m", State: proto.StateWorking})
	require.NoError(t, err)
	require.Empty(t, applied)
	ss, _ := s.ListSessions(false)
	require.Len(t, ss, 2)
	for _, x := range ss {
		require.Empty(t, x.PreviousID, x.ID)
	}
	evs, _ := s.Events("A", 0, 10)
	require.Len(t, evs, 1)
	require.JSONEq(t, `"a2"`, string(evs[0].Data))
	evs, _ = s.Events("B", 0, 10)
	require.Len(t, evs, 1)
	require.JSONEq(t, `"a1"`, string(evs[0].Data))
}

// Even if B's row keeps previous_id (DB from before the fix), it is not published
// while A exists alive.
func TestPreviousIDHiddenWhileOldIDLives(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "B", Machine: "m", State: proto.StateIdle}))
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "A", Machine: "m", State: proto.StateIdle}))
	_, err := s.db.Exec(`UPDATE sessions SET previous_id='A' WHERE id='B'`)
	require.NoError(t, err)
	si, _ := s.Session("B")
	require.Empty(t, si.PreviousID)
	require.NoError(t, s.CloseSession("m", "A"))
	si, _ = s.Session("B")
	require.Equal(t, "A", si.PreviousID)
}

func TestPairIsAtomic(t *testing.T) {
	s := openMem(t)
	code, err := s.CreateCode("pair")
	require.NoError(t, err)
	// a token that cannot be saved (table locked by a trigger) leaves the code alive
	_, err = s.db.Exec(`CREATE TRIGGER no_tokens BEFORE INSERT ON tokens BEGIN SELECT RAISE(ABORT,'no'); END`)
	require.NoError(t, err)
	_, err = s.Pair("pair", code, "device", "tel", "tok1")
	require.Error(t, err)
	_, err = s.db.Exec(`DROP TRIGGER no_tokens`)
	require.NoError(t, err)
	name, err := s.Pair("pair", code, "device", "tel", "tok1")
	require.NoError(t, err)
	require.Equal(t, "tel", name)
	_, err = s.Pair("pair", code, "device", "tel", "tok2")
	require.ErrorIs(t, err, ErrInvalidCode)
	// second device with the same name: suffix
	code2, _ := s.CreateCode("pair")
	name, err = s.Pair("pair", code2, "device", "tel", "tok2")
	require.NoError(t, err)
	require.Equal(t, "tel (2)", name)
}

func TestAddUniqueDeviceTokenOnlyRetriesNameConflict(t *testing.T) {
	s := openMem(t)
	n, err := s.AddUniqueDeviceToken("x", "t1")
	require.NoError(t, err)
	require.Equal(t, "x", n)
	n, err = s.AddUniqueDeviceToken("x", "t2")
	require.NoError(t, err)
	require.Equal(t, "x (2)", n)
	// another constraint error (NOT NULL) is not retried 9999 times: it returns right away
	_, err = s.db.Exec(`CREATE TRIGGER bad BEFORE INSERT ON tokens BEGIN SELECT RAISE(ABORT,'fake constraint'); END`)
	require.NoError(t, err)
	_, err = s.AddUniqueDeviceToken("y", "t3")
	require.ErrorContains(t, err, "fake constraint")
}

func TestCreateCodeRetriesOnlyOnCodeConflict(t *testing.T) {
	s := openMem(t)
	codes := []string{"111111", "111111", "222222"}
	s.genCode = func() (string, error) { c := codes[0]; codes = codes[1:]; return c, nil }
	c1, err := s.CreateCode("pair")
	require.NoError(t, err)
	require.Equal(t, "111111", c1)
	c2, err := s.CreateCode("pair")
	require.NoError(t, err)
	require.Equal(t, "222222", c2)
	s.genCode = func() (string, error) { return "333333", nil }
	_, err = s.db.Exec(`CREATE TRIGGER bad BEFORE INSERT ON codes BEGIN SELECT RAISE(ABORT,'fake constraint'); END`)
	require.NoError(t, err)
	_, err = s.CreateCode("pair")
	require.ErrorContains(t, err, "fake constraint")
}

func TestOpenPathWithURIChars(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "a?b#c%20d")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	p := filepath.Join(dir, "hub.db")
	s, err := Open(p)
	require.NoError(t, err)
	require.NoError(t, s.UpsertMachine("m", "", "", "", true, proto.MachineCaps{}))
	s.Close()
	_, err = os.Stat(p)
	require.NoError(t, err)
}

func TestLiveSessionIDs(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m", State: proto.StateIdle}))
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "b", Machine: "m", State: proto.StateClosed}))
	ids, err := s.LiveSessionIDs()
	require.NoError(t, err)
	require.Equal(t, map[string]bool{"a": true}, ids)
}

func TestSessionRecapPersists(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m", Recap: "Fixing the login"}))
	si, err := s.Session("a")
	require.NoError(t, err)
	require.Equal(t, "Fixing the login", si.Recap)
	all, err := s.ListSessions(true)
	require.NoError(t, err)
	require.Equal(t, "Fixing the login", all[0].Recap)
	// the mod always sends its current recap: it is stored as is
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m", Recap: "Something else"}))
	si, _ = s.Session("a")
	require.Equal(t, "Something else", si.Recap)
}

func TestSessionRecapNotClearedByEmptyUpsert(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m", State: proto.StateIdle, Recap: "Fixing the login"}))
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m", State: proto.StateWorking}))
	si, _ := s.Session("a")
	require.Equal(t, "Fixing the login", si.Recap)
	// /clear: the new session (rename) starts without the previous conversation's recap
	applied, err := s.SaveSession(proto.SessionInfo{ID: "b", PreviousID: "a", Machine: "m", State: proto.StateIdle})
	require.NoError(t, err)
	require.Equal(t, "a", applied)
	si, _ = s.Session("b")
	require.Equal(t, "", si.Recap)
	// a new session without a rename also starts empty
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "c", Machine: "m", State: proto.StateIdle}))
	si, _ = s.Session("c")
	require.Equal(t, "", si.Recap)
}

func TestMachineCapsRoundTrip(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertMachine("m", "linux", "wsl", "1", true, proto.MachineCaps{Herdr: true, Terminal: true}))
	ms, err := s.ListMachines()
	require.NoError(t, err)
	require.True(t, ms[0].Caps.Herdr)
	require.True(t, ms[0].Caps.Terminal)
	require.False(t, ms[0].Caps.Root)
	require.NoError(t, s.SetMachineCaps("m", proto.MachineCaps{Root: true}))
	ms, _ = s.ListMachines()
	require.False(t, ms[0].Caps.Herdr)
	require.True(t, ms[0].Caps.Root)
}

func TestMachineCapsMigratesOldDB(t *testing.T) {
	p := filepath.Join(t.TempDir(), "old.db")
	db, err := sql.Open("sqlite", "file:"+p)
	require.NoError(t, err)
	_, err = db.Exec(`CREATE TABLE machines (name TEXT PRIMARY KEY, os TEXT NOT NULL DEFAULT '', env TEXT NOT NULL DEFAULT '',
		version TEXT NOT NULL DEFAULT '', online INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0);
		INSERT INTO machines(name) VALUES('viejo')`)
	require.NoError(t, err)
	db.Close()
	s, err := Open(p)
	require.NoError(t, err)
	defer s.Close()
	ms, err := s.ListMachines()
	require.NoError(t, err)
	require.Len(t, ms, 1)
	require.Equal(t, proto.MachineCaps{}, ms[0].Caps)
}

// Plan 3: launchReq and the herdr pane are stored, survive a rename and are read back.
func TestSessionLaunchAndHerdrPersist(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m", State: proto.StateIdle,
		LaunchReq: "r1", HerdrPane: "p_1", HerdrWorkspace: "w_1"}))
	si, err := s.Session("a")
	require.NoError(t, err)
	require.Equal(t, [3]string{"r1", "p_1", "w_1"}, [3]string{si.LaunchReq, si.HerdrPane, si.HerdrWorkspace})
	// /clear: the new id arrives with the same process data
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "b", PreviousID: "a", Machine: "m", State: proto.StateIdle,
		LaunchReq: "r1", HerdrPane: "p_1", HerdrWorkspace: "w_1"}))
	ss, err := s.ListSessions(false)
	require.NoError(t, err)
	require.Len(t, ss, 1)
	require.Equal(t, [4]string{"b", "r1", "p_1", "w_1"}, [4]string{ss[0].ID, ss[0].LaunchReq, ss[0].HerdrPane, ss[0].HerdrWorkspace})
}

func TestMigrateSpanishStatusesToEnglish(t *testing.T) {
	path := filepath.Join(t.TempDir(), "old.db")
	s, err := Open(path)
	require.NoError(t, err)
	// Simulate a database written before the English migration.
	for _, q := range []string{
		`INSERT INTO projects(id,workspace_id,name,kind,settings) VALUES('p1','w','P','exec','{"statusMap":"{\"waiting\":\"bloqueado\",\"x\":\"en_curso\",\"y\":\"done\"}","cmd":"c"}')`,
		`INSERT INTO projects(id,workspace_id,name,kind,settings) VALUES('p2','w','Q','exec','not json statusMap')`,
		`INSERT INTO tickets(id,project_id,external_id,title,status) VALUES('t1','p1','1','a','por_hacer'),('t2','p1','2','b','en_review'),('t3','p1','3','c','hecho')`,
		`INSERT INTO proposals(id,ticket_id,kind,body,status) VALUES('a','t1','status','hecho','pendiente'),('b','t1','comment','hecho','enviando'),('c','t1','status','en_curso','aprobada'),('d','t1','status','x','rechazada'),('e','t1','comment','y','fallida')`,
	} {
		_, err := s.db.Exec(q)
		require.NoError(t, err, q)
	}
	require.NoError(t, s.Close())

	for i := 0; i < 2; i++ { // the second pass proves idempotency
		s, err = Open(path)
		require.NoError(t, err)
		got := func(q string) (out []string) {
			rows, err := s.db.Query(q)
			require.NoError(t, err)
			defer rows.Close()
			for rows.Next() {
				var v string
				require.NoError(t, rows.Scan(&v))
				out = append(out, v)
			}
			return out
		}
		require.Equal(t, []string{"todo", "in_review", "done"}, got(`SELECT status FROM tickets ORDER BY id`))
		require.Equal(t, []string{"pending", "sending", "approved", "rejected", "failed"}, got(`SELECT status FROM proposals ORDER BY id`))
		// Only status proposals have their body rewritten.
		require.Equal(t, []string{"done", "hecho", "in_progress", "x", "y"}, got(`SELECT body FROM proposals ORDER BY id`))
		p, err := s.GetProject("p1")
		require.NoError(t, err)
		require.JSONEq(t, `{"waiting":"blocked","x":"in_progress","y":"done"}`, p.Connector.Settings["statusMap"])
		require.Equal(t, "c", p.Connector.Settings["cmd"])
		require.Equal(t, []string{"not json statusMap"}, got(`SELECT settings FROM projects WHERE id='p2'`))
		require.NoError(t, s.Close())
	}
}

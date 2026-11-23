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
	// /resume de una sesión cerrada: su historial se fusiona con el de la actual
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
	// más nuevos primero: n1, o2, o1
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
	require.NoError(t, s.UpsertMachine("m", "linux", "wsl", "1", true))
	require.NoError(t, s.UpsertMachine("m", "linux", "wsl", "2", false))
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
	require.NoError(t, s.CloseSession("m2", "a")) // otra máquina: no cambia nada
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
	require.ErrorIs(t, s.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "B", Name: "robo"}), ErrNotOwner)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "s2", Machine: "B"}))
	// renombrar la sesión de A desde B también se rechaza
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
	// ya rellenada: no cambia nada
	ins, err = s.PrependEvents("a", mk(99))
	require.NoError(t, err)
	require.False(t, ins)
	evs, _ = s.Events("a", 0, 10)
	require.Len(t, evs, 4)
	// AppendEvent sigue en positivos
	seq, err := s.AppendEvent(proto.Event{Session: "a", Kind: proto.KindInfo})
	require.NoError(t, err)
	require.EqualValues(t, 2, seq)
	// paginación hacia atrás cruzando el cero
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

// Una BD creada antes de previous_id se migra y conserva sus sesiones.
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
}

// Ruling Q: tras /clear A→B, `claude --resume A` revive A mientras B vive. El
// previous_id viejo de B no debe reaplicarse ni seguir saliendo en el snapshot/REST.
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

	// A vuelve (resume): se inserta vivo y B deja de apuntarle
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "A", Machine: "m", State: proto.StateIdle}))
	si, _ = s.Session("B")
	require.Empty(t, si.PreviousID)
	_, err = s.AppendEvent(proto.Event{Session: "A", Kind: proto.KindInfo, Data: json.RawMessage(`"a2"`)})
	require.NoError(t, err)

	// un upsert/hello que aún trae B.previousId=A no fusiona ni renombra
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

// Aunque la fila de B conserve previous_id (BD anterior al arreglo), no se publica
// mientras A exista viva.
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
	// un token que no se puede guardar (tabla bloqueada por un trigger) deja el código vivo
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
	// segundo dispositivo con el mismo nombre: sufijo
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
	// otro error de constraint (NOT NULL) no se reintenta 9999 veces: sale enseguida
	_, err = s.db.Exec(`CREATE TRIGGER bad BEFORE INSERT ON tokens BEGIN SELECT RAISE(ABORT,'constraint falso'); END`)
	require.NoError(t, err)
	_, err = s.AddUniqueDeviceToken("y", "t3")
	require.ErrorContains(t, err, "constraint falso")
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
	_, err = s.db.Exec(`CREATE TRIGGER bad BEFORE INSERT ON codes BEGIN SELECT RAISE(ABORT,'constraint falso'); END`)
	require.NoError(t, err)
	_, err = s.CreateCode("pair")
	require.ErrorContains(t, err, "constraint falso")
}

func TestOpenPathWithURIChars(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "a?b#c%20d")
	require.NoError(t, os.MkdirAll(dir, 0o700))
	p := filepath.Join(dir, "hub.db")
	s, err := Open(p)
	require.NoError(t, err)
	require.NoError(t, s.UpsertMachine("m", "", "", "", true))
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
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m", Recap: "Arreglando el login"}))
	si, err := s.Session("a")
	require.NoError(t, err)
	require.Equal(t, "Arreglando el login", si.Recap)
	all, err := s.ListSessions(true)
	require.NoError(t, err)
	require.Equal(t, "Arreglando el login", all[0].Recap)
	// el mod siempre envía su recap vigente: se guarda tal cual
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m", Recap: "Otra cosa"}))
	si, _ = s.Session("a")
	require.Equal(t, "Otra cosa", si.Recap)
}

func TestSessionRecapNotClearedByEmptyUpsert(t *testing.T) {
	s := openMem(t)
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m", State: proto.StateIdle, Recap: "Arreglando el login"}))
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "a", Machine: "m", State: proto.StateWorking}))
	si, _ := s.Session("a")
	require.Equal(t, "Arreglando el login", si.Recap)
	// /clear: la sesión nueva (renombre) empieza sin el recap de la conversación anterior
	applied, err := s.SaveSession(proto.SessionInfo{ID: "b", PreviousID: "a", Machine: "m", State: proto.StateIdle})
	require.NoError(t, err)
	require.Equal(t, "a", applied)
	si, _ = s.Session("b")
	require.Equal(t, "", si.Recap)
	// una sesión nueva sin renombre también empieza vacía
	require.NoError(t, s.UpsertSession(proto.SessionInfo{ID: "c", Machine: "m", State: proto.StateIdle}))
	si, _ = s.Session("c")
	require.Equal(t, "", si.Recap)
}

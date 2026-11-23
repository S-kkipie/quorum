package daemon

import (
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestUpsertPreviousIDCierraAttachViejo(t *testing.T) {
	r := NewRegistry("m1")
	r.Upsert(proto.SessionInfo{ID: "old"})
	ch, _ := r.Subscribe("old")
	r.Upsert(proto.SessionInfo{ID: "new", PreviousID: "old"})

	select {
	case _, ok := <-ch:
		if ok {
			t.Fatal("llegó un comando; se esperaba el canal cerrado")
		}
	default:
		t.Fatal("el canal del id viejo sigue abierto")
	}
	snap := r.Snapshot()
	if len(snap) != 1 || snap[0].ID != "new" {
		t.Fatalf("snapshot = %+v, solo debe quedar new", snap)
	}
	if r.Send("old", proto.Command{Type: "prompt"}) {
		t.Fatal("no debe quedar suscriptor para old")
	}
}

// Q: `claude --resume A` tras /clear A→B: el hello deja de mandar B.previousId=A.
func TestUpsertOfOldIDClearsStalePreviousID(t *testing.T) {
	r := NewRegistry("m1")
	r.Upsert(proto.SessionInfo{ID: "A"})
	r.Upsert(proto.SessionInfo{ID: "B", PreviousID: "A"})
	r.Upsert(proto.SessionInfo{ID: "A"})
	for _, si := range r.Snapshot() {
		if si.PreviousID != "" {
			t.Fatalf("%s conserva previousId=%q", si.ID, si.PreviousID)
		}
	}
	if len(r.Snapshot()) != 2 {
		t.Fatalf("snapshot = %+v", r.Snapshot())
	}
}

// Minor: Upsert y Gone concurrentes llegan al hub en el orden en que cambiaron el registro.
func TestUpsertGoneEmitOrderMatchesState(t *testing.T) {
	for round := 0; round < 200; round++ {
		r := NewRegistry("m1")
		done := make(chan struct{})
		go func() { r.Upsert(proto.SessionInfo{ID: "s"}); close(done) }()
		r.Gone("s")
		<-done
		var last string
		for len(r.out) > 0 {
			last = (<-r.out).Type
		}
		alive := len(r.Snapshot()) == 1
		if alive && last != "session_upsert" || !alive && last != "session_gone" {
			t.Fatalf("ronda %d: vivo=%v pero el último envelope fue %s", round, alive, last)
		}
	}
}

// Revisión: un renombre real emite session_gone del id viejo después del upsert.
func TestRealRenameEmitsGoneAfterUpsert(t *testing.T) {
	r := NewRegistry("m1")
	r.Upsert(proto.SessionInfo{ID: "A"})
	<-r.out
	r.Upsert(proto.SessionInfo{ID: "B", PreviousID: "A"})
	e1, e2 := <-r.out, <-r.out
	if e1.Type != "session_upsert" || e1.Session != "B" || e2.Type != "session_gone" || e2.Session != "A" {
		t.Fatalf("envelopes = %s:%s, %s:%s", e1.Type, e1.Session, e2.Type, e2.Session)
	}
	// prev desconocido (ya renombrado o de otro daemon): sin gone
	r.Upsert(proto.SessionInfo{ID: "C", PreviousID: "X"})
	<-r.out
	if len(r.out) != 0 {
		t.Fatalf("sobra %+v", <-r.out)
	}
	// ambos vivos: previousId viejo, se ignora y no se cierra nada
	r.Upsert(proto.SessionInfo{ID: "A"})
	<-r.out
	r.Upsert(proto.SessionInfo{ID: "B", PreviousID: "A"})
	<-r.out
	if len(r.out) != 0 || len(r.Snapshot()) != 3 {
		t.Fatalf("out=%d snapshot=%+v", len(r.out), r.Snapshot())
	}
}

func TestSubscribeReplaysNothing(t *testing.T) {
	r := NewRegistry("m")
	r.Upsert(proto.SessionInfo{ID: "s1"})
	require.False(t, r.Send("s1", proto.Command{Type: "prompt", Text: "x"}))
	for i := 0; i < 2; i++ { // también tras un reattach
		ch, cancel := r.Subscribe("s1")
		select {
		case c := <-ch:
			t.Fatalf("Subscribe reenvió %v", c)
		default:
		}
		cancel()
	}
}

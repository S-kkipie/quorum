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
			t.Fatal("a command arrived; expected the channel closed")
		}
	default:
		t.Fatal("the old id's channel is still open")
	}
	snap := r.Snapshot()
	if len(snap) != 1 || snap[0].ID != "new" {
		t.Fatalf("snapshot = %+v, only new should remain", snap)
	}
	if r.Send("old", proto.Command{Type: "prompt"}) {
		t.Fatal("no subscriber should remain for old")
	}
}

// Q: `claude --resume A` after /clear A→B: the hello stops sending B.previousId=A.
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

// Minor: concurrent Upsert and Gone reach the hub in the order in which they changed the registry.
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
			t.Fatalf("round %d: alive=%v but the last envelope was %s", round, alive, last)
		}
	}
}

// Review: a real rename emits session_gone for the old id after the upsert.
func TestRealRenameEmitsGoneAfterUpsert(t *testing.T) {
	r := NewRegistry("m1")
	r.Upsert(proto.SessionInfo{ID: "A"})
	<-r.out
	r.Upsert(proto.SessionInfo{ID: "B", PreviousID: "A"})
	e1, e2 := <-r.out, <-r.out
	if e1.Type != "session_upsert" || e1.Session != "B" || e2.Type != "session_gone" || e2.Session != "A" {
		t.Fatalf("envelopes = %s:%s, %s:%s", e1.Type, e1.Session, e2.Type, e2.Session)
	}
	// unknown prev (already renamed or from another daemon): no gone
	r.Upsert(proto.SessionInfo{ID: "C", PreviousID: "X"})
	<-r.out
	if len(r.out) != 0 {
		t.Fatalf("sobra %+v", <-r.out)
	}
	// both alive: stale previousId, ignored and nothing is closed
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
	for i := 0; i < 2; i++ { // also after a reattach
		ch, cancel := r.Subscribe("s1")
		select {
		case c := <-ch:
			t.Fatalf("Subscribe resent %v", c)
		default:
		}
		cancel()
	}
}

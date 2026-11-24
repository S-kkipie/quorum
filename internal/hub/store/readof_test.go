package store

import (
	"encoding/json"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestHasReadOf(t *testing.T) {
	s := openMem(t)
	add := func(session string, kind proto.EventKind, data string) {
		_, err := s.AppendEvent(proto.Event{Session: session, Kind: kind, Data: json.RawMessage(data)})
		require.NoError(t, err)
	}
	read := func(session, id, path string) {
		add(session, proto.KindToolStart, `{"id":"`+id+`","name":"Read","summary":"x","input":{"file_path":"`+path+`"}}`)
	}
	end := func(session, id string, ok bool) {
		o := "false"
		if ok {
			o = "true"
		}
		add(session, proto.KindToolEnd, `{"id":"`+id+`","ok":`+o+`,"ms":1,"output":""}`)
	}
	read("a", "t1", "/w/p/shot.png")
	end("a", "t1", true)
	add("a", proto.KindToolStart, `{"id":"t2","name":"Write","summary":"x","input":{"file_path":"/w/p/w.png"}}`)
	end("a", "t2", true)
	add("a", proto.KindUser, `{"text":"/w/p/u.png","input":{"file_path":"/w/p/u.png"},"name":"Read","id":"t9"}`)
	end("a", "t9", true)
	add("a", proto.KindToolStart, `not json`)
	add("a", proto.KindToolEnd, `not json`)
	read("b", "t3", "/w/p/b.png")
	end("b", "t3", true)
	read("a", "t4", "/w/p/denied.png") // the owner denied the Read
	end("a", "t4", false)
	read("a", "t5", "/w/p/pending.png") // no tool_end (still running, or lost)
	read("a", "t6", "/w/p/other-end.png")
	end("b", "t6", true) // a tool_end of the same id in another session does not count
	read("a", "", "/w/p/noid.png")
	end("a", "", true)                // an empty id never pairs
	read("a", "t7", "/w/p/again.png") // denied once, then read fine
	end("a", "t7", false)
	read("a", "t8", "/w/p/again.png")
	end("a", "t8", true)

	for _, c := range []struct {
		session, path string
		want          bool
	}{
		{"a", "/w/p/shot.png", true},
		{"a", "/w/p/SHOT.png", false}, // exact match only
		{"a", "/w/p/shot.png ", false},
		{"a", "/w/p/w.png", false}, // written, not read
		{"a", "/w/p/u.png", false}, // not a tool_start
		{"a", "/w/p/b.png", false}, // read in another session
		{"b", "/w/p/b.png", true},
		{"c", "/w/p/shot.png", false},
		{"a", "/w/p/denied.png", false},
		{"a", "/w/p/pending.png", false},
		{"a", "/w/p/other-end.png", false},
		{"a", "/w/p/noid.png", false},
		{"a", "/w/p/again.png", true},
		{"a", "", false},
	} {
		got, err := s.HasReadOf(c.session, c.path)
		require.NoError(t, err)
		require.Equal(t, c.want, got, c.session+" "+c.path)
	}
}

// Package connectors implements the ticket connectors (executable, GitHub, Paperclip)
// and the periodic syncer. It does not depend on the hub package.
package connectors

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/S-kkipie/quorum/internal/proto"
)

// ErrNoConnector: the project has no connector (kind none or empty).
var ErrNoConnector = errors.New("the project has no connector")

// Connector is the interface common to all ticket sources.
type Connector interface {
	List(ctx context.Context, since int64) ([]proto.Ticket, error)
	Comment(ctx context.Context, externalID, body string) error
	SetStatus(ctx context.Context, externalID, status string) error
}

// NoteLister is optional: a connector that also has meeting notes implements it, and the syncer
// calls it after List.
type NoteLister interface {
	ListNotes(ctx context.Context) ([]proto.MeetingNote, error)
}

// FullLister is optional: a connector whose List always returns the source's full list (it ignores since)
// says so, and the syncer then deletes the stored tickets missing from it (deleted or moved at the source).
type FullLister interface {
	FullList() bool
}

// Reusable is optional: a connector that keeps state worth keeping between syncs (a login session) says so,
// and the syncer keeps one per project until the project's configuration or token changes.
type Reusable interface {
	Reusable() bool
}

// readOnlyKinds are the kinds that never write to their source (no comment or status proposals).
var readOnlyKinds = map[string]bool{}

// RegisterReadOnly marks a kind as a read-only source; called from init().
func RegisterReadOnly(kind string) { readOnlyKinds[kind] = true }

// ReadOnly says whether the kind is a read-only source.
func ReadOnly(kind string) bool { return readOnlyKinds[kind] }

// ReadOnlyKinds returns the read-only kinds, sorted.
func ReadOnlyKinds() []string {
	out := make([]string, 0, len(readOnlyKinds))
	for k := range readOnlyKinds {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// Factory builds a connector of a kind from its configuration.
type Factory func(cfg proto.ConnectorConfig, token string, env []string) (Connector, error)

var factories = map[string]Factory{
	"exec": func(cfg proto.ConnectorConfig, token string, env []string) (Connector, error) {
		return newExec(cfg, token, env, defaultTimeout)
	},
}

// Register adds (or replaces) the implementation of a kind; called from init().
func Register(kind string, f Factory) { factories[kind] = f }

// New creates the connector for cfg.Kind; "none" and "" give ErrNoConnector.
func New(cfg proto.ConnectorConfig, token string, env []string) (Connector, error) {
	if cfg.Kind == "" || cfg.Kind == "none" {
		return nil, ErrNoConnector
	}
	f, ok := factories[cfg.Kind]
	if !ok {
		return nil, fmt.Errorf("connector %q not supported", cfg.Kind)
	}
	return f(cfg, token, env)
}

var defaultStatuses = map[string]string{
	"todo": "todo", "in_progress": "in_progress", "in_review": "in_review", "done": "done", "blocked": "blocked",
	"open": "todo", "to do": "todo", "backlog": "todo",
	"in progress": "in_progress", "doing": "in_progress",
	"review": "in_review", "in review": "in_review",
	"closed": "done", "resolved": "done", "cancelled": "done", "canceled": "done",
	// Spanish aliases: connectors and statusMaps written before the English migration keep working.
	"por_hacer": "todo", "en_curso": "in_progress", "en curso": "in_progress", "en_review": "in_review",
	"hecho": "done", "bloqueado": "blocked", "aparcado": "blocked",
}

func normKey(s string) string {
	return strings.NewReplacer("_", " ", "-", " ").Replace(strings.ToLower(strings.TrimSpace(s)))
}

// normValue maps a custom statusMap value through the default statuses, so old
// Spanish values (e.g. "bloqueado") yield the English one; unknown values pass through.
func normValue(v string) string {
	if n, ok := defaultStatuses[strings.ToLower(strings.TrimSpace(v))]; ok {
		return n
	}
	return v
}

// StatusMap normalizes a source's raw status. The custom map takes priority; keys
// are compared case-insensitively with "_" and "-" as spaces. Unknown is todo.
func StatusMap(raw string, custom map[string]string) string {
	k := normKey(raw)
	for ck, v := range custom {
		if normKey(ck) == k {
			return normValue(v)
		}
	}
	if v, ok := defaultStatuses[strings.ToLower(strings.TrimSpace(raw))]; ok {
		return v
	}
	if v, ok := defaultStatuses[k]; ok {
		return v
	}
	// GitHub "open:<label>": the label counts.
	if strings.HasPrefix(raw, "open:") {
		return StatusMap(raw[len("open:"):], custom)
	}
	return "todo"
}

// redact hides the token in msg.
func redact(msg, token string) string {
	if token == "" {
		return msg
	}
	msg = strings.ReplaceAll(msg, token, "***")
	if b, err := json.Marshal(token); err == nil && len(b) > 2 {
		msg = strings.ReplaceAll(msg, string(b[1:len(b)-1]), "***")
	}
	return msg
}

// Kinds returns the registered kinds (without "none"), sorted.
func Kinds() []string {
	out := make([]string, 0, len(factories))
	for k := range factories {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

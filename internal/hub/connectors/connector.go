// Package connectors implementa los conectores de tickets (ejecutable, GitHub, Paperclip)
// y el sincronizador periódico. No depende del paquete hub.
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

// ErrNoConnector: el proyecto no tiene conector (kind none o vacío).
var ErrNoConnector = errors.New("el proyecto no tiene conector")

// Connector es la interfaz común de todos los orígenes de tickets.
type Connector interface {
	List(ctx context.Context, since int64) ([]proto.Ticket, error)
	Comment(ctx context.Context, externalID, body string) error
	SetStatus(ctx context.Context, externalID, status string) error
}

// Factory construye un conector de un kind a partir de su configuración.
type Factory func(cfg proto.ConnectorConfig, token string, env []string) (Connector, error)

var factories = map[string]Factory{
	"exec": func(cfg proto.ConnectorConfig, token string, env []string) (Connector, error) {
		return newExec(cfg, token, env, defaultTimeout)
	},
}

// Register añade (o reemplaza) la implementación de un kind; se llama desde init().
func Register(kind string, f Factory) { factories[kind] = f }

// New crea el conector de cfg.Kind; "none" y "" dan ErrNoConnector.
func New(cfg proto.ConnectorConfig, token string, env []string) (Connector, error) {
	if cfg.Kind == "" || cfg.Kind == "none" {
		return nil, ErrNoConnector
	}
	f, ok := factories[cfg.Kind]
	if !ok {
		return nil, fmt.Errorf("conector %q no soportado", cfg.Kind)
	}
	return f(cfg, token, env)
}

var defaultStatuses = map[string]string{
	"por_hacer": "por_hacer", "en_curso": "en_curso", "en_review": "en_review", "hecho": "hecho", "bloqueado": "bloqueado",
	"open": "por_hacer", "todo": "por_hacer", "to do": "por_hacer", "backlog": "por_hacer",
	"in progress": "en_curso", "en curso": "en_curso", "doing": "en_curso",
	"review": "en_review", "in review": "en_review",
	"closed": "hecho", "done": "hecho", "resolved": "hecho", "cancelled": "hecho", "canceled": "hecho",
	"blocked": "bloqueado",
}

func normKey(s string) string {
	return strings.NewReplacer("_", " ", "-", " ").Replace(strings.ToLower(strings.TrimSpace(s)))
}

// StatusMap normaliza el estado crudo de un origen. El mapa custom tiene prioridad; las
// claves se comparan sin mayúsculas y con "_" y "-" como espacio. Lo desconocido es por_hacer.
func StatusMap(raw string, custom map[string]string) string {
	k := normKey(raw)
	for ck, v := range custom {
		if normKey(ck) == k {
			return v
		}
	}
	if v, ok := defaultStatuses[strings.ToLower(strings.TrimSpace(raw))]; ok {
		return v
	}
	if v, ok := defaultStatuses[k]; ok {
		return v
	}
	// GitHub "open:<label>": vale el label.
	if strings.HasPrefix(raw, "open:") {
		return StatusMap(raw[len("open:"):], custom)
	}
	return "por_hacer"
}

// redact oculta el token en msg.
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

// Kinds devuelve los kinds registrados (sin "none"), ordenados.
func Kinds() []string {
	out := make([]string, 0, len(factories))
	for k := range factories {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

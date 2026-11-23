// Package proto define el protocolo compartido entre hub, daemon, mod y app.
// Los tipos se exportan a TypeScript con tygo (ver tygo.yaml).
package proto

import "encoding/json"

const Version = "0.1.0"

type SessionState string

const (
	StateWorking  SessionState = "working"
	StateNeedsYou SessionState = "needs_you"
	StateWaiting  SessionState = "waiting"
	StateIdle     SessionState = "idle"
	StateClosed   SessionState = "closed"
)

type Role string

const (
	RoleWork    Role = "work"
	RoleService Role = "service"
)

type SessionInfo struct {
	ID         string       `json:"id"`
	PreviousID string       `json:"previousId"`
	Machine    string       `json:"machine"`
	Name       string       `json:"name"`
	Cwd        string       `json:"cwd"`
	Root       string       `json:"root"`
	Model      string       `json:"model"`
	Role       Role         `json:"role"`
	State      SessionState `json:"state"`
	ContextPct int          `json:"contextPct"`
	StartedAt  int64        `json:"startedAt"`
	UpdatedAt  int64        `json:"updatedAt"`
	// TranscriptPath es la ruta absoluta del JSONL de Claude Code (vacía si no hay).
	TranscriptPath string `json:"transcriptPath"`
	// Recap es una frase corta (la genera el mod con Haiku) de en qué trabaja la sesión.
	Recap string `json:"recap"`
	// RepoURL y Branch los manda el mod; ProjectID lo calcula el hub (checkout de
	// la máquina y raíz) y nunca se confía en lo que traiga el mod.
	RepoURL   string `json:"repoUrl"`
	Branch    string `json:"branch"`
	ProjectID string `json:"projectId"`
}

type EventKind string

const (
	KindUser           EventKind = "user"
	KindAssistantDelta EventKind = "assistant_delta"
	KindAssistant      EventKind = "assistant"
	KindThinking       EventKind = "thinking"
	KindToolStart      EventKind = "tool_start"
	KindToolEnd        EventKind = "tool_end"
	KindAsk            EventKind = "ask"
	KindAskResolved    EventKind = "ask_resolved"
	KindTurnStart      EventKind = "turn_start"
	KindTurnEnd        EventKind = "turn_end"
	KindStatus         EventKind = "status"
	KindAgentStart     EventKind = "agent_start"
	KindAgentEnd       EventKind = "agent_end"
	KindInfo           EventKind = "info"
	// KindTicket lo emite el mod con /quorum ticket <id>: data {ticket:"<externalId>"}; vacío = desasociar.
	KindTicket EventKind = "ticket"
)

type Event struct {
	Seq     int64           `json:"seq"`
	Session string          `json:"session"`
	TS      int64           `json:"ts"`
	Kind    EventKind       `json:"kind"`
	Data    json.RawMessage `json:"data"`
}

type ToolStart struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Summary string `json:"summary"`
	Agent   string `json:"agent"`
}

type ToolEnd struct {
	ID     string `json:"id"`
	OK     bool   `json:"ok"`
	MS     int64  `json:"ms"`
	Output string `json:"output"`
}

type Ask struct {
	AskID     string          `json:"askId"`
	Kind      string          `json:"kind"` // permission|question
	Tool      string          `json:"tool"`
	Summary   string          `json:"summary"`
	Detail    string          `json:"detail"`
	Questions json.RawMessage `json:"questions"`
}

type AskResolved struct {
	AskID string `json:"askId"`
	By    string `json:"by"` // terminal|device:<id>
}

type TurnEnd struct {
	Answer       string `json:"answer"`
	Reason       string `json:"reason"`
	OutputTokens int    `json:"outputTokens"`
}

type AgentStart struct {
	ID          string `json:"id"`
	Type        string `json:"type"`
	Description string `json:"description"`
}

type AgentEnd struct {
	ID     string `json:"id"`
	Status string `json:"status"`
	Answer string `json:"answer"`
}

// Command es una orden dirigida a una sesión.
type Command struct {
	Type     string            `json:"type"` // prompt|decide|abort|close
	Text     string            `json:"text"`
	Mode     string            `json:"mode"` // now|queue|interrupt
	AskID    string            `json:"askId"`
	Decision string            `json:"decision"` // allow|deny
	Reason   string            `json:"reason"`
	Answers  map[string]string `json:"answers"`
}

// Envelope es el envoltorio WS daemon<->hub y hub<->app.
// Type: hello|session_upsert|session_gone|event|events|command|launch|launch_result|machine_status|backfill|backfill_result|ack|project_upsert|tickets|session_ticket|proposal_upsert|workspace_upsert|workspace_gone|project_gone
// workspace_upsert|workspace_gone (hub->app): Payload Workspace (en gone solo importa el id); el snapshot inicial trae un workspace_upsert por trabajo.
// project_gone (hub->app): Payload {id}.
// proposal_upsert (hub->app): Payload Proposal, en cada alta o cambio.
// project_upsert (hub->app): Payload Project (sin token); el snapshot inicial trae uno por proyecto y se emite al crear, editar o sincronizar.
// tickets (hub->app): Payload {projectId, tickets: []Ticket}, tras una sincronización correcta.
// session_ticket (hub->app): Payload {sessionId, ticketId, confirmed, removed?} al sugerir, confirmar o desasociar un vínculo.
// events (hub->app): Payload []Event de una sesión (historial rellenado, en un solo envelope).
type Envelope struct {
	Type    string          `json:"type"`
	Machine string          `json:"machine"`
	Session string          `json:"session"`
	Payload json.RawMessage `json:"payload"`
}

type MachineHello struct {
	Machine  string        `json:"machine"`
	OS       string        `json:"os"`
	Env      string        `json:"env"` // linux|wsl|windows|darwin
	Version  string        `json:"version"`
	Sessions []SessionInfo `json:"sessions"`
}

type LaunchRequest struct {
	ReqID          string `json:"reqId"`
	Dir            string `json:"dir"`
	Continue       bool   `json:"continue"`
	PermissionMode string `json:"permissionMode"`
	// Prompt es el primer mensaje de la sesión (opcional); TicketID el ticket de origen (lo usa el hub).
	Prompt   string `json:"prompt"`
	TicketID string `json:"ticketId"`
}

type LaunchResult struct {
	ReqID string `json:"reqId"`
	OK    bool   `json:"ok"`
	Error string `json:"error"`
}

// Workspace (trabajo) agrupa proyectos; WhoasProfile es el perfil whoas asociado.
type Workspace struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Color        string `json:"color"`
	WhoasProfile string `json:"whoasProfile"`
}

type Progress struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

// ConnectorConfig: Kind = github|paperclip|exec|none. El token nunca viaja; HasToken indica si existe.
type ConnectorConfig struct {
	Kind        string            `json:"kind"`
	Settings    map[string]string `json:"settings"`
	HasToken    bool              `json:"hasToken"`
	IntervalMin int               `json:"intervalMin"`
}

type Project struct {
	ID          string          `json:"id"`
	WorkspaceID string          `json:"workspaceId"`
	Name        string          `json:"name"`
	RepoURL     string          `json:"repoUrl"`
	Connector   ConnectorConfig `json:"connector"`
	Summary     string          `json:"summary"`
	SummaryAt   int64           `json:"summaryAt"`
	Progress    Progress        `json:"progress"`
	SyncError   string          `json:"syncError"`
	SyncedAt    int64           `json:"syncedAt"`
}

type Checkout struct {
	ID        string `json:"id"`
	ProjectID string `json:"projectId"`
	Machine   string `json:"machine"`
	Root      string `json:"root"`
	RepoURL   string `json:"repoUrl"`
	Branch    string `json:"branch"`
	UpdatedAt int64  `json:"updatedAt"`
}

type TicketComment struct {
	Author string `json:"author"`
	Body   string `json:"body"`
	At     int64  `json:"at"`
}

// Ticket.Status está normalizado: por_hacer|en_curso|en_review|hecho|bloqueado; RawStatus es el del origen.
type Ticket struct {
	ID         string          `json:"id"`
	ProjectID  string          `json:"projectId"`
	ExternalID string          `json:"externalId"`
	Title      string          `json:"title"`
	Status     string          `json:"status"`
	RawStatus  string          `json:"rawStatus"`
	Assignee   string          `json:"assignee"`
	URL        string          `json:"url"`
	Body       string          `json:"body"`
	Comments   []TicketComment `json:"comments"`
	UpdatedAt  int64           `json:"updatedAt"`
}

type SessionTicket struct {
	SessionID string `json:"sessionId"`
	TicketID  string `json:"ticketId"`
	Confirmed bool   `json:"confirmed"`
	Removed   bool   `json:"removed,omitempty"`
}

// Proposal: Kind = comment|status (en status, Body es el estado normalizado destino); Status = pendiente|enviando|aprobada|rechazada|fallida.
type Proposal struct {
	ID        string `json:"id"`
	TicketID  string `json:"ticketId"`
	Kind      string `json:"kind"`
	Body      string `json:"body"`
	Status    string `json:"status"`
	Error     string `json:"error"`
	CreatedAt int64  `json:"createdAt"`
}

package connectors

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

// The Moontech connector is a read-only source for the employer's admin site: it logs in with a username
// and password (the connector secret), keeps the session cookie in memory only, and reads tickets and
// meeting notes from the site's JSON API.

const (
	mtDefaultBase = "https://moontecx-admin.pages.dev"
	mtTimeout     = 15 * time.Second
	mtMaxBody     = 8 << 20
)

// errReadOnly is returned by every write of a read-only source.
var errReadOnly = errors.New("Moontech: read-only source")

// loginBody is the JSON body of POST /api/auth/login. The field names are not confirmed against the real
// site yet: change them here only.
func loginBody(user, pass string) map[string]string {
	return map[string]string{"username": user, "password": pass}
}

type moontechConnector struct {
	baseURL, product, prefix, person, username string
	password                                   string
	client                                     *http.Client

	mu       sync.Mutex
	loggedIn bool
}

func init() {
	Register("moontech", func(cfg proto.ConnectorConfig, token string, env []string) (Connector, error) {
		return newMoontech(cfg, token, mtTimeout)
	})
}

func newMoontech(cfg proto.ConnectorConfig, password string, timeout time.Duration) (*moontechConnector, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.Settings["baseUrl"]), "/")
	if base == "" {
		base = mtDefaultBase
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("Moontech: baseUrl must be http(s)")
	}
	product := strings.TrimSpace(cfg.Settings["product"])
	if product == "" {
		return nil, errors.New("Moontech: missing product")
	}
	user := strings.TrimSpace(cfg.Settings["username"])
	if user == "" {
		return nil, errors.New("Moontech: missing username")
	}
	jar, _ := cookiejar.New(nil)
	return &moontechConnector{
		baseURL: base, product: product, prefix: normPrefix(cfg.Settings["titlePrefix"]),
		person: strings.TrimSpace(cfg.Settings["person"]), username: user, password: password,
		client: &http.Client{
			Timeout: timeout,
			Jar:     jar,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 5 {
					return errors.New("too many redirects")
				}
				if req.URL.Host != via[0].URL.Host {
					return http.ErrUseLastResponse // never follow the credentials to another host
				}
				return nil
			},
		},
	}, nil
}

// normPrefix lowercases and trims the title prefix, including trailing separators such as ":" or "·",
// so "Ornamel:" and "ornamel" match the same titles.
func normPrefix(s string) string {
	return strings.ToLower(strings.TrimRight(strings.TrimSpace(s), " \t:·-–—|/"))
}

func (m *moontechConnector) errf(format string, a ...any) error {
	return errors.New(redact("Moontech: "+fmt.Sprintf(format, a...), m.password))
}

// login posts the credentials; the session cookie lands in the in-memory jar.
func (m *moontechConnector) login(ctx context.Context) error {
	b, _ := json.Marshal(loginBody(m.username, m.password))
	req, err := http.NewRequestWithContext(ctx, "POST", m.baseURL+"/api/auth/login", bytes.NewReader(b))
	if err != nil {
		return m.errf("%v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	resp, err := m.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return m.errf("login: %v", err)
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, mtMaxBody))
	switch {
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return errors.New("Moontech: login rejected (check username and password)")
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return m.errf("login: HTTP %d", resp.StatusCode)
	}
	m.loggedIn = true
	return nil
}

// get fetches path, logging in first when needed and once more on a 401.
func (m *moontechConnector) get(ctx context.Context, path string) ([]byte, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if !m.loggedIn {
		if err := m.login(ctx); err != nil {
			return nil, err
		}
	}
	data, status, err := m.getOnce(ctx, path)
	if err == nil && status == 401 {
		m.loggedIn = false
		if err := m.login(ctx); err != nil {
			return nil, err
		}
		data, status, err = m.getOnce(ctx, path)
		if err == nil && status == 401 {
			m.loggedIn = false
			return nil, errors.New("Moontech: not authorized after a new login")
		}
	}
	if err != nil {
		return nil, err
	}
	switch {
	case status == 403:
		return nil, errors.New("Moontech: not authorized")
	case status < 200 || status > 299:
		return nil, m.errf("HTTP %d on %s: %s", status, path, clip(string(data), 300))
	}
	return data, nil
}

func (m *moontechConnector) getOnce(ctx context.Context, path string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", m.baseURL+path, nil)
	if err != nil {
		return nil, 0, m.errf("%v", err)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := m.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, 0, ctx.Err()
		}
		return nil, 0, m.errf("%v", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, mtMaxBody+1))
	if err != nil {
		return nil, 0, m.errf("%v", err)
	}
	if len(data) > mtMaxBody {
		return nil, 0, errors.New("Moontech: response too large")
	}
	return data, resp.StatusCode, nil
}

// getList fetches a list that the site returns either bare or wrapped as {"<key>": [...]}.
func (m *moontechConnector) getList(ctx context.Context, path, key string) ([]json.RawMessage, error) {
	data, err := m.get(ctx, path)
	if err != nil {
		return nil, err
	}
	data = bytes.TrimSpace(data)
	var items []json.RawMessage
	if len(data) > 0 && data[0] == '[' {
		if err := json.Unmarshal(data, &items); err != nil {
			return nil, fmt.Errorf("Moontech: invalid response on %s: %v", path, err)
		}
		return items, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil, fmt.Errorf("Moontech: invalid response on %s: %v", path, err)
	}
	raw, ok := obj[key]
	if !ok || string(raw) == "null" {
		return nil, nil
	}
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("Moontech: invalid %q list on %s: %v", key, path, err)
	}
	return items, nil
}

// flexString accepts a JSON string, number or null.
type flexString string

func (f *flexString) UnmarshalJSON(b []byte) error {
	b = bytes.TrimSpace(b)
	if len(b) == 0 || string(b) == "null" {
		*f = ""
		return nil
	}
	if b[0] == '"' {
		var s string
		if err := json.Unmarshal(b, &s); err != nil {
			return err
		}
		*f = flexString(s)
		return nil
	}
	*f = flexString(b) // numbers and booleans as written
	return nil
}

// flexText accepts a string, or a list of strings that becomes one "- " bullet per line.
type flexText string

func (f *flexText) UnmarshalJSON(b []byte) error {
	var s flexString
	if err := s.UnmarshalJSON(b); err == nil && (len(bytes.TrimSpace(b)) == 0 || bytes.TrimSpace(b)[0] != '[') {
		*f = flexText(s)
		return nil
	}
	var list []string
	if err := json.Unmarshal(b, &list); err != nil {
		return err
	}
	lines := make([]string, 0, len(list))
	for _, l := range list {
		if l = strings.TrimSpace(l); l != "" {
			if !strings.HasPrefix(l, "- ") {
				l = "- " + l
			}
			lines = append(lines, l)
		}
	}
	*f = flexText(strings.Join(lines, "\n"))
	return nil
}

// flexList accepts a list of strings, or a string holding a JSON list or comma-separated values.
type flexList []string

func (f *flexList) UnmarshalJSON(b []byte) error {
	var list []string
	if json.Unmarshal(b, &list) == nil {
		*f = list
		return nil
	}
	var s flexString
	if err := s.UnmarshalJSON(b); err != nil {
		return err
	}
	str := strings.TrimSpace(string(s))
	if strings.HasPrefix(str, "[") && json.Unmarshal([]byte(str), &list) == nil {
		*f = list
		return nil
	}
	*f = nil
	for _, p := range strings.Split(str, ",") {
		if p = strings.TrimSpace(p); p != "" {
			*f = append(*f, p)
		}
	}
	return nil
}

type mtTicket struct {
	ID           flexString `json:"id"`
	Title        flexString `json:"title"`
	Detail       flexString `json:"detail"`
	Status       flexString `json:"status"`
	PersonName   flexString `json:"person_name"`
	NoteTitle    flexString `json:"note_title"`
	Product      flexString `json:"product"`
	PlannedStart flexString `json:"planned_start"`
	PlannedEnd   flexString `json:"planned_end"`
	UpdatedAt    flexString `json:"updated_at"`
}

type mtNote struct {
	ID          flexString `json:"id"`
	Title       flexString `json:"title"`
	MeetingDate flexString `json:"meeting_date"`
	Summary     flexText   `json:"summary"`
	Decisions   flexText   `json:"decisions"`
	OpenPoints  flexText   `json:"open_points"`
	Actions     flexText   `json:"actions"`
	Products    flexList   `json:"products"`
	SourceURL   flexString `json:"source_url"`
	NotionURL   flexString `json:"notion_url"`
	UpdatedAt   flexString `json:"updated_at"`
}

var mtTimeLayouts = []string{
	time.RFC3339Nano, "2006-01-02T15:04:05.999999999", "2006-01-02 15:04:05.999999999Z07:00",
	"2006-01-02 15:04:05.999999999",
}

// mtMillis turns an ISO timestamp, an ISO date or a Unix number into Unix ms (0 when empty or unknown).
// Timestamps without a zone are UTC. A bare date is taken at 12:00 UTC, so its calendar day is the same
// in every time zone from UTC-11 to UTC+11 (the app compares planned dates by calendar day).
func mtMillis(s string) int64 {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0
	}
	if d, err := time.Parse("2006-01-02", s); err == nil {
		return d.Add(12 * time.Hour).UnixMilli()
	}
	for _, l := range mtTimeLayouts {
		if t, err := time.Parse(l, s); err == nil {
			return t.UnixMilli()
		}
	}
	if n, err := strconv.ParseFloat(s, 64); err == nil && n > 0 {
		if n < 1e12 { // seconds
			return int64(n * 1000)
		}
		return int64(n)
	}
	return 0
}

// mtDate returns the YYYY-MM-DD day of a date or timestamp ("" when unknown).
func mtDate(s string) string {
	s = strings.TrimSpace(s)
	if len(s) >= 10 {
		if _, err := time.Parse("2006-01-02", s[:10]); err == nil {
			return s[:10]
		}
	}
	if ms := mtMillis(s); ms > 0 {
		return time.UnixMilli(ms).UTC().Format("2006-01-02")
	}
	return ""
}

func (m *moontechConnector) sameProduct(p string) bool {
	return strings.EqualFold(strings.TrimSpace(p), m.product)
}

func (m *moontechConnector) List(ctx context.Context, since int64) ([]proto.Ticket, error) {
	items, err := m.getList(ctx, "/api/tickets", "tickets")
	if err != nil {
		return nil, err
	}
	out := []proto.Ticket{}
	for _, raw := range items {
		var r mtTicket
		if json.Unmarshal(raw, &r) != nil || r.ID == "" {
			continue
		}
		title := string(r.Title)
		if !m.sameProduct(string(r.Product)) {
			continue
		}
		if m.prefix != "" && !strings.HasPrefix(strings.ToLower(strings.TrimSpace(title)), m.prefix) {
			continue
		}
		raw := strings.TrimSpace(string(r.Status))
		out = append(out, proto.Ticket{
			ExternalID:   string(r.ID),
			Title:        strings.TrimSpace(title),
			Body:         clipRunes(string(r.Detail), ghMaxBody),
			Status:       StatusMap(raw, nil),
			RawStatus:    raw,
			Assignee:     strings.TrimSpace(string(r.PersonName)),
			PlannedStart: mtMillis(string(r.PlannedStart)),
			PlannedEnd:   mtMillis(string(r.PlannedEnd)),
			NoteTitle:    strings.TrimSpace(string(r.NoteTitle)),
			URL:          m.baseURL + "/ticket",
			UpdatedAt:    mtMillis(string(r.UpdatedAt)),
		})
	}
	return out, nil
}

// ListNotes returns the meeting notes of the product; with a title prefix, only those that mention it in
// the title, summary, decisions, open points or actions.
func (m *moontechConnector) ListNotes(ctx context.Context) ([]proto.MeetingNote, error) {
	items, err := m.getList(ctx, "/api/notes", "notes")
	if err != nil {
		return nil, err
	}
	out := []proto.MeetingNote{}
	for _, raw := range items {
		var r mtNote
		if json.Unmarshal(raw, &r) != nil || r.ID == "" {
			continue
		}
		in := false
		for _, p := range r.Products {
			if m.sameProduct(p) {
				in = true
				break
			}
		}
		if !in {
			continue
		}
		if m.prefix != "" {
			text := strings.ToLower(strings.Join([]string{string(r.Title), string(r.Summary), string(r.Decisions), string(r.OpenPoints), string(r.Actions)}, "\n"))
			if !strings.Contains(text, m.prefix) {
				continue
			}
		}
		u := firstNonEmpty(strings.TrimSpace(string(r.NotionURL)), strings.TrimSpace(string(r.SourceURL)))
		if u == "" {
			u = m.baseURL + "/notes"
		}
		out = append(out, proto.MeetingNote{
			ExternalID: string(r.ID),
			Title:      strings.TrimSpace(string(r.Title)),
			Date:       mtDate(string(r.MeetingDate)),
			Summary:    string(r.Summary),
			Decisions:  string(r.Decisions),
			OpenPoints: string(r.OpenPoints),
			Actions:    string(r.Actions),
			URL:        u,
			UpdatedAt:  mtMillis(string(r.UpdatedAt)),
		})
	}
	return out, nil
}

func (m *moontechConnector) Comment(context.Context, string, string) error   { return errReadOnly }
func (m *moontechConnector) SetStatus(context.Context, string, string) error { return errReadOnly }

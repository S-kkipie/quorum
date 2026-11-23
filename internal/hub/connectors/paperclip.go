package connectors

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	pcTimeout     = 15 * time.Second
	pcMaxBody     = 8 << 20
	pcMaxComments = 5
	pcMaxFetches  = 30
)

type paperclipConnector struct {
	baseURL, companyID, projectID string
	token                         string
	client                        *http.Client
}

func init() {
	Register("paperclip", func(cfg proto.ConnectorConfig, token string, env []string) (Connector, error) {
		return newPaperclip(cfg, token, pcTimeout)
	})
}

func newPaperclip(cfg proto.ConnectorConfig, token string, timeout time.Duration) (*paperclipConnector, error) {
	base := strings.TrimRight(strings.TrimSpace(cfg.Settings["baseURL"]), "/")
	company := strings.TrimSpace(cfg.Settings["companyId"])
	if base == "" || company == "" {
		return nil, errors.New("Paperclip: missing baseURL/companyId")
	}
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, errors.New("Paperclip: baseURL must be http(s)")
	}
	return &paperclipConnector{
		baseURL: base, companyID: company, projectID: strings.TrimSpace(cfg.Settings["projectId"]), token: token,
		client: &http.Client{
			Timeout: timeout,
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 5 {
					return errors.New("too many redirects")
				}
				if req.URL.Host != via[0].URL.Host {
					return http.ErrUseLastResponse // never send the token to another host
				}
				return nil
			},
		},
	}, nil
}

func (p *paperclipConnector) do(ctx context.Context, method, path string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, p.baseURL+path, rd)
	if err != nil {
		return errors.New(redact("Paperclip: "+err.Error(), p.token))
	}
	req.Header.Set("Accept", "application/json")
	if p.token != "" {
		req.Header.Set("Authorization", "Bearer "+p.token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := p.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return errors.New(redact("Paperclip: "+err.Error(), p.token))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, pcMaxBody+1))
	if err != nil {
		return errors.New(redact("Paperclip: "+err.Error(), p.token))
	}
	if len(data) > pcMaxBody {
		return errors.New("Paperclip: response too large")
	}
	switch {
	case resp.StatusCode == 401 || resp.StatusCode == 403:
		return errors.New("Paperclip: invalid token")
	case resp.StatusCode == 404:
		return errors.New(redact(fmt.Sprintf("Paperclip: not found (%s)", strings.SplitN(path, "?", 2)[0]), p.token))
	case resp.StatusCode < 200 || resp.StatusCode > 299:
		return errors.New(redact(fmt.Sprintf("Paperclip: HTTP %d: %s", resp.StatusCode, clip(string(data), 300)), p.token))
	}
	if out != nil && len(bytes.TrimSpace(data)) > 0 {
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("Paperclip: invalid response: %v", err)
		}
	}
	return nil
}

type pcIssue struct {
	ID              string          `json:"id"`
	Identifier      string          `json:"identifier"`
	Title           string          `json:"title"`
	Description     string          `json:"description"`
	Body            string          `json:"body"`
	Status          string          `json:"status"`
	URL             string          `json:"url"`
	ProjectID       string          `json:"projectId"`
	HiddenAt        *string         `json:"hiddenAt"`
	Truncated       bool            `json:"descriptionTruncated"`
	AssigneeUserID  string          `json:"assigneeUserId"`
	UpdatedAt       string          `json:"updatedAt"`
	AssigneeAgentID string          `json:"assigneeAgentId"`
	Assignee        json.RawMessage `json:"assignee"`
}

type pcComment struct {
	Body       string          `json:"body"`
	CreatedAt  string          `json:"createdAt"`
	Author     json.RawMessage `json:"author"`
	AuthorID   string          `json:"authorAgentId"`
	UserID     string          `json:"authorUserId"`
	AuthorType string          `json:"authorType"`
	DeletedAt  *string         `json:"deletedAt"`
}

// pcName extracts a name from a value that may be a string or an object {name|displayName|id}.
func pcName(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var o struct{ Name, DisplayName, ID string }
	if json.Unmarshal(raw, &o) == nil {
		for _, v := range []string{o.Name, o.DisplayName, o.ID} {
			if v != "" {
				return v
			}
		}
	}
	return ""
}

func pcMillis(s string) int64 {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0
	}
	return t.UnixMilli()
}

func (p *paperclipConnector) List(ctx context.Context, since int64) ([]proto.Ticket, error) {
	var items []json.RawMessage
	if err := p.do(ctx, "GET", "/api/companies/"+url.PathEscape(p.companyID)+"/issues", nil, &items); err != nil {
		return nil, err
	}
	var tickets []proto.Ticket
	fetches := 0
	for _, raw := range items {
		var is pcIssue
		if json.Unmarshal(raw, &is) != nil || is.ID == "" {
			continue
		}
		if is.HiddenAt != nil && *is.HiddenAt != "" {
			continue
		}
		if p.projectID != "" && is.ProjectID != p.projectID {
			continue
		}
		body := clipRunes(firstNonEmpty(is.Description, is.Body), ghMaxBody)
		if is.Truncated {
			body += "\n\n(description truncated in Paperclip)"
		}
		t := proto.Ticket{
			ExternalID: is.ID,
			Title:      is.Title,
			RawStatus:  is.Status,
			URL:        is.URL,
			Body:       body,
			UpdatedAt:  pcMillis(is.UpdatedAt),
			Assignee:   pcAssignee(is),
		}
		if is.Identifier != "" {
			t.Title = "[" + is.Identifier + "] " + is.Title
		}
		if t.URL == "" {
			t.URL = p.baseURL + "/issues/" + url.PathEscape(is.ID)
		}
		if StatusMap(is.Status, nil) != "done" && fetches < pcMaxFetches {
			fetches++
			if cs, err := p.comments(ctx, is.ID); err == nil {
				t.Comments = cs
			}
		}
		tickets = append(tickets, t)
	}
	return tickets, nil
}

func pcShort(id string) string {
	if r := []rune(id); len(r) > 8 {
		return string(r[:8])
	}
	return id
}

func pcAssignee(is pcIssue) string {
	if n := pcName(is.Assignee); n != "" {
		return n
	}
	if is.AssigneeAgentID != "" {
		return "agent " + pcShort(is.AssigneeAgentID)
	}
	if is.AssigneeUserID != "" {
		return "user " + pcShort(is.AssigneeUserID)
	}
	return ""
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// comments returns the latest 5 comments in chronological order.
func (p *paperclipConnector) comments(ctx context.Context, id string) ([]proto.TicketComment, error) {
	var items []json.RawMessage
	if err := p.do(ctx, "GET", "/api/issues/"+url.PathEscape(id)+"/comments", nil, &items); err != nil {
		return nil, err
	}
	res := make([]proto.TicketComment, 0, len(items))
	for _, raw := range items {
		var c pcComment
		if json.Unmarshal(raw, &c) != nil || (c.DeletedAt != nil && *c.DeletedAt != "") {
			continue
		}
		author := firstNonEmpty(pcName(c.Author), c.AuthorID, c.UserID)
		if author == "" && c.AuthorType == "system" {
			author = "system"
		}
		res = append(res, proto.TicketComment{
			Author: author,
			Body:   c.Body, At: pcMillis(c.CreatedAt),
		})
	}
	// The API may return newest to oldest or the reverse: sort by date.
	for i := 1; i < len(res); i++ {
		for j := i; j > 0 && res[j].At < res[j-1].At; j-- {
			res[j], res[j-1] = res[j-1], res[j]
		}
	}
	if len(res) > pcMaxComments {
		res = res[len(res)-pcMaxComments:]
	}
	return res, nil
}

func (p *paperclipConnector) Comment(ctx context.Context, externalID, body string) error {
	return p.do(ctx, "POST", "/api/issues/"+url.PathEscape(externalID)+"/comments", map[string]string{"body": body, "clientRequestId": uuidV4()}, nil)
}

var pcSetStatus = map[string]string{
	"todo": "todo", "in_progress": "in_progress", "in_review": "in_review", "blocked": "blocked", "done": "done",
}

func (p *paperclipConnector) SetStatus(ctx context.Context, externalID, status string) error {
	s, ok := pcSetStatus[status]
	if !ok {
		return fmt.Errorf("Paperclip: unknown status %q", status)
	}
	return p.do(ctx, "PATCH", "/api/issues/"+url.PathEscape(externalID), map[string]string{"status": s}, nil)
}

func uuidV4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

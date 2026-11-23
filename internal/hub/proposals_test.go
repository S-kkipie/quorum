package hub

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/hub/connectors"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

type fakeConn struct {
	mu    sync.Mutex
	calls []string
	err   error
	delay time.Duration
}

var fake = &fakeConn{}

func (c *fakeConn) reset(err error, delay time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls, c.err, c.delay = nil, err, delay
}

func (c *fakeConn) snapshot() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.calls...)
}

func (c *fakeConn) List(context.Context, int64) ([]proto.Ticket, error) { return nil, nil }
func (c *fakeConn) Comment(_ context.Context, id, body string) error {
	c.mu.Lock()
	d := c.delay
	c.mu.Unlock()
	time.Sleep(d)
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, "comment "+id+" "+body)
	return c.err
}
func (c *fakeConn) SetStatus(_ context.Context, id, st string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.calls = append(c.calls, "status "+id+" "+st)
	return c.err
}
func (c *fakeConn) n() int { c.mu.Lock(); defer c.mu.Unlock(); return len(c.calls) }

func init() {
	connectors.Register("fakew", func(proto.ConnectorConfig, string, []string) (connectors.Connector, error) { return fake, nil })
}

func propFx(t *testing.T, kind string) (*appFx, map[string]string) {
	fake.reset(nil, 0)
	f, p, ids := linkFx(t)
	if kind != "" {
		p.Connector.Kind = kind
		require.NoError(t, f.st.UpdateProject(p))
	}
	f.upsert(t, "s1", "/r/1", linkRepo, "main")
	require.Eventually(t, func() bool { si, err := f.st.Session("s1"); return err == nil && si.ProjectID != "" }, 3*time.Second, 20*time.Millisecond)
	require.Equal(t, 200, f.postJSON(t, "/api/sessions/s1/ticket", `{"ticketId":"`+ids["41"]+`"}`, nil))
	return f, ids
}

func (f *appFx) turnEnd(t *testing.T, answer string) {
	d, _ := json.Marshal(proto.TurnEnd{Answer: answer})
	ev, _ := json.Marshal(proto.Event{Session: "s1", Kind: proto.KindTurnEnd, Data: d})
	f.machineSend(t, proto.Envelope{Type: "event", Session: "s1", Payload: ev})
}

func TestTurnEndsDraftSingleProposal(t *testing.T) {
	f, ids := propFx(t, "fakew")
	f.turnEnd(t, "primero")
	require.Eventually(t, func() bool { ps, _ := f.st.ListProposals(ids["41"]); return len(ps) == 1 }, 3*time.Second, 20*time.Millisecond)
	f.turnEnd(t, strings.Repeat("é", 2000))
	require.Eventually(t, func() bool {
		ps, _ := f.st.ListProposals(ids["41"])
		return len(ps) == 1 && strings.Contains(ps[0].Body, "é")
	}, 3*time.Second, 20*time.Millisecond)
	ps, _ := f.st.ListProposals(ids["41"])
	require.Equal(t, "pendiente", ps[0].Status)
	require.Equal(t, "Avance (Quorum, m1):\n"+strings.Repeat("é", 1500), ps[0].Body)
	require.Zero(t, fake.n(), "nada se escribe sin aprobar")
}

func TestApproveEditedBodyAndDouble(t *testing.T) {
	f, ids := propFx(t, "fakew")
	fake.reset(nil, 200*time.Millisecond)
	f.turnEnd(t, "x")
	require.Eventually(t, func() bool { ps, _ := f.st.ListProposals(ids["41"]); return len(ps) == 1 }, 3*time.Second, 20*time.Millisecond)
	ps, _ := f.st.ListProposals(ids["41"])
	codes := make(chan int, 2)
	for i := 0; i < 2; i++ {
		go func() {
			codes <- f.postJSON(t, "/api/proposals/"+ps[0].ID+"/approve", `{"body":"editado"}`, &proto.Proposal{})
		}()
	}
	a, b := <-codes, <-codes
	require.ElementsMatch(t, []int{200, 409}, []int{a, b})
	require.Equal(t, []string{"comment 41 editado"}, fake.snapshot())
	got, _ := f.st.GetProposal(ps[0].ID)
	require.Equal(t, "aprobada", got.Status)
	require.Equal(t, "editado", got.Body)
	require.Equal(t, 409, f.postJSON(t, "/api/proposals/"+ps[0].ID+"/reject", `{}`, &map[string]string{}))
}

func TestApproveFailureAndReject(t *testing.T) {
	f, ids := propFx(t, "fakew")
	fake.reset(errors.New("boom"), 0)
	f.turnEnd(t, "x")
	require.Eventually(t, func() bool { ps, _ := f.st.ListProposals(ids["41"]); return len(ps) == 1 }, 3*time.Second, 20*time.Millisecond)
	ps, _ := f.st.ListProposals(ids["41"])
	var got proto.Proposal
	require.Equal(t, 200, f.postJSON(t, "/api/proposals/"+ps[0].ID+"/approve", ``, &got))
	require.Equal(t, "fallida", got.Status)
	require.Equal(t, "boom", got.Error)

	var st proto.Proposal
	require.Equal(t, 201, f.postJSON(t, "/api/tickets/"+ids["41"]+"/proposals", `{"kind":"status","status":"hecho"}`, &st))
	require.Equal(t, 400, f.postJSON(t, "/api/tickets/"+ids["41"]+"/proposals", `{"kind":"status","status":"nope"}`, &map[string]string{}))
	var rj proto.Proposal
	require.Equal(t, 200, f.postJSON(t, "/api/proposals/"+st.ID+"/reject", ``, &rj))
	require.Equal(t, "rechazada", rj.Status)
}

func TestApproveStatusAndNoConnector(t *testing.T) {
	f, ids := propFx(t, "fakew")
	var st proto.Proposal
	require.Equal(t, 201, f.postJSON(t, "/api/tickets/"+ids["41"]+"/proposals", `{"kind":"status","status":"hecho"}`, &st))
	var got proto.Proposal
	require.Equal(t, 200, f.postJSON(t, "/api/proposals/"+st.ID+"/approve", ``, &got))
	require.Equal(t, "aprobada", got.Status)
	require.Equal(t, []string{"status 41 hecho"}, fake.snapshot())

	f2, ids2 := propFx(t, "")
	var st2 proto.Proposal
	require.Equal(t, 201, f2.postJSON(t, "/api/tickets/"+ids2["41"]+"/proposals", `{"kind":"status","status":"hecho"}`, &st2))
	require.Equal(t, 200, f2.postJSON(t, "/api/proposals/"+st2.ID+"/approve", ``, &got))
	require.Equal(t, "fallida", got.Status)
	require.Equal(t, "el proyecto no tiene conector", got.Error)
}

func TestStartupFailsInterruptedProposals(t *testing.T) {
	f, ids := propFx(t, "fakew")
	p, err := f.st.CreateProposal(proto.Proposal{TicketID: ids["41"], Kind: "comment", Body: "x"})
	require.NoError(t, err)
	require.NoError(t, f.st.TransitionProposal(p.ID, "pendiente", "enviando"))
	NewServer(f.st) // el arranque limpia lo que quedó enviando
	got, _ := f.st.GetProposal(p.ID)
	require.Equal(t, "fallida", got.Status)
	require.Equal(t, "interrumpida; verifica en la ticketera", got.Error)
}

package connectors

import (
	"context"
	"strings"
	"sync"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestAdminSiteIsReadOnlyFullListReusable(t *testing.T) {
	require.True(t, ReadOnly("moontech"))
	require.False(t, ReadOnly("github"))
	require.Contains(t, ReadOnlyKinds(), "moontech")
	f := newFakeAdminSite(t)
	c := newMT(t, f)
	require.True(t, c.FullList())
	require.True(t, c.Reusable())
}

// A full-list source: a ticket deleted at the source, or moved to another product, leaves the store with its links.
func TestSyncAdminSitePrunesMissingTickets(t *testing.T) {
	f := newFakeAdminSite(t)
	st, sy, p, calls := newMTSync(t, f)
	var mu sync.Mutex
	var removed []proto.SessionTicket
	sy.OnLinksRemoved = func(id string, ls []proto.SessionTicket) {
		mu.Lock()
		removed = append(removed, ls...)
		mu.Unlock()
	}
	require.NoError(t, sy.SyncNow(p.ID))
	ts, _ := st.ListTickets(p.ID)
	require.Len(t, ts, 4)
	var t11 string
	for _, x := range ts {
		if x.ExternalID == "11" {
			t11 = x.ID
		}
	}
	require.NoError(t, st.UpsertSession(proto.SessionInfo{ID: "s1", Machine: "m", Root: "/r", State: proto.StateIdle}))
	require.NoError(t, st.LinkSessionTicket(proto.SessionTicket{SessionID: "s1", TicketID: t11, Confirmed: true}))

	f.set(func(f *fakeAdminSite) {
		f.tickets[0]["product"] = "Globex" // 11 moved away
		f.tickets = append(f.tickets[:1], f.tickets[2:]...)
	})
	require.NoError(t, sy.SyncNow(p.ID))
	ts, _ = st.ListTickets(p.ID)
	var ids []string
	for _, x := range ts {
		ids = append(ids, x.ExternalID)
	}
	require.ElementsMatch(t, []string{"13", "14"}, ids, "11 moved, 12 deleted")
	c := calls()
	require.Empty(t, c[len(c)-1].changes, "removals write no change-log row")
	mu.Lock()
	require.Equal(t, []proto.SessionTicket{{SessionID: "s1", TicketID: t11, Removed: true}}, removed)
	mu.Unlock()
}

// The admin-site connector (with its cookie jar) is kept between syncs: one login for many syncs; a new token or
// configuration builds a new one.
func TestSyncReusesAdminSiteConnector(t *testing.T) {
	f := newFakeAdminSite(t)
	st, sy, p, _ := newMTSync(t, f)
	for range 3 {
		require.NoError(t, sy.SyncNow(p.ID))
	}
	require.Equal(t, 1, f.loginCount(), "one login for three syncs")

	require.NoError(t, st.SetConnectorToken(p.ID, mtPass)) // same token: same connector
	require.NoError(t, sy.SyncNow(p.ID))
	require.Equal(t, 1, f.loginCount())

	cur, _ := st.GetProject(p.ID)
	cur.Connector.Settings["person"] = "Ben" // configuration changed
	require.NoError(t, st.UpdateProject(cur))
	require.NoError(t, sy.SyncNow(p.ID))
	require.Equal(t, 2, f.loginCount(), "rebuilt after a configuration change")

	require.NoError(t, sy.Invalidate(p.ID, func() error { return nil }))
	require.NoError(t, sy.SyncNow(p.ID))
	require.Equal(t, 3, f.loginCount(), "rebuilt after Invalidate")
}

// A connector that is not Reusable is built again for each sync.
func TestSyncDoesNotCacheOtherConnectors(t *testing.T) {
	f := newFakeAdminSite(t)
	_, sy, p, _ := newMTSync(t, f)
	built := 0
	sy.newConn = func(cfg proto.ConnectorConfig, token string, env []string) (Connector, error) {
		built++
		c, err := New(cfg, token, env)
		if err != nil {
			return nil, err
		}
		return plainConn{c}, nil
	}
	require.NoError(t, sy.SyncNow(p.ID))
	require.NoError(t, sy.SyncNow(p.ID))
	require.Equal(t, 2, built)
}

// plainConn hides the optional interfaces of the connector it wraps.
type plainConn struct{ c Connector }

func (p plainConn) List(ctx context.Context, since int64) ([]proto.Ticket, error) {
	return p.c.List(ctx, since)
}
func (p plainConn) Comment(ctx context.Context, id, body string) error {
	return p.c.Comment(ctx, id, body)
}
func (p plainConn) SetStatus(ctx context.Context, id, status string) error {
	return p.c.SetStatus(ctx, id, status)
}

// A full-list source that answers a valid but empty list never prunes the project down to zero; it logs once.
func TestSyncAdminSiteEmptyListKeepsTickets(t *testing.T) {
	f := newFakeAdminSite(t)
	st, sy, p, _ := newMTSync(t, f)
	buf := captureLog(t)
	require.NoError(t, sy.SyncNow(p.ID))
	before, _ := st.ListTickets(p.ID)
	require.Len(t, before, 4)

	f.set(func(f *fakeAdminSite) { f.tickets = nil; f.wrapped = true })
	require.NoError(t, sy.SyncNow(p.ID))
	require.NoError(t, sy.SyncNow(p.ID))
	after, _ := st.ListTickets(p.ID)
	require.Len(t, after, 4, "kept")
	require.Equal(t, 1, strings.Count(buf.String(), "listed no tickets"), "logged once")

	// a non-empty list prunes again
	f.set(func(f *fakeAdminSite) {
		f.tickets = []map[string]any{{"id": 11, "title": "Atlas · fix login", "status": "por_hacer", "person_name": "Ana", "product": "Acme"}}
	})
	require.NoError(t, sy.SyncNow(p.ID))
	after, _ = st.ListTickets(p.ID)
	require.Len(t, after, 1)
}

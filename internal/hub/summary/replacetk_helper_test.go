package summary

import (
	"time"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
)

// replaceTk upserts tickets and drops the change log, for tests that only need the rows.
func replaceTk(st *store.Store, projectID string, ts []proto.Ticket) error {
	_, err := st.ReplaceTickets(projectID, ts, time.Now().UnixMilli())
	return err
}

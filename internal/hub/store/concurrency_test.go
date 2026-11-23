package store

import (
	"fmt"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// The owner runs `quorum-hub pair`/`link-code` (another process, another Store) while `serve`
// syncs: transactions that read and then write must not fail with SQLITE_BUSY.
func TestTwoStoresConcurrentWriteTx(t *testing.T) {
	path := filepath.Join(t.TempDir(), "h.db")
	a, err := Open(path)
	require.NoError(t, err)
	defer a.Close()
	b, err := Open(path)
	require.NoError(t, err)
	defer b.Close()
	p := mkProject(t, a)

	const n = 40
	var wg sync.WaitGroup
	errs := make(chan error, 4*n)
	for _, st := range []*Store{a, b} {
		wg.Add(2)
		go func(st *Store) {
			defer wg.Done()
			for i := 0; i < n; i++ {
				ts := []proto.Ticket{{ExternalID: fmt.Sprint(i % 5), Title: "t", Status: "todo", UpdatedAt: time.Now().UnixMilli()}}
				if err := st.ReplaceTickets(p.ID, ts); err != nil {
					errs <- err
				}
			}
		}(st)
		go func(st *Store) {
			defer wg.Done()
			for i := 0; i < n; i++ {
				if _, err := st.CreateCode("pair"); err != nil {
					errs <- err
				}
			}
		}(st)
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		require.NoError(t, err)
	}
}

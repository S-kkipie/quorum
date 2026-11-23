package hub

import (
	"path/filepath"
	"testing"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestAttachCheckoutTouchesOnlyOnNewAssociation(t *testing.T) {
	st, err := store.Open(filepath.Join(t.TempDir(), "h.db"))
	require.NoError(t, err)
	defer st.Close()
	w, _ := st.CreateWorkspace(proto.Workspace{Name: "w"})
	p, err := st.CreateProject(proto.Project{WorkspaceID: w.ID, Name: "p", RepoURL: "https://github.com/o/r"})
	require.NoError(t, err)
	h := newHub(st)
	touches := 0
	h.touch = func(string) { touches++ }
	hello := func(id string) {
		si := proto.SessionInfo{ID: id, Root: "/r", RepoURL: "https://github.com/o/r", Role: proto.RoleWork}
		h.attachCheckout("m", &si)
		require.Equal(t, p.ID, si.ProjectID)
	}
	hello("s1")
	require.Equal(t, 2, touches) // new checkout and new session
	hello("s1")
	hello("s1")
	require.Equal(t, 2, touches) // reconnection: nothing
	hello("s2")
	require.Equal(t, 3, touches) // new session in the project
	h.forgetSuggested("s2")
	hello("s2")
	require.Equal(t, 4, touches) // reopened: notifies again
}

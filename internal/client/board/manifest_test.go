package board

import (
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

// The herdr plugin manifest declares the board pane and the action that opens it, and nothing that
// runs on its own.
func TestPluginManifest(t *testing.T) {
	b, err := os.ReadFile("../../../herdr-plugin/herdr-plugin.toml")
	require.NoError(t, err)
	s := string(b)
	for _, want := range []string{
		`id = "quorum"`,
		`min_herdr_version = "0.9.5"`,
		`platforms = ["linux"]`,
		"[[panes]]\nid = \"board\"",
		`placement = "overlay"`,
		`command = ["quorum", "board"]`,
		"[[actions]]\nid = \"board\"",
		"plugin pane open --plugin quorum --entrypoint board",
	} {
		require.Contains(t, s, want)
	}
	for _, banned := range []string{"[[startup]]", "[[events]]", "[[build]]"} {
		require.NotContains(t, s, banned)
	}
}

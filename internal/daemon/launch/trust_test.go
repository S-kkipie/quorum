package launch

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestTrustDirPreservesOtherKeys(t *testing.T) {
	home := t.TempDir()
	p := filepath.Join(home, ".claude.json")
	orig := `{
  "zeta": 1,
  "numStartups": 42,
  "projects": {
    "/other": {
      "allowedTools": [],
      "hasTrustDialogAccepted": false
    },
    "/w": {
      "zz": "x",
      "hasTrustDialogAccepted": false,
      "aa": {"k": [1, 2]}
    }
  },
  "alpha": {"nested": true}
}`
	require.NoError(t, os.WriteFile(p, []byte(orig), 0o640))
	require.NoError(t, TrustDir(home, "/w"))
	b, err := os.ReadFile(p)
	require.NoError(t, err)
	want := `{
  "zeta": 1,
  "numStartups": 42,
  "projects": {
    "/other": {
      "allowedTools": [],
      "hasTrustDialogAccepted": false
    },
    "/w": {
      "zz": "x",
      "hasTrustDialogAccepted": true,
      "aa": {
        "k": [
          1,
          2
        ]
      }
    }
  },
  "alpha": {
    "nested": true
  }
}`
	require.Equal(t, want, string(b))
	st, _ := os.Stat(p)
	require.Equal(t, os.FileMode(0o640), st.Mode().Perm())

	// new entry: appended at the end of projects
	require.NoError(t, TrustDir(home, `/new "x"`))
	b, _ = os.ReadFile(p)
	require.Contains(t, string(b), `"/new \"x\"": {
      "hasTrustDialogAccepted": true
    }
  },
  "alpha"`)
	left, _ := filepath.Glob(filepath.Join(home, ".claude.json.*"))
	require.Empty(t, left)
}

func TestTrustDirNoopWhenTrusted(t *testing.T) {
	home := t.TempDir()
	p := filepath.Join(home, ".claude.json")
	orig := `{"projects":{"/w":{"hasTrustDialogAccepted":true}},"b":2}`
	require.NoError(t, os.WriteFile(p, []byte(orig), 0o600))
	before, _ := os.Stat(p)
	require.NoError(t, TrustDir(home, "/w"))
	after, _ := os.Stat(p)
	require.Equal(t, before.ModTime(), after.ModTime())
	b, _ := os.ReadFile(p)
	require.Equal(t, orig, string(b))
}

func TestTrustDirCreatesFile(t *testing.T) {
	home := t.TempDir()
	require.NoError(t, TrustDir(home, "/w"))
	b, err := os.ReadFile(filepath.Join(home, ".claude.json"))
	require.NoError(t, err)
	require.JSONEq(t, `{"projects":{"/w":{"hasTrustDialogAccepted":true}}}`, string(b))
	st, _ := os.Stat(filepath.Join(home, ".claude.json"))
	require.Equal(t, os.FileMode(0o600), st.Mode().Perm())
}

func TestTrustDirRetriesWhenChanged(t *testing.T) {
	home := t.TempDir()
	p := filepath.Join(home, ".claude.json")
	require.NoError(t, os.WriteFile(p, []byte(`{"a":1}`), 0o600))
	n := 0
	old := beforeRename
	t.Cleanup(func() { beforeRename = old })
	beforeRename = func() {
		n++
		if n == 1 { // another process writes between the read and the rename
			require.NoError(t, os.WriteFile(p, []byte(`{"a":1,"b":2}`), 0o600))
			future := statMtime(t, p).Add(2e9)
			require.NoError(t, os.Chtimes(p, future, future))
		}
	}
	require.NoError(t, TrustDir(home, "/w"))
	require.Equal(t, 2, n)
	b, _ := os.ReadFile(p)
	require.JSONEq(t, `{"a":1,"b":2,"projects":{"/w":{"hasTrustDialogAccepted":true}}}`, string(b))

	// always changes: gives up after 3 attempts without overwriting anything
	n = 0
	beforeRename = func() {
		n++
		future := statMtime(t, p).Add(2e9)
		require.NoError(t, os.Chtimes(p, future, future))
	}
	require.Error(t, TrustDir(home, "/another"))
	require.Equal(t, 3, n)
	b, _ = os.ReadFile(p)
	require.NotContains(t, string(b), "/another")
	left, _ := filepath.Glob(filepath.Join(home, ".claude.json.*"))
	require.Empty(t, left)
}

func statMtime(t *testing.T, p string) (m time.Time) {
	st, err := os.Stat(p)
	require.NoError(t, err)
	return st.ModTime()
}

func TestTrustDirKeepsHTMLChars(t *testing.T) {
	home := t.TempDir()
	p := filepath.Join(home, ".claude.json")
	require.NoError(t, os.WriteFile(p, []byte(`{"projects":{"/a&b":{"x":"<y>"}}}`), 0o600))
	require.NoError(t, TrustDir(home, "/c<d>&e"))
	b, _ := os.ReadFile(p)
	require.Contains(t, string(b), `"/a&b"`)
	require.Contains(t, string(b), `"/c<d>&e"`)
	require.Contains(t, string(b), `"<y>"`)
	require.NotContains(t, string(b), `\u00`)
}

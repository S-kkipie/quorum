package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestExternalURLOK(t *testing.T) {
	require.True(t, externalURLOK("http://hub:7420/v/ab/x.html"))
	require.True(t, externalURLOK("https://hub.example/v/ab/x.html?a=1"))
	for _, bad := range []string{"", "file:///C:/x.html", "javascript:alert(1)", "ftp://h/x", "/v/ab/x.html", "http://", "\x7f"} {
		require.False(t, externalURLOK(bad), bad)
	}
}

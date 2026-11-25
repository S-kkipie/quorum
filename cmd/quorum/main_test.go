package main

import (
	"errors"
	"fmt"
	"testing"

	"github.com/S-kkipie/quorum/internal/client"
	"github.com/stretchr/testify/require"
)

func TestExitCode(t *testing.T) {
	require.Equal(t, 2, exitCode(client.ErrNotPaired))
	require.Equal(t, 2, exitCode(fmt.Errorf("%w (bad json)", client.ErrBadConfig)))
	require.Equal(t, 2, exitCode(client.ErrUnauthorized))
	require.Equal(t, 1, exitCode(errors.New("dial tcp: connection refused")))
}

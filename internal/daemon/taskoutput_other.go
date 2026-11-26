//go:build !linux

package daemon

// fileHolders is unknown off Linux (no /proc).
func fileHolders(string) ([]procInfo, bool) { return nil, false }

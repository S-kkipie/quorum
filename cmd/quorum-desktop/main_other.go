//go:build !windows

package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "quorum-desktop runs on Windows only; elsewhere open the hub in a browser")
	os.Exit(1)
}

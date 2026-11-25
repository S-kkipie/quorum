package board

import (
	"strings"

	"github.com/mattn/go-runewidth"
)

// width is the display width in terminal columns (CJK and emoji take two).
func width(s string) int { return runewidth.StringWidth(s) }

// cut shortens s to at most n columns, on a rune boundary, ending in "…" when it was cut.
func cut(s string, n int) string {
	if n <= 0 {
		return ""
	}
	if width(s) <= n {
		return s
	}
	var b strings.Builder
	for _, r := range s {
		next := b.String() + string(r)
		if width(next)+1 > n {
			break
		}
		b.WriteRune(r)
	}
	return b.String() + "…"
}

// pad fills s with spaces up to n columns.
func pad(s string, n int) string {
	if w := width(s); w < n {
		return s + strings.Repeat(" ", n-w)
	}
	return s
}

// fit cuts s to n columns.
func fit(s string, n int) string { return cut(s, n) }

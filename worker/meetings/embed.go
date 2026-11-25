// Package meetings embeds the Python meeting worker, so quorumd deploys the worker that matches its
// own version (`quorumd meetings setup`, and again before each job when the file changed).
package meetings

import _ "embed"

// Worker is worker.py.
//
//go:embed worker.py
var Worker []byte

// Requirements is the worker venv's pinned requirements.txt.
//
//go:embed requirements.txt
var Requirements []byte

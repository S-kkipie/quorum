package daemon

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"log"
	"os"
	"path/filepath"
	"sync"
)

// pluginStateMax caps a store file read (another plugin's file: never trusted to be small).
const pluginStateMax = 4 << 20

// plugin name -> (store file prefix, key prefix inside the file)
var pluginStores = map[string]struct{ file, key string }{
	"after":        {"after", "queue:"},
	"time-machine": {"time-machine", "session:"},
}

var (
	pluginStateWarn   = func(msg string) { log.Print(msg) }
	pluginStateWarned sync.Map // warned once per file per daemon run
)

func init() {
	rpcHandlers["plugin_state"] = rpcPluginState
}

func warnOnce(file, msg string) {
	if _, dup := pluginStateWarned.LoadOrStore(file, true); !dup {
		pluginStateWarn(msg)
	}
}

// rpcPluginState reads another plugin's store file (read-only) and returns only this
// session's value, or null when there is none or the file has an unknown shape.
func rpcPluginState(_ context.Context, _ *Host, params json.RawMessage) (any, error) {
	var p struct {
		ConfigDir string `json:"configDir"`
		Plugin    string `json:"plugin"`
		Session   string `json:"session"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	st, ok := pluginStores[p.Plugin]
	if !ok {
		return nil, errors.New("unknown plugin")
	}
	if !filepath.IsAbs(p.ConfigDir) {
		return nil, errors.New("configDir must be absolute")
	}
	if p.Session == "" {
		return nil, errors.New("missing session")
	}
	dir := filepath.Join(filepath.Clean(p.ConfigDir), "plugins", "store")
	// The names are matched, not the path: the config dir may hold glob metacharacters.
	entries, err := os.ReadDir(dir)
	if err != nil {
		return json.RawMessage("null"), nil
	}
	for _, e := range entries {
		if ok, _ := filepath.Match(st.file+"_better-claude-*.json", e.Name()); !ok || !e.Type().IsRegular() {
			continue
		}
		path := filepath.Join(dir, e.Name())
		val, err := readStoreKey(path, st.key+p.Session)
		if errors.Is(err, errStateTooLarge) {
			return nil, err
		}
		var oe *storeOpenError
		if errors.As(err, &oe) {
			warnOnce(path, "plugin_state: cannot open "+e.Name()+": "+oe.err.Error())
			continue
		}
		if err != nil {
			warnOnce(path, "plugin_state: ignoring "+e.Name()+": unexpected content")
			continue
		}
		if val != nil {
			return val, nil
		}
	}
	return json.RawMessage("null"), nil
}

var errStateTooLarge = errors.New("state too large")

// storeOpenError is a store file that exists but cannot be opened (logged once).
type storeOpenError struct{ err error }

func (e *storeOpenError) Error() string { return e.err.Error() }

// readStoreKey returns the raw JSON of one key, nil if the key is absent or the file vanished.
// It opens without blocking on a FIFO or following a final symlink, and reads only a regular file.
func readStoreKey(path, key string) (json.RawMessage, error) {
	f, err := openNoFollow(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil // vanished between listing and open
	}
	if err != nil {
		return nil, &storeOpenError{err}
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		return nil, &storeOpenError{err}
	}
	if !st.Mode().IsRegular() {
		return nil, nil // swapped for something else since the listing
	}
	b, err := io.ReadAll(io.LimitReader(f, pluginStateMax+1))
	if err != nil {
		return nil, err
	}
	if len(b) > pluginStateMax {
		return nil, errStateTooLarge
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return m[key], nil
}

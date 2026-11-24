package daemon

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/S-kkipie/quorum/internal/viewguard"
)

const fileReadMaxChunk = 1 << 20

// fileReadMaxSize is the largest file file_read serves (a variable so tests can lower it).
var fileReadMaxSize int64 = 50 << 20

var (
	errOutsideBase  = errors.New("outside the project folder")
	errNoFile       = errors.New("does not exist")
	errNotFile      = errors.New("not a file")
	errFileBig      = errors.New("file too large")
	errCouldNotRead = errors.New("could not read the file")
)

type fileReadResult struct {
	Data string `json:"data"` // base64
	Size int64  `json:"size"`
	EOF  bool   `json:"eof"`
}

func init() {
	rpcHandlers["file_read"] = rpcFileRead
}

// inside reports whether p is base or lives under it.
func inside(base, p string) bool {
	rel, err := filepath.Rel(base, p)
	if err != nil {
		return false
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}

// servableImage reports whether a resolved absolute path is an image name and not a sensitive path.
func servableImage(p string) bool {
	s := strings.TrimLeft(filepath.ToSlash(strings.TrimPrefix(p, filepath.VolumeName(p))), "/")
	return viewguard.IsImage(p) && !viewguard.Sensitive(s)
}

// rpcFileRead returns a chunk of a file that lives inside the base folder.
func rpcFileRead(_ context.Context, _ *Host, params json.RawMessage) (any, error) {
	var p struct {
		Path   string `json:"path"`
		Base   string `json:"base"`
		Offset int64  `json:"offset"`
		Length int    `json:"length"`
		// ImageOnly: a single-file image link (pasted or read image); the file it resolves to
		// must still be an image and not a sensitive path.
		ImageOnly bool `json:"imageOnly"`
	}
	if err := decodeParams(params, &p); err != nil {
		return nil, err
	}
	if !filepath.IsAbs(p.Path) || !filepath.IsAbs(p.Base) {
		return nil, errors.New("path and base must be absolute")
	}
	if p.Offset < 0 {
		return nil, errors.New("invalid offset")
	}
	// lexical check first: "base/../x" must not leak whether x exists
	if !inside(filepath.Clean(p.Base), filepath.Clean(p.Path)) {
		return nil, errOutsideBase
	}
	base, err := filepath.EvalSymlinks(p.Base)
	if err != nil {
		return nil, errNoFile
	}
	path, err := filepath.EvalSymlinks(p.Path)
	if err != nil {
		return nil, errNoFile
	}
	if !inside(base, path) || (p.ImageOnly && !servableImage(path)) {
		return nil, errOutsideBase
	}
	f, err := openNoFollow(path)
	if err != nil {
		return nil, errNoFile
	}
	defer f.Close()
	// on Linux, make sure the opened file is still inside the base (guards against
	// a swap between EvalSymlinks and open)
	if real, err := os.Readlink("/proc/self/fd/" + strconv.Itoa(int(f.Fd()))); err == nil && filepath.IsAbs(real) {
		if !inside(base, real) || (p.ImageOnly && !servableImage(real)) {
			return nil, errOutsideBase
		}
	}
	st, err := f.Stat()
	if err != nil {
		return nil, errCouldNotRead
	}
	if !st.Mode().IsRegular() {
		return nil, errNotFile
	}
	size := st.Size()
	if size > fileReadMaxSize {
		return nil, errFileBig
	}
	if p.Offset > size {
		return nil, errors.New("invalid offset")
	}
	n := p.Length
	if n <= 0 || n > fileReadMaxChunk {
		n = fileReadMaxChunk
	}
	if rest := size - p.Offset; int64(n) > rest {
		n = int(rest)
	}
	buf := make([]byte, n)
	got, err := f.ReadAt(buf, p.Offset)
	if err != nil && !errors.Is(err, io.EOF) {
		return nil, errCouldNotRead
	}
	buf = buf[:got]
	return fileReadResult{
		Data: base64.StdEncoding.EncodeToString(buf),
		Size: size,
		EOF:  p.Offset+int64(got) >= size,
	}, nil
}

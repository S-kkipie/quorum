package launch

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
)

// beforeRename se llama justo antes de comprobar el mtime y renombrar; para tests.
var beforeRename = func() {}

// TrustDir marca dir como de confianza en <home>/.claude.json
// (projects[dir].hasTrustDialogAccepted = true), para que Claude no abra el diálogo.
// Si ya lo está, no escribe. Conserva las demás claves y su orden. Escribe con
// temporal + rename en el mismo directorio y con el mismo modo; si el fichero cambió
// entre la lectura y el rename, reintenta (hasta 3 veces).
func TrustDir(home, dir string) error {
	path := filepath.Join(home, ".claude.json")
	if p, err := filepath.EvalSymlinks(path); err == nil {
		path = p // si es un enlace, se escribe el destino
	}
	for attempt := 0; attempt < 3; attempt++ {
		var (
			raw  []byte
			mode fs.FileMode = 0o600
			mt   int64
		)
		st, err := os.Stat(path)
		switch {
		case err == nil:
			mode, mt = st.Mode().Perm(), st.ModTime().UnixNano()
			if raw, err = os.ReadFile(path); err != nil {
				return err
			}
		case errors.Is(err, fs.ErrNotExist):
			raw = []byte("{}")
		default:
			return err
		}
		out, changed, err := setTrusted(raw, dir)
		if err != nil || !changed {
			return err
		}
		f, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".*")
		if err != nil {
			return err
		}
		tmp := f.Name()
		_, err = f.Write(out)
		if err == nil {
			err = f.Chmod(mode)
		}
		if cerr := f.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			os.Remove(tmp)
			return err
		}
		beforeRename()
		var now int64
		if st, err := os.Stat(path); err == nil {
			now = st.ModTime().UnixNano()
		}
		if now != mt {
			os.Remove(tmp) // otro proceso lo escribió: se vuelve a leer
			continue
		}
		if err := os.Rename(tmp, path); err != nil {
			os.Remove(tmp)
			return err
		}
		return nil
	}
	return fmt.Errorf("%s cambia sin parar; no se tocó", path)
}

// setTrusted devuelve el JSON con projects[dir].hasTrustDialogAccepted = true,
// indentado a 2 espacios como lo deja Claude, y si hubo que cambiar algo.
func setTrusted(raw []byte, dir string) ([]byte, bool, error) {
	top, err := parseObject(raw)
	if err != nil {
		return nil, false, fmt.Errorf(".claude.json inválido: %w", err)
	}
	projects := &object{}
	if v, ok := top.get("projects"); ok && string(v) != "null" {
		if projects, err = parseObject(v); err != nil {
			return nil, false, fmt.Errorf(".claude.json: projects inválido: %w", err)
		}
	}
	entry := &object{}
	if v, ok := projects.get(dir); ok && string(v) != "null" {
		if entry, err = parseObject(v); err != nil {
			return nil, false, fmt.Errorf(".claude.json: projects[%s] inválido: %w", dir, err)
		}
	}
	if v, ok := entry.get("hasTrustDialogAccepted"); ok && string(v) == "true" {
		return nil, false, nil
	}
	entry.set("hasTrustDialogAccepted", json.RawMessage("true"))
	projects.set(dir, entry.marshal())
	top.set("projects", projects.marshal())
	var buf bytes.Buffer
	if err := json.Indent(&buf, top.marshal(), "", "  "); err != nil {
		return nil, false, err
	}
	return buf.Bytes(), true, nil
}

// object es un objeto JSON que conserva el orden de sus claves.
type object struct {
	keys []string
	vals map[string]json.RawMessage
}

func parseObject(b []byte) (*object, error) {
	d := json.NewDecoder(bytes.NewReader(b))
	if t, err := d.Token(); err != nil {
		return nil, err
	} else if t != json.Delim('{') {
		return nil, errors.New("no es un objeto")
	}
	o := &object{vals: map[string]json.RawMessage{}}
	for d.More() {
		t, err := d.Token()
		if err != nil {
			return nil, err
		}
		k, _ := t.(string)
		var v json.RawMessage
		if err := d.Decode(&v); err != nil {
			return nil, err
		}
		o.set(k, v)
	}
	if _, err := d.Token(); err != nil {
		return nil, err
	}
	return o, nil
}

func (o *object) get(k string) (json.RawMessage, bool) {
	v, ok := o.vals[k]
	return v, ok
}

func (o *object) set(k string, v json.RawMessage) {
	if o.vals == nil {
		o.vals = map[string]json.RawMessage{}
	}
	if _, ok := o.vals[k]; !ok {
		o.keys = append(o.keys, k)
	}
	o.vals[k] = v
}

func (o *object) marshal() json.RawMessage {
	var b bytes.Buffer
	b.WriteByte('{')
	for i, k := range o.keys {
		if i > 0 {
			b.WriteByte(',')
		}
		writeKey(&b, k)
		b.WriteByte(':')
		b.Write(o.vals[k])
	}
	b.WriteByte('}')
	return b.Bytes()
}

// writeKey escribe k como cadena JSON sin escapar & < > (json.Marshal los cambia por \u00XX).
func writeKey(b *bytes.Buffer, k string) {
	e := json.NewEncoder(b)
	e.SetEscapeHTML(false)
	_ = e.Encode(k)
	b.Truncate(b.Len() - 1) // Encode agrega '\n'
}

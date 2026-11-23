package convos

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const longPrompt = "Quiero que revises a fondo todo el módulo de facturación y me digas qué partes están rotas y cómo se arreglan"

// copyTestdata copia los JSONL de testdata a una carpeta temporal con mtimes
// en el orden dado (el primero es el más reciente).
func copyTestdata(t *testing.T, names ...string) string {
	t.Helper()
	dir := t.TempDir()
	now := time.Now()
	for i, n := range names {
		b, err := os.ReadFile(filepath.Join("testdata", n+".jsonl"))
		require.NoError(t, err)
		p := filepath.Join(dir, n+".jsonl")
		require.NoError(t, os.WriteFile(p, b, 0o600))
		mt := now.Add(-time.Duration(i) * time.Minute)
		require.NoError(t, os.Chtimes(p, mt, mt))
	}
	return dir
}

func TestListTitlesAndOrder(t *testing.T) {
	dir := copyTestdata(t, "prompt", "ai", "summary", "custom", "empty")
	// ruido: subcarpetas (subagentes) y ficheros que no son .jsonl
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "sub.jsonl"), 0o700))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "notas.txt"), []byte("x"), 0o600))

	got, err := List(dir, nil, 60)
	require.NoError(t, err)
	var ids []string
	for _, c := range got {
		ids = append(ids, c.ID)
	}
	// "empty" no tiene mensajes: no se puede retomar nada útil y se omite.
	require.Equal(t, []string{"prompt", "ai", "summary", "custom"}, ids)

	p := got[0]
	require.Equal(t, longPrompt, p.FirstPrompt)
	require.Equal(t, strings.TrimSpace(string([]rune(longPrompt)[:80])), p.Title)
	require.Equal(t, 2, p.Messages) // el <command-name> y el isMeta no cuentan; el tool_use solo tampoco

	require.Equal(t, "Arreglar el login", got[1].Title)
	require.Equal(t, "arregla el login", got[1].FirstPrompt)
	require.Equal(t, 2, got[1].Messages)

	require.Equal(t, "Resumen del trabajo", got[2].Title)
	require.Equal(t, 3, got[2].Messages)

	require.Equal(t, "Mi título", got[3].Title)

	for i := 1; i < len(got); i++ {
		require.GreaterOrEqual(t, got[i-1].UpdatedAt, got[i].UpdatedAt)
	}
	require.NotZero(t, got[0].UpdatedAt)

	// max acota el resultado
	got, err = List(dir, nil, 2)
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.Equal(t, "prompt", got[0].ID)
}

func TestListMissingDirEmpty(t *testing.T) {
	got, err := List(filepath.Join(t.TempDir(), "no-existe"), nil, 60)
	require.NoError(t, err)
	require.NotNil(t, got)
	require.Empty(t, got)
}

func TestListMarksOpen(t *testing.T) {
	dir := copyTestdata(t, "ai", "custom")
	got, err := List(dir, map[string]bool{"custom": true}, 60)
	require.NoError(t, err)
	require.Len(t, got, 2)
	require.False(t, got[0].Open)
	require.True(t, got[1].Open)
	// la caché no arrastra Open de una llamada a otra
	got, err = List(dir, nil, 60)
	require.NoError(t, err)
	require.False(t, got[1].Open)
}

func TestListCacheInvalidatedOnChange(t *testing.T) {
	dir := copyTestdata(t, "ai")
	p := filepath.Join(dir, "ai.jsonl")
	got, err := List(dir, nil, 60)
	require.NoError(t, err)
	require.Equal(t, "Arreglar el login", got[0].Title)

	f, err := os.OpenFile(p, os.O_APPEND|os.O_WRONLY, 0)
	require.NoError(t, err)
	_, err = f.WriteString(`{"type":"custom-title","customTitle":"Renombrada"}` + "\n")
	require.NoError(t, err)
	require.NoError(t, f.Close())

	got, err = List(dir, nil, 60)
	require.NoError(t, err)
	require.Equal(t, "Renombrada", got[0].Title)
}

func TestListSkipsHugeLines(t *testing.T) {
	dir := t.TempDir()
	huge := `{"type":"custom-title","customTitle":"` + strings.Repeat("x", 2<<20) + `"}`
	body := huge + "\n" + `{"type":"user","message":{"role":"user","content":"hola"}}` + "\n"
	require.NoError(t, os.WriteFile(filepath.Join(dir, "s.jsonl"), []byte(body), 0o600))
	got, err := List(dir, nil, 60)
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "hola", got[0].Title)
	require.Equal(t, 1, got[0].Messages)
}

func TestDirEncoding(t *testing.T) {
	require.Equal(t, filepath.Join("/h", ".claude", "projects", "-home-u-work-proj-x"), Dir("/h", "/home/u/work/proj-x"))
	require.Equal(t, filepath.Join("/h", ".claude", "projects", "-a-b-c-d"), Dir("/h", "/a/b.c_d"))
}

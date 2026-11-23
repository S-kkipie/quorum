// Package launch abre sesiones nuevas de Claude Code en un terminal de la máquina.
//
// Claude siempre se resuelve por el PATH de un shell de login (bash -lc / -lic),
// nunca por ruta absoluta, para respetar los shims de whoas. Excepción: en
// Windows nativo se usa `wt.exe -d <dir> claude`, con el PATH de la sesión de Windows.
package launch

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"time"

	"github.com/S-kkipie/quorum/internal/proto"
)

type Env string

const (
	Linux   Env = "linux"
	WSL     Env = "wsl"
	Windows Env = "windows"
	Darwin  Env = "darwin"
)

var (
	now        = time.Now
	modeRe     = regexp.MustCompile(`^[A-Za-z]+$`)
	runTimeout = 15 * time.Second
	// execFn ejecuta el lanzador y espera a que termine; se inyecta en los tests.
	execFn = runDetached
	// geteuid se inyecta en los tests (Sin permisos no se permite como root).
	geteuid  = os.Geteuid
	resumeRe = regexp.MustCompile(`^[0-9a-fA-F-]{8,64}$`)
	hexRe    = regexp.MustCompile(`[0-9a-fA-F]`)
	notAlnum = regexp.MustCompile(`[^A-Za-z0-9]`)
)

// LaunchReqEnv es la variable de entorno que ata la sesión lanzada a su reqId.
const LaunchReqEnv = "QUORUM_LAUNCH_REQ"

// validResume: id de conversación de 8 a 64 caracteres hex o '-', con al menos un dígito hex
// (así nunca es algo como "--------", que claude leería como opción).
func validResume(id string) bool { return resumeRe.MatchString(id) && hexRe.MatchString(id) }

// launchReqValue es el reqId saneado para el entorno ([A-Za-z0-9]); vacío si no queda nada.
func launchReqValue(reqID string) string { return notAlnum.ReplaceAllString(reqID, "") }

// graceWait es lo que se espera a un lanzador gráfico (wt.exe, osascript) antes
// de darlo por lanzado: pueden quedar vivos reteniendo handles heredados. Variable para tests.
var graceWait = 3 * time.Second

// runDetached arranca bin con la salida a un fichero temporal (sin goroutines de
// copia que bloqueen Wait). tmux -d vuelve al instante y se espera completo; los
// demás se esperan graceWait y, si siguen vivos, se dan por lanzados.
func runDetached(ctx context.Context, bin string, args ...string) ([]byte, error) {
	f, err := os.CreateTemp("", "quorum-launch-*")
	if err != nil {
		return nil, err
	}
	name := f.Name()
	cmd := exec.Command(bin, args...)
	cmd.Stdout, cmd.Stderr = f, f
	err = cmd.Start()
	f.Close() // el hijo tiene su propio handle; el nuestro no debe retener el fichero
	if err != nil {
		os.Remove(name)
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	// Si devolvemos antes de que el hijo termine, el temporal se borra cuando acabe
	// (en Windows no se puede borrar mientras el hijo lo tenga abierto). Best effort.
	removeLater := func() { go func() { <-done; os.Remove(name) }() }
	var grace <-chan time.Time
	if bin != "tmux" {
		t := time.NewTimer(graceWait)
		defer t.Stop()
		grace = t.C
	}
	select {
	case err := <-done:
		out, _ := os.ReadFile(name)
		os.Remove(name)
		return out, err
	case <-grace:
		removeLater()
		return nil, nil // sigue vivo: se considera lanzado
	case <-ctx.Done():
		_ = cmd.Process.Kill()
		removeLater()
		return nil, ctx.Err()
	}
}

// DetectEnv deduce el entorno de ejecución actual.
func DetectEnv() Env {
	if runtime.GOOS == "linux" {
		if os.Getenv("WSL_DISTRO_NAME") != "" {
			return WSL
		}
		if b, err := os.ReadFile("/proc/version"); err == nil && strings.Contains(strings.ToLower(string(b)), "microsoft") {
			return WSL
		}
		return Linux
	}
	return Env(runtime.GOOS)
}

// shellQuote envuelve s en comillas simples para un shell POSIX.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// modeFlags traduce el modo de permisos; ok=false si no es válido.
func modeFlags(m string) (flags []string, ok bool) {
	switch m {
	case "":
		return nil, true
	case "default":
		// explícito: si no, claude usa el defaultMode del usuario o la cuenta (p. ej. auto)
		// y la sesión "Normal (pide permisos)" no pediría permisos.
		return []string{"--permission-mode", "default"}, true
	case "bypass":
		return []string{"--dangerously-skip-permissions"}, true
	}
	if !modeRe.MatchString(m) {
		return nil, false
	}
	return []string{"--permission-mode", m}, true
}

// claudeArgs son los argumentos de claude (sin el binario) y el índice del prompt
// (-1 si no hay). El prompt va como argumento posicional tras "--", así nunca se
// confunde con una opción.
func claudeArgs(req proto.LaunchRequest) (parts []string, promptIdx int) {
	promptIdx = -1
	if req.Continue {
		parts = append(parts, "--continue")
	}
	if f, ok := modeFlags(req.PermissionMode); ok { // Run ya rechazó los inválidos
		parts = append(parts, f...)
	}
	if req.Resume != "" && validResume(req.Resume) { // validate ya rechazó los inválidos
		parts = append(parts, "--resume", req.Resume)
	}
	if req.Prompt != "" {
		parts = append(parts, "--", req.Prompt)
		promptIdx = len(parts) - 1
	}
	return parts, promptIdx
}

// claudeLine es la línea de shell POSIX; solo el prompt necesita cita (los flags y
// el id de --resume son seguros). Lleva delante QUORUM_LAUNCH_REQ=<reqId saneado>.
func claudeLine(req proto.LaunchRequest) string {
	args, pi := claudeArgs(req)
	var parts []string
	if v := launchReqValue(req.ReqID); v != "" {
		parts = append(parts, LaunchReqEnv+"="+v)
	}
	parts = append(parts, "claude")
	for i, a := range args {
		if i == pi {
			a = shellQuote(a)
		}
		parts = append(parts, a)
	}
	return strings.Join(parts, " ")
}

// wtEscape escapa ';' (separador de comandos de Windows Terminal).
func wtEscape(s string) string { return strings.ReplaceAll(s, ";", `\;`) }

func appleScriptEscape(s string) string {
	return strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(s)
}

// suffix da un sufijo corto y apto para nombre de sesión tmux (sin '.' ni ':').
func suffix(reqID string) string {
	var b strings.Builder
	for _, r := range reqID {
		if r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' {
			b.WriteRune(r)
		}
		if b.Len() == 6 {
			break
		}
	}
	if b.Len() == 0 {
		var r [3]byte
		_, _ = rand.Read(r[:])
		return hex.EncodeToString(r[:])
	}
	return b.String()
}

func isAbs(env Env, dir string) bool {
	if env == Windows {
		return filepath.IsAbs(dir)
	}
	return strings.HasPrefix(dir, "/")
}

// Argv construye el comando que abre el terminal. hasDisplay queda reservado
// para elegir emulador gráfico en Linux con pantalla; por ahora Linux siempre usa tmux.
func Argv(env Env, req proto.LaunchRequest, hasDisplay bool) (bin string, args []string) {
	line := claudeLine(req)
	switch env {
	case WSL:
		return "wt.exe", []string{"wsl.exe", "-d", os.Getenv("WSL_DISTRO_NAME"), "--cd", wtEscape(req.Dir), "--", "bash", "-lic", line}
	case Windows:
		a := []string{"-d", wtEscape(req.Dir), "claude"}
		cargs, _ := claudeArgs(req)
		return "wt.exe", append(a, cargs...)
	case Darwin:
		script := fmt.Sprintf(`tell app "Terminal" to do script "%s"`,
			appleScriptEscape("cd "+shellQuote(req.Dir)+" && "+line))
		return "osascript", []string{"-e", script}
	default:
		name := "quorum-" + strconv.FormatInt(now().Unix(), 36) + "-" + suffix(req.ReqID)
		return "tmux", []string{"new-session", "-d", "-s", name, "-c", req.Dir, "bash -lc " + shellQuote(line)}
	}
}

// rootBypassMsg es el motivo por el que "Sin permisos" no se ofrece como root.
const rootBypassMsg = "Sin permisos no funciona como root"

// validate comprueba la petición; devuelve el mensaje de error o "".
func validate(env Env, req proto.LaunchRequest) string {
	if _, ok := modeFlags(req.PermissionMode); !ok {
		return "modo de permisos inválido"
	}
	if req.PermissionMode == "bypass" && geteuid() == 0 {
		return rootBypassMsg
	}
	if req.Resume != "" && !validResume(req.Resume) {
		return "id de conversación inválido"
	}
	if !isAbs(env, req.Dir) {
		return "la carpeta debe ser una ruta absoluta"
	}
	if st, err := os.Stat(req.Dir); err != nil || !st.IsDir() {
		return "la carpeta no existe: " + req.Dir
	}
	return ""
}

// trust marca la carpeta como de confianza si se pidió; un fallo solo se registra.
func trust(req proto.LaunchRequest) {
	if !req.Trust {
		return
	}
	home, err := os.UserHomeDir()
	if err == nil {
		err = TrustDir(home, req.Dir)
	}
	if err != nil {
		log.Printf("launch: no se pudo confiar en %s: %v", req.Dir, err)
	}
}

// via es el nombre del lanzador para LaunchResult.Via.
func via(bin string) string {
	if bin == "wt.exe" {
		return "wt"
	}
	return bin
}

// Run valida la petición y lanza el terminal. No espera a que Claude termine.
func Run(ctx context.Context, req proto.LaunchRequest) proto.LaunchResult {
	res := proto.LaunchResult{ReqID: req.ReqID}
	env := DetectEnv()
	if msg := validate(env, req); msg != "" {
		res.Error = msg
		return res
	}
	trust(req)
	req, err := collapsePrompt(env, req)
	if err != nil {
		res.Error = "no se pudo preparar el prompt: " + err.Error()
		return res
	}
	bin, args := Argv(env, req, os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != "")
	ctx, cancel := context.WithTimeout(ctx, runTimeout)
	defer cancel()
	if out, err := execFn(ctx, bin, args...); err != nil {
		msg := strings.TrimSpace(string(out))
		if msg == "" {
			msg = err.Error()
		}
		res.Error = "no se pudo abrir el terminal: " + msg
		return res
	}
	res.OK, res.Via = true, via(bin)
	return res
}

const (
	promptMaxInline = 1000
	promptFileTTL   = 24 * time.Hour
	promptFilePre   = "ticket-"
	legacyPromptPre = "quorum-ticket-" // versiones anteriores lo dejaban en el temporal
)

var unsafeID = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// PromptDir es donde se dejan los prompts largos, dentro de la carpeta de la sesión:
// así claude lo lee sin pedir permiso para salir de su cwd. Conviene ignorarla en git.
func PromptDir(dir string) string { return filepath.Join(dir, ".claude", "quorum") }

// collapsePrompt evita pasar por la línea de comandos (wt.exe, osascript, tmux) un
// prompt con saltos de línea o largo: lo escribe en <dir>/.claude/quorum/ticket-<reqId>.md
// (carpetas 0700, fichero 0600, O_EXCL) y deja un prompt corto que apunta al fichero.
// Los ficheros de más de 24 h se borran en el siguiente lanzamiento (best effort).
//
// En WSL y Windows (wt.exe) también se usa el fichero si el prompt lleva ';', que
// wt.exe toma como separador de comandos: así ningún ';' del prompt llega a su línea
// de comandos (el escapado `\;` no se puede garantizar que llegue limpio a claude).
func collapsePrompt(env Env, req proto.LaunchRequest) (proto.LaunchRequest, error) {
	wt := (env == WSL || env == Windows) && strings.Contains(req.Prompt, ";")
	if req.Prompt == "" || (!wt && !strings.ContainsAny(req.Prompt, "\r\n") && len(req.Prompt) <= promptMaxInline) {
		return req, nil
	}
	return promptToFile(req, false)
}

// promptToFile escribe el prompt en <dir>/.claude/quorum/ticket-<reqId>.md y lo
// cambia por uno corto que apunta al fichero. Con rel, la ruta del prompt es relativa
// a <dir> (el cwd de la sesión): así la carpeta del proyecto, que puede llevar
// comillas, ';' o '$(', nunca llega a la línea que se escribe en un shell.
func promptToFile(req proto.LaunchRequest, rel bool) (proto.LaunchRequest, error) {
	cleanPromptFiles(os.TempDir(), legacyPromptPre)
	dir := PromptDir(req.Dir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return req, err
	}
	cleanPromptFiles(dir, promptFilePre)
	id := unsafeID.ReplaceAllString(req.ReqID, "")
	if id == "" {
		id = suffix("")
	}
	path := filepath.Join(dir, promptFilePre+id+".md")
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return req, err
	}
	_, err = f.WriteString(req.Prompt)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(path)
		return req, err
	}
	shown := path
	if rel {
		shown = ".claude/quorum/" + promptFilePre + id + ".md"
	}
	req.Prompt = "Lee el archivo " + shown + " y trabaja en ese ticket."
	return req, nil
}

func cleanPromptFiles(dir, prefix string) {
	ents, _ := filepath.Glob(filepath.Join(dir, prefix+"*.md"))
	for _, p := range ents {
		if st, err := os.Stat(p); err == nil && now().Sub(st.ModTime()) > promptFileTTL {
			os.Remove(p)
		}
	}
}

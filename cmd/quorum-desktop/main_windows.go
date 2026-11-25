//go:build windows

package main

import (
	"log"
	"os"
	"path/filepath"
	"syscall"
	"time"
	"unsafe"

	"github.com/jchv/go-webview2"
)

// Regenerate rsrc_windows_amd64.syso (the exe icon, resource id 1) with: GOOS=windows go generate ./cmd/quorum-desktop
//go:generate go run github.com/tc-hib/go-winres@v0.3.3 make --arch amd64 --in winres/winres.json --out rsrc

const probeTimeout = 5 * time.Second

// DWM window attributes (Windows 11): dark title bar, border, caption and caption text colours.
const (
	dwmUseImmersiveDarkMode = 20
	dwmBorderColor          = 34
	dwmCaptionColor         = 35
	dwmTextColor            = 36
)

var dwmSet = syscall.NewLazyDLL("dwmapi.dll").NewProc("DwmSetWindowAttribute")

// paintChrome paints the window's title bar and border with the app's background, like Discord does, keeping
// the native caption buttons. Older Windows versions ignore the attributes.
func paintChrome(hwnd uintptr, bg string, dark bool) {
	if dwmSet.Find() != nil || hwnd == 0 {
		return
	}
	set := func(attr uintptr, v uint32) {
		dwmSet.Call(hwnd, attr, uintptr(unsafe.Pointer(&v)), 4)
	}
	var d uint32
	if dark {
		d = 1
	}
	set(dwmUseImmersiveDarkMode, d)
	if c, ok := colorref(bg); ok {
		set(dwmCaptionColor, c)
		set(dwmBorderColor, c)
	}
	text := uint32(0x00111111)
	if dark {
		text = 0x00EEEEEE
	}
	set(dwmTextColor, text)
}

// scaled converts a size in CSS pixels to physical pixels: the app is per-monitor DPI aware (see winres), so
// the window size is given in physical pixels and must follow the display scale (150% → ×1.5).
func scaled(px uint) uint {
	proc := syscall.NewLazyDLL("user32.dll").NewProc("GetDpiForSystem")
	if proc.Find() != nil {
		return px
	}
	dpi, _, _ := proc.Call()
	if dpi == 0 {
		return px
	}
	return px * uint(dpi) / 96
}

func main() {
	base, err := os.UserConfigDir() // %APPDATA%
	if err != nil {
		log.Fatal(err)
	}
	cache, err := os.UserCacheDir() // %LOCALAPPDATA%
	if err != nil {
		log.Fatal(err)
	}
	settingsPath := filepath.Join(base, "Quorum", "desktop.json")
	s := loadSettings(settingsPath)

	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		// localStorage (the device token, drafts, the event cache) lives here and survives restarts.
		DataPath:      filepath.Join(cache, "Quorum", "WebView2"),
		WindowOptions: webview2.WindowOptions{Title: "Quorum", Width: scaled(1440), Height: scaled(900), Center: true, IconId: 1},
	})
	if w == nil {
		log.Fatal("Quorum needs the Microsoft Edge WebView2 runtime")
	}
	defer w.Destroy()

	// open shows the hub, or the fallback page when it does not answer. The probe runs off the UI thread.
	open := func(hub string) {
		go func() {
			ok := reachable(hub, probeTimeout)
			w.Dispatch(func() {
				if ok {
					w.Navigate(hub)
				} else {
					w.SetHtml(page(offlinePage, hub))
				}
			})
		}()
	}

	_ = w.Bind("quorumSetHub", func(raw string) string {
		hub, err := normalizeHub(raw)
		if err != nil {
			return err.Error()
		}
		if err := saveSettings(settingsPath, settings{Hub: hub}); err != nil {
			return "Could not save the hub address: " + err.Error()
		}
		s.Hub = hub
		open(hub)
		return ""
	})
	hwnd := uintptr(w.Window())
	paintChrome(hwnd, "#0E1311", true) // Terminal green dark until the page reports its theme
	_ = w.Bind("quorumChrome", func(bg string, dark bool) { w.Dispatch(func() { paintChrome(hwnd, bg, dark) }) })
	_ = w.Bind("quorumRetry", func() { open(s.Hub) })
	_ = w.Bind("quorumChangeHub", func() { w.SetHtml(page(firstRunPage, s.Hub)) })

	if s.Hub == "" {
		w.SetHtml(page(firstRunPage, ""))
	} else {
		w.SetHtml(page(offlinePage, s.Hub)) // replaced as soon as the probe answers
		open(s.Hub)
	}
	w.Run()
}

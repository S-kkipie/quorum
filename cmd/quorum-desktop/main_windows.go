//go:build windows

package main

import (
	"log"
	"os"
	"path/filepath"
	"time"

	"github.com/jchv/go-webview2"
)

// Regenerate rsrc_windows_amd64.syso (the exe icon, resource id 1) with: GOOS=windows go generate ./cmd/quorum-desktop
//go:generate go run github.com/tc-hib/go-winres@v0.3.3 make --arch amd64 --in winres/winres.json --out rsrc

const probeTimeout = 5 * time.Second

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
		WindowOptions: webview2.WindowOptions{Title: "Quorum", Width: 1280, Height: 860, Center: true, IconId: 1},
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

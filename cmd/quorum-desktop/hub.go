// Command quorum-desktop is the Windows desktop app: a native window (WebView2) that shows the hub's own web
// app, exactly as the browser does. It stores only the hub URL; pairing, the device token and everything else
// live in the web app (WebView2 keeps its localStorage under the app's data folder).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// settings is what the desktop app stores: the hub it opens.
type settings struct {
	Hub string `json:"hub"`
}

// normalizeHub validates a hub URL typed by the owner and reduces it to its origin.
func normalizeHub(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", errors.New("Enter the hub address, starting with http:// or https://")
	}
	return u.Scheme + "://" + u.Host, nil
}

func loadSettings(path string) settings {
	var s settings
	b, err := os.ReadFile(path)
	if err == nil {
		_ = json.Unmarshal(b, &s)
	}
	if h, err := normalizeHub(s.Hub); err == nil {
		s.Hub = h
	} else {
		s.Hub = ""
	}
	return s
}

func saveSettings(path string, s settings) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	b, _ := json.Marshal(s)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// reachable reports whether the hub answers its ping route within the timeout.
func reachable(hub string, timeout time.Duration) bool {
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, hub+"/api/ping", nil)
	if err != nil {
		return false
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode >= 200 && res.StatusCode < 300
}

// colorref turns "#RRGGBB" into a Windows COLORREF (0x00BBGGRR); ok is false for anything else.
func colorref(hex string) (uint32, bool) {
	hex = strings.TrimPrefix(strings.TrimSpace(hex), "#")
	if len(hex) != 6 {
		return 0, false
	}
	v, err := strconv.ParseUint(hex, 16, 32)
	if err != nil {
		return 0, false
	}
	r, g, b := uint32(v>>16)&0xff, uint32(v>>8)&0xff, uint32(v)&0xff
	return b<<16 | g<<8 | r, true
}

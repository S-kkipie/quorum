package hub

import (
	"bytes"
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// PushTarget is one phone to notify: the device that registered the token and its FCM token.
type PushTarget struct {
	Device string
	Token  string
}

// Pusher sends a notification to phones. Push blocks until every target was tried (or its own
// timeout ran out); the hub calls it off the hot path.
type Pusher interface {
	Push(ctx context.Context, targets []PushTarget, title, body string, data map[string]string)
}

const (
	fcmBaseURL   = "https://fcm.googleapis.com"
	fcmScope     = "https://www.googleapis.com/auth/firebase.messaging"
	googleToken  = "https://oauth2.googleapis.com/token"
	pushTimeout  = 10 * time.Second
	maxFCMAnswer = 1 << 16
)

// DefaultFCMKeyFile is where the hub looks for the Firebase service-account key:
// <user config dir>/quorum/fcm.json ("" when the config dir is unknown).
func DefaultFCMKeyFile() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "quorum", "fcm.json")
}

// loadPusher reads the key at path and returns the FCM pusher, or nil (push off) when the key is
// missing or unusable; either case is logged once. gone is called with a token FCM reported gone.
func loadPusher(path string, gone func(token string), logf func(string, ...any)) Pusher {
	if path == "" {
		logf("hub: push is off (no config dir for fcm.json)")
		return nil
	}
	p, err := newFCMPusher(path, gone, logf)
	if errors.Is(err, os.ErrNotExist) {
		logf("hub: push is off (no FCM key at %s)", path)
		return nil
	}
	if err != nil {
		logf("hub: push is off (FCM key %s unusable: %v)", path, err)
		return nil
	}
	return p
}

// fcmPusher sends FCM HTTP v1 messages, authenticating with a service-account key (a JWT signed
// with it is exchanged for an access token, cached until shortly before it expires).
type fcmPusher struct {
	projectID   string
	clientEmail string
	tokenURI    string
	key         *rsa.PrivateKey

	baseURL string        // FCM API root; tests point it at a fake
	timeout time.Duration // whole Push call
	client  *http.Client
	gone    func(token string)
	logf    func(string, ...any)

	mu      sync.Mutex
	access  string
	expires time.Time
}

func newFCMPusher(path string, gone func(token string), logf func(string, ...any)) (*fcmPusher, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var k struct {
		ProjectID   string `json:"project_id"`
		ClientEmail string `json:"client_email"`
		PrivateKey  string `json:"private_key"`
		TokenURI    string `json:"token_uri"`
	}
	if err := json.Unmarshal(b, &k); err != nil {
		return nil, errors.New("not a JSON service-account key")
	}
	if k.ProjectID == "" || k.ClientEmail == "" || k.PrivateKey == "" {
		return nil, errors.New("project_id, client_email or private_key missing")
	}
	key, err := parseRSAKey(k.PrivateKey)
	if err != nil {
		return nil, err
	}
	if k.TokenURI == "" {
		k.TokenURI = googleToken
	}
	return &fcmPusher{projectID: k.ProjectID, clientEmail: k.ClientEmail, tokenURI: k.TokenURI, key: key,
		baseURL: fcmBaseURL, timeout: pushTimeout, client: &http.Client{}, gone: gone, logf: logf}, nil
}

func parseRSAKey(s string) (*rsa.PrivateKey, error) {
	blk, _ := pem.Decode([]byte(s))
	if blk == nil {
		return nil, errors.New("private_key is not PEM")
	}
	if k, err := x509.ParsePKCS8PrivateKey(blk.Bytes); err == nil {
		if rk, ok := k.(*rsa.PrivateKey); ok {
			return rk, nil
		}
		return nil, errors.New("private_key is not an RSA key")
	}
	if k, err := x509.ParsePKCS1PrivateKey(blk.Bytes); err == nil {
		return k, nil
	}
	return nil, errors.New("private_key does not parse")
}

func (p *fcmPusher) Push(ctx context.Context, targets []PushTarget, title, body string, data map[string]string) {
	ctx, cancel := context.WithTimeout(ctx, p.timeout)
	defer cancel()
	access, err := p.accessToken(ctx)
	if err != nil {
		p.logf("hub: push: FCM auth failed: %v", err)
		return
	}
	for i, t := range targets {
		if ctx.Err() != nil {
			p.logf("hub: push: timed out, %d of %d phones not notified", len(targets)-i, len(targets))
			return
		}
		p.send(ctx, access, t.Token, title, body, data)
	}
}

// send posts one message. A token is forgotten only when FCM's error body says it is gone
// (details[].errorCode UNREGISTERED, or status NOT_FOUND); any other failure, a bare or non-FCM
// 404 included (a wrong project id or a proxy), is logged and the token kept.
func (p *fcmPusher) send(ctx context.Context, access, token, title, body string, data map[string]string) {
	msg := map[string]any{"message": map[string]any{
		"token":        token,
		"notification": map[string]string{"title": title, "body": body},
		"android":      map[string]string{"priority": "high"},
		"data":         data,
	}}
	b, _ := json.Marshal(msg)
	u := p.baseURL + "/v1/projects/" + url.PathEscape(p.projectID) + "/messages:send"
	req, err := http.NewRequestWithContext(ctx, "POST", u, bytes.NewReader(b))
	if err != nil {
		p.logf("hub: push: %v", err)
		return
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Content-Type", "application/json")
	resp, err := p.client.Do(req)
	if err != nil {
		p.logf("hub: push: FCM send failed: %v", redactErr(err))
		return
	}
	defer resp.Body.Close()
	ans, _ := io.ReadAll(io.LimitReader(resp.Body, maxFCMAnswer))
	if resp.StatusCode/100 == 2 {
		return
	}
	var e struct {
		Error struct {
			Status  string `json:"status"`
			Details []struct {
				ErrorCode string `json:"errorCode"`
			} `json:"details"`
		} `json:"error"`
	}
	_ = json.Unmarshal(ans, &e)
	code := e.Error.Status
	gone := e.Error.Status == "NOT_FOUND"
	for _, d := range e.Error.Details {
		if d.ErrorCode != "" {
			code = d.ErrorCode
		}
		if d.ErrorCode == "UNREGISTERED" {
			gone = true
		}
	}
	if resp.StatusCode == http.StatusUnauthorized {
		p.dropAccess(access)
	}
	if gone {
		p.logf("hub: push: a phone token is gone (%d %s), forgetting it", resp.StatusCode, code)
		if p.gone != nil {
			p.gone(token)
		}
		return
	}
	p.logf("hub: push: FCM send failed: %d %s", resp.StatusCode, code)
}

// redactErr keeps a transport error's cause without its URL (a *url.Error prints it).
func redactErr(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}

// accessToken returns the cached OAuth access token, fetching a new one when it is missing or
// about to expire.
func (p *fcmPusher) accessToken(ctx context.Context) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.access != "" && time.Now().Before(p.expires) {
		return p.access, nil
	}
	now := time.Now()
	assertion, err := p.jwt(now)
	if err != nil {
		return "", err
	}
	form := url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:jwt-bearer"}, "assertion": {assertion}}
	req, err := http.NewRequestWithContext(ctx, "POST", p.tokenURI, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := p.client.Do(req)
	if err != nil {
		return "", redactErr(err)
	}
	defer resp.Body.Close()
	ans, _ := io.ReadAll(io.LimitReader(resp.Body, maxFCMAnswer))
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("token endpoint answered %d", resp.StatusCode)
	}
	var t struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if json.Unmarshal(ans, &t) != nil || t.AccessToken == "" {
		return "", errors.New("token endpoint answer has no access_token")
	}
	if t.ExpiresIn <= 0 {
		t.ExpiresIn = 3600
	}
	p.access = t.AccessToken
	// renew a minute early so a token never expires mid-send
	p.expires = now.Add(time.Duration(t.ExpiresIn)*time.Second - time.Minute)
	return p.access, nil
}

// dropAccess forgets the cached access token if it is still the one FCM rejected.
func (p *fcmPusher) dropAccess(access string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.access == access {
		p.access = ""
	}
}

// jwt builds the RS256-signed assertion of the service account for the FCM scope.
func (p *fcmPusher) jwt(now time.Time) (string, error) {
	enc := base64.RawURLEncoding
	hdr, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"iss":   p.clientEmail,
		"scope": fcmScope,
		"aud":   p.tokenURI,
		"iat":   now.Unix(),
		"exp":   now.Add(time.Hour).Unix(),
	})
	signing := enc.EncodeToString(hdr) + "." + enc.EncodeToString(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, p.key, crypto.SHA256, sum[:])
	if err != nil {
		return "", err
	}
	return signing + "." + enc.EncodeToString(sig), nil
}

const maxPushToken = 4096

// validPushToken: 1 to 4096 visible ASCII characters (FCM tokens are base64url with ':' and '-').
func validPushToken(t string) bool {
	if len(t) == 0 || len(t) > maxPushToken {
		return false
	}
	for i := 0; i < len(t); i++ {
		if t[i] <= ' ' || t[i] > '~' {
			return false
		}
	}
	return true
}

// handleAddPush: POST /api/devices/push {token, platform:"android"}. Stores the phone's FCM token on
// the calling device.
func (s *Server) handleAddPush(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Token    string `json:"token"`
		Platform string `json:"platform"`
	}
	if !decode(w, r, &b) {
		return
	}
	if !validPushToken(b.Token) {
		apiErr(w, 400, "invalid push token")
		return
	}
	if b.Platform != "android" {
		apiErr(w, 400, "platform must be android")
		return
	}
	if err := s.st.AddPushToken(AuthName(r.Context()), b.Token, b.Platform); err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDeletePush: DELETE /api/devices/push {token}. Removes the token if the calling device holds it.
func (s *Server) handleDeletePush(w http.ResponseWriter, r *http.Request) {
	var b struct {
		Token string `json:"token"`
	}
	if !decode(w, r, &b) {
		return
	}
	if !validPushToken(b.Token) {
		apiErr(w, 400, "invalid push token")
		return
	}
	if err := s.st.DeletePushToken(AuthName(r.Context()), b.Token); err != nil {
		apiErr(w, 500, "internal error")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

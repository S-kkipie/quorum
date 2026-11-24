// Package viewguard holds the rules shared by the hub (when it makes and serves /v/ links) and the
// daemon (when it reads the file behind a single-file image link): which paths are never served
// and which names are images.
package viewguard

import (
	"regexp"
	"strings"
)

// image is a png, jpg, jpeg, gif or webp file name with something before the extension.
var image = regexp.MustCompile(`(?i)^.+\.(png|jpe?g|gif|webp)$`)

// IsImage reports whether the last segment of p (either separator) is an image name.
func IsImage(p string) bool {
	if i := strings.LastIndexAny(p, `/\`); i >= 0 {
		p = p[i+1:]
	}
	return image.MatchString(p)
}

// Sensitive reports whether a cleaned, slash-separated path names something a link must never
// serve (repository internals, keys, credentials). The base can be the home folder, so tool
// credential folders are denied too. Other dot-directories stay allowed: artifacts live under
// .claude/quorum/artifacts/.
func Sensitive(p string) bool {
	segs := strings.Split(strings.ToLower(p), "/")
	for i, seg := range segs {
		switch {
		case seg == ".git", seg == ".ssh", seg == ".gnupg", seg == ".aws", strings.HasPrefix(seg, ".env"),
			seg == ".docker", seg == ".kube", seg == ".azure":
			return true
		case seg == ".config" && i+1 < len(segs) && segs[i+1] == "gh":
			return true
		}
	}
	name := segs[len(segs)-1]
	switch name {
	case ".credentials.json", ".npmrc", ".netrc", ".pypirc", ".git-credentials", ".pgpass":
		return true
	}
	return strings.HasPrefix(name, "id_rsa") || strings.HasPrefix(name, "id_ed25519") ||
		strings.HasSuffix(name, ".pem") || strings.HasSuffix(name, ".key") ||
		strings.HasSuffix(name, ".p12") || strings.HasSuffix(name, ".pfx")
}

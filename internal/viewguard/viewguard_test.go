package viewguard

import "testing"

func TestSensitive(t *testing.T) {
	for _, p := range []string{".git/config", "a/.ssh/x.png", ".env", ".env.local", "x/.config/gh/hosts.yml", ".aws/c", "a/id_rsa", "k.pem", "c.key", "h/.npmrc", "C:/Users/u/.ssh/a.png", "home/u/.docker/config.json"} {
		if !Sensitive(p) {
			t.Errorf("%s should be sensitive", p)
		}
	}
	for _, p := range []string{"a/b.png", ".claude/quorum/artifacts/r.html", "src/main.go", ".config/other"} {
		if Sensitive(p) {
			t.Errorf("%s should not be sensitive", p)
		}
	}
}

func TestIsImage(t *testing.T) {
	for _, p := range []string{"a.png", "/x/B.JPG", `C:\x\c.jpeg`, "d.gif", "e.WebP"} {
		if !IsImage(p) {
			t.Errorf("%s should be an image", p)
		}
	}
	for _, p := range []string{"a.svg", ".env", "a.png.txt", "png", "/x/.png/a"} {
		if IsImage(p) {
			t.Errorf("%s should not be an image", p)
		}
	}
}

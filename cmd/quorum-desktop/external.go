package main

import "net/url"

// externalURLOK reports whether raw may be handed to the system browser: an absolute http or https URL with a host.
func externalURLOK(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}

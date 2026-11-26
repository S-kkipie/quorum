package hub

import "strings"

// maxGlossaryChars caps a project's glossary text.
const maxGlossaryChars = 2000

// maxPromptChars caps the Whisper initial prompt (Whisper only reads the last ~224 tokens).
const maxPromptChars = 600

// glossaryTerms splits the glossary on commas and new lines, trims each entry and drops empty
// entries and case-insensitive duplicates, keeping the order.
func glossaryTerms(g string) []string {
	var out []string
	seen := map[string]bool{}
	for _, t := range strings.FieldsFunc(g, func(r rune) bool { return r == ',' || r == '\n' || r == '\r' }) {
		t = strings.TrimSpace(t)
		k := strings.ToLower(t)
		if t == "" || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, t)
	}
	return out
}

// whisperPrompt builds the initial prompt "Vocabulary: a, b." of at most maxPromptChars characters,
// cut at a whole term. A first term that alone does not fit is truncated.
func whisperPrompt(terms []string) string {
	if len(terms) == 0 {
		return ""
	}
	const prefix = "Vocabulary: "
	var b []rune
	b = append(b, []rune(prefix)...)
	room := maxPromptChars - len(b) - 1 // the final "."
	for i, t := range terms {
		tr := []rune(t)
		need := len(tr)
		if i > 0 {
			need += 2
		}
		if need > room {
			if i == 0 {
				b = append(b, tr[:room]...)
				room = 0
			}
			break
		}
		if i > 0 {
			b = append(b, ',', ' ')
		}
		b = append(b, tr...)
		room -= need
	}
	return string(b) + "."
}

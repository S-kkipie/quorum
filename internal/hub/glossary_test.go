package hub

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/S-kkipie/quorum/internal/hub/store"
	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

func TestGlossaryTerms(t *testing.T) {
	require.Equal(t, []string{"zorvanite", "Quillon Labs", "guía de remisión"},
		glossaryTerms("zorvanite, Quillon Labs\n\nzorvanite ,guía de remisión"))
	require.Empty(t, glossaryTerms(" , \n"))
}

func TestWhisperPromptCap(t *testing.T) {
	require.Equal(t, "", whisperPrompt(nil))
	require.Equal(t, "Vocabulary: a, b.", whisperPrompt([]string{"a", "b"}))
	var terms []string
	for i := 0; i < 200; i++ {
		terms = append(terms, "term"+strings.Repeat("x", i%7))
	}
	p := whisperPrompt(terms)
	require.LessOrEqual(t, len([]rune(p)), 600)
	require.True(t, strings.HasSuffix(p, "."))
	require.False(t, strings.HasSuffix(p, ", ."), p)
	long := whisperPrompt([]string{strings.Repeat("é", 700)})
	require.NotEmpty(t, long)
	require.LessOrEqual(t, len([]rune(long)), 600)
}

func TestPatchProjectGlossary(t *testing.T) {
	f, p, _ := linkFx(t)
	var got proto.Project
	f.reqJSON(t, "PATCH", "/api/projects/"+p.ID, `{"glossary":"zorvanite, Quillon Labs"}`, 200, &got)
	require.Equal(t, "zorvanite, Quillon Labs", got.Glossary)
	var again proto.Project
	f.reqJSON(t, "GET", "/api/projects/"+p.ID, "", 200, &again)
	require.Equal(t, "zorvanite, Quillon Labs", again.Glossary)
	code, b := f.req(t, "PATCH", "/api/projects/"+p.ID, `{"glossary":"`+strings.Repeat("a", 2001)+`"}`)
	require.Equal(t, 400, code)
	require.JSONEq(t, `{"error":"glossary is longer than 2000 characters"}`, b)
	f.reqJSON(t, "PATCH", "/api/projects/"+p.ID, `{"name":"renamed"}`, 200, &got)
	require.Equal(t, "zorvanite, Quillon Labs", got.Glossary, "other patches keep it")
}

func TestTranscribeJobCarriesProjectPrompt(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	p := f.project(t, "none", nil)
	p.Glossary = "zorvanite, Quillon Labs"
	require.NoError(t, f.st.UpdateProject(p))
	var set proto.MeetingTranscribeSettings
	raw, err := transcribeSettings(f.s, store.MeetingJob{}, proto.Meeting{ProjectID: p.ID})
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal([]byte(raw), &set))
	require.Equal(t, "Vocabulary: zorvanite, Quillon Labs.", set.Prompt)
	raw, err = transcribeSettings(f.s, store.MeetingJob{}, proto.Meeting{})
	require.NoError(t, err)
	require.NotContains(t, raw, "prompt")
}

func TestSummaryGlossaryIncludesProjectTerms(t *testing.T) {
	f := newSumFx(t, func(int, string) (string, error) { return shortAnswer, nil })
	p := f.project(t, "none", map[string]string{"person": "Zorvan Q"})
	p.Glossary = "zorvanite\nBruno"
	require.NoError(t, f.st.UpdateProject(p))
	got := f.s.glossary(proto.Meeting{ProjectID: p.ID}, map[string]string{"Speaker 1": "Bruno"})
	require.Equal(t, []string{"Bruno", "Zorvan Q", "zorvanite"}, got)
}

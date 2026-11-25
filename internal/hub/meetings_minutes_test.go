package hub

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/S-kkipie/quorum/internal/proto"
	"github.com/stretchr/testify/require"
)

// The shared summary cases: worker.py's tests check the same file (worker/meetings/tests/test_parity.py),
// so the hub and the worker apply the same prompts and repair rules.
type summaryCases struct {
	ParseTs     [][2]any `json:"parseTs"`
	ParseAnswer [][2]any `json:"parseAnswer"`
	Repair      []struct {
		Name       string `json:"name"`
		Transcript string `json:"transcript"`
		MaxMs      int64  `json:"maxMs"`
		Raw        any    `json:"raw"`
		Want       any    `json:"want"`
	} `json:"repair"`
	NaiveMerge []struct {
		Parts           []minutes `json:"parts"`
		Want            any       `json:"want"`
		WantMergePrompt []chatMsg `json:"wantMergePrompt"`
	} `json:"naiveMerge"`
	Prompts []struct {
		Name           string                       `json:"name"`
		Segments       []proto.MeetingWorkerSegment `json:"segments"`
		SpeakerNames   map[string]string            `json:"speakerNames"`
		Language       string                       `json:"language"`
		Glossary       []string                     `json:"glossary"`
		SectionMinutes int64                        `json:"sectionMinutes"`
		Want           [][]chatMsg                  `json:"want"`
	} `json:"prompts"`
	Runs []struct {
		Name         string                       `json:"name"`
		Segments     []proto.MeetingWorkerSegment `json:"segments"`
		SpeakerNames map[string]string            `json:"speakerNames"`
		Language     string                       `json:"language"`
		Glossary     []string                     `json:"glossary"`
		Answers      []string                     `json:"answers"`
		Want         any                          `json:"want"`
		WantPrompts  [][]chatMsg                  `json:"wantPrompts"`
	} `json:"runs"`
}

func loadSummaryCases(t *testing.T) summaryCases {
	t.Helper()
	b, err := os.ReadFile("../../worker/meetings/testdata/summary_cases.json")
	require.NoError(t, err)
	var c summaryCases
	require.NoError(t, json.Unmarshal(b, &c))
	require.NotEmpty(t, c.Runs)
	return c
}

func asJSON(t *testing.T, v any) any {
	t.Helper()
	b, err := json.Marshal(v)
	require.NoError(t, err)
	var out any
	require.NoError(t, json.Unmarshal(b, &out))
	return out
}

func toSegments(ws []proto.MeetingWorkerSegment) []proto.MeetingSegment {
	out := make([]proto.MeetingSegment, len(ws))
	for i, s := range ws {
		out[i] = proto.MeetingSegment{StartMs: s.StartMs, EndMs: s.EndMs, Speaker: s.Speaker, Text: s.Text}
	}
	return out
}

func TestSummaryCasesMatchTheWorker(t *testing.T) {
	c := loadSummaryCases(t)
	for _, p := range c.ParseTs {
		got, ok := parseTs(p[0])
		if p[1] == nil {
			require.False(t, ok, "%v", p[0])
		} else {
			require.True(t, ok, "%v", p[0])
			require.Equal(t, p[1], float64(got), "%v", p[0])
		}
	}
	for _, p := range c.ParseAnswer {
		got, ok := parseJSONAnswer(p[0].(string))
		require.Equal(t, p[1] != nil, ok, "%v", p[0])
		require.Equal(t, p[1], got, "%v", p[0])
	}
	for _, r := range c.Repair {
		require.Equal(t, r.Want, asJSON(t, repairMinutes(r.Raw, r.Transcript, r.MaxMs)), r.Name)
	}
	for _, n := range c.NaiveMerge {
		require.Equal(t, n.Want, asJSON(t, naiveMerge(n.Parts)))
		require.Equal(t, n.WantMergePrompt, mergePrompt(n.Parts, languageName("es"), []string{"Quorum", "Ana"}))
	}
	for _, p := range c.Prompts {
		secs := splitSections(toSegments(p.Segments), p.SectionMinutes*60*1000)
		names := map[string]string{}
		for k, v := range p.SpeakerNames {
			if strings.TrimSpace(v) != "" {
				names[k] = v
			}
		}
		var got [][]chatMsg
		for i, s := range secs {
			got = append(got, sectionPrompt(renderLines(s, names), languageName(p.Language), p.Glossary, i+1, len(secs)))
		}
		require.Equal(t, p.Want, got, p.Name)
	}
	for _, r := range c.Runs {
		var sent [][]chatMsg
		i := 0
		chat := func(_ context.Context, msgs []chatMsg) (string, error) {
			sent = append(sent, msgs)
			i++
			return r.Answers[i-1], nil
		}
		m, err := summarizeSegments(context.Background(), chat, toSegments(r.Segments), r.SpeakerNames, r.Language, r.Glossary, nil)
		if w, ok := r.Want.(map[string]any); ok && w["error"] == true {
			require.Error(t, err, r.Name)
		} else {
			require.NoError(t, err, r.Name)
			require.Equal(t, r.Want, asJSON(t, m), r.Name)
		}
		if len(r.WantPrompts) == 0 {
			require.Empty(t, sent, r.Name)
		} else {
			require.Equal(t, r.WantPrompts, sent, r.Name)
		}
	}
}

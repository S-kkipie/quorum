package store

import (
	"encoding/json"

	"github.com/S-kkipie/quorum/internal/proto"
)

// PushToken is a phone's FCM registration token, stored on the device that registered it.
type PushToken struct {
	Device   string
	Token    string
	Platform string
}

// AddPushToken stores the token on the device; a token registered again by another device (the phone
// was re-paired) moves to it.
func (s *Store) AddPushToken(device, token, platform string) error {
	_, err := s.db.Exec(`INSERT INTO push_tokens(device_id,token,platform,at) VALUES(?,?,?,?)
		ON CONFLICT(token) DO UPDATE SET device_id=excluded.device_id, platform=excluded.platform, at=excluded.at`,
		device, token, platform, s.now().UnixMilli())
	return err
}

// DeletePushToken removes the token if it belongs to the device (a no-op otherwise).
func (s *Store) DeletePushToken(device, token string) error {
	_, err := s.db.Exec(`DELETE FROM push_tokens WHERE device_id=? AND token=?`, device, token)
	return err
}

// ForgetPushToken removes the token whatever device holds it (FCM reported it gone).
func (s *Store) ForgetPushToken(token string) error {
	_, err := s.db.Exec(`DELETE FROM push_tokens WHERE token=?`, token)
	return err
}

// PushTokens returns the tokens of the devices that still exist, by device and token.
func (s *Store) PushTokens() ([]PushToken, error) {
	rows, err := s.db.Query(`SELECT p.device_id,p.token,p.platform FROM push_tokens p
		JOIN tokens t ON t.kind='device' AND t.name=p.device_id ORDER BY p.device_id,p.token`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PushToken
	for rows.Next() {
		var p PushToken
		if err := rows.Scan(&p.Device, &p.Token, &p.Platform); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SessionOpenAsk returns the session's latest ask without a later ask_resolved (nil when none is open).
func (s *Store) SessionOpenAsk(session string) (*proto.Event, error) {
	rows, err := s.db.Query(`SELECT seq,ts,kind,data FROM events
		WHERE session=? AND kind IN ('ask','ask_resolved') ORDER BY seq`, session)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	open := map[string]proto.Event{}
	var order []string
	for rows.Next() {
		var e proto.Event
		var kind, data string
		if err := rows.Scan(&e.Seq, &e.TS, &kind, &data); err != nil {
			return nil, err
		}
		e.Session, e.Kind, e.Data = session, proto.EventKind(kind), json.RawMessage(data)
		var a struct {
			AskID string `json:"askId"`
		}
		if json.Unmarshal([]byte(data), &a) != nil || a.AskID == "" {
			continue
		}
		if kind == string(proto.KindAsk) {
			open[a.AskID] = e
			order = append(order, a.AskID)
		} else {
			delete(open, a.AskID)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := len(order) - 1; i >= 0; i-- {
		if e, ok := open[order[i]]; ok {
			return &e, nil
		}
	}
	return nil, nil
}

package store

import (
	"database/sql"
	"errors"

	"github.com/S-kkipie/quorum/internal/proto"
)

const (
	usageMaxAgeMs = 7 * 24 * 3600 * 1000
	// An unchanged report still counts as a change (so apps refresh "at") once the stored one is this old.
	usageRefreshMs = 10 * 60 * 1000
)

// UsageKey identifies the account of a session: its accountKey, or machine/alias when the
// account identity is unavailable.
func UsageKey(machine string, si proto.SessionInfo) string {
	if si.AccountKey != "" {
		return si.AccountKey
	}
	return machine + "/" + si.Account
}

// SaveUsage merges a rate-limit report into the account's row and returns the resulting usage.
// changed is true when the values or alias differ from the stored ones (or the stored row is old
// enough that apps should refresh its timestamp). A report older than the stored one is ignored.
// Windows missing from the report keep their stored values.
func (s *Store) SaveUsage(key, alias string, limits []proto.RateLimit, at int64) (u proto.AccountUsage, changed bool, err error) {
	tx, err := s.db.Begin()
	if err != nil {
		return u, false, err
	}
	defer tx.Rollback()
	old := proto.AccountUsage{Key: key}
	err = tx.QueryRow(`SELECT alias,five_hour_pct,five_hour_resets,seven_day_pct,seven_day_resets,at FROM account_usage WHERE account_key=?`, key).
		Scan(&old.Alias, &old.FiveHour.Pct, &old.FiveHour.ResetsAt, &old.SevenDay.Pct, &old.SevenDay.ResetsAt, &old.At)
	exists := err == nil
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return u, false, err
	}
	if exists && old.At >= at { // older or the same reading again
		return old, false, nil
	}
	u = old
	u.Alias, u.At = alias, at
	for _, l := range limits {
		switch l.Kind {
		case "five_hour":
			u.FiveHour = proto.UsageWindow{Pct: l.PercentUsed, ResetsAt: l.ResetsAt}
		case "seven_day":
			u.SevenDay = proto.UsageWindow{Pct: l.PercentUsed, ResetsAt: l.ResetsAt}
		}
	}
	changed = !exists || u.Alias != old.Alias || u.FiveHour != old.FiveHour || u.SevenDay != old.SevenDay ||
		at-old.At >= usageRefreshMs
	_, err = tx.Exec(`INSERT INTO account_usage(account_key,alias,five_hour_pct,five_hour_resets,seven_day_pct,seven_day_resets,at)
		VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_key) DO UPDATE SET alias=excluded.alias,
		five_hour_pct=excluded.five_hour_pct, five_hour_resets=excluded.five_hour_resets,
		seven_day_pct=excluded.seven_day_pct, seven_day_resets=excluded.seven_day_resets, at=excluded.at`,
		key, u.Alias, u.FiveHour.Pct, u.FiveHour.ResetsAt, u.SevenDay.Pct, u.SevenDay.ResetsAt, u.At)
	if err != nil {
		return u, false, err
	}
	return u, changed, tx.Commit()
}

// ListUsage returns the accounts reported in the last 7 days before now (Unix ms), newest first.
func (s *Store) ListUsage(now int64) ([]proto.AccountUsage, error) {
	rows, err := s.db.Query(`SELECT account_key,alias,five_hour_pct,five_hour_resets,seven_day_pct,seven_day_resets,at
		FROM account_usage WHERE at>? ORDER BY at DESC, account_key`, now-usageMaxAgeMs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []proto.AccountUsage{}
	for rows.Next() {
		var u proto.AccountUsage
		if err := rows.Scan(&u.Key, &u.Alias, &u.FiveHour.Pct, &u.FiveHour.ResetsAt, &u.SevenDay.Pct, &u.SevenDay.ResetsAt, &u.At); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// DeleteUsage removes an account's usage row; removed says whether it existed.
func (s *Store) DeleteUsage(key string) (removed bool, err error) {
	res, err := s.db.Exec(`DELETE FROM account_usage WHERE account_key=?`, key)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

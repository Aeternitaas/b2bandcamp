package store

import (
	"context"
	"database/sql"
	"time"
)

// CreateAPIToken records a new token's hash against a user. The caller is
// responsible for generating and returning the raw token, the store only
// ever sees (and stores) its hash.
func (s *Store) CreateAPIToken(ctx context.Context, userID int64, tokenHash, label string) (*APIToken, error) {
	now := time.Now().UTC()
	res, err := s.DB.ExecContext(ctx,
		`INSERT INTO api_tokens (user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?)`,
		userID, tokenHash, label, now)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return &APIToken{ID: id, Label: label, CreatedAt: now}, nil
}

// UserByAPIToken resolves a token hash to its owner. Unlike a session, an API
// token does not expire on its own, see the 014_api_tokens migration for why.
func (s *Store) UserByAPIToken(ctx context.Context, tokenHash string) (*User, error) {
	return scanUser(s.DB.QueryRowContext(ctx,
		`SELECT `+userColumns+`
		   FROM api_tokens t JOIN users u ON u.id = t.user_id
		  WHERE t.token_hash = ?`, tokenHash))
}

// TouchAPIToken records that a token was just used, best-effort, callers
// should not fail a request over this bookkeeping write.
func (s *Store) TouchAPIToken(ctx context.Context, tokenHash string) error {
	_, err := s.DB.ExecContext(ctx,
		`UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`, time.Now().UTC(), tokenHash)
	return err
}

// ListAPITokens returns a user's tokens, newest first, for the account page,
// never the raw token, which cannot be recovered once issued.
func (s *Store) ListAPITokens(ctx context.Context, userID int64) ([]*APIToken, error) {
	rows, err := s.DB.QueryContext(ctx,
		`SELECT id, label, created_at, last_used_at FROM api_tokens
		  WHERE user_id = ? ORDER BY created_at DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []*APIToken{}
	for rows.Next() {
		var t APIToken
		var lastUsed sql.NullTime
		if err := rows.Scan(&t.ID, &t.Label, &t.CreatedAt, &lastUsed); err != nil {
			return nil, err
		}
		if lastUsed.Valid {
			t.LastUsedAt = &lastUsed.Time
		}
		out = append(out, &t)
	}
	return out, rows.Err()
}

// DeleteAPIToken revokes one of a user's own tokens. The user_id predicate is
// the authorization check: it keeps this from touching anyone else's token.
func (s *Store) DeleteAPIToken(ctx context.Context, userID, tokenID int64) error {
	res, err := s.DB.ExecContext(ctx,
		`DELETE FROM api_tokens WHERE id = ? AND user_id = ?`, tokenID, userID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

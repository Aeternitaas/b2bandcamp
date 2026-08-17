package store

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

var ErrNotFound = errors.New("store: not found")

func (s *Store) CreateUser(ctx context.Context, username, email, passwordHash string) (*User, error) {
	now := time.Now().UTC()
	res, err := s.DB.ExecContext(ctx,
		`INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
		username, email, passwordHash, now)
	if err != nil {
		return nil, err
	}
	id, err := res.LastInsertId()
	if err != nil {
		return nil, err
	}
	return &User{ID: id, Username: username, Email: email, CreatedAt: now}, nil
}

// UserByLogin looks a user up by either username or email so the login form can
// accept both.
func (s *Store) UserByLogin(ctx context.Context, login string) (*User, string, error) {
	var u User
	var hash string
	err := s.DB.QueryRowContext(ctx,
		`SELECT id, username, email, password_hash, created_at
		   FROM users WHERE username = ? OR email = ? LIMIT 1`, login, login).
		Scan(&u.ID, &u.Username, &u.Email, &hash, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", ErrNotFound
	}
	if err != nil {
		return nil, "", err
	}
	return &u, hash, nil
}

func (s *Store) UserByID(ctx context.Context, id int64) (*User, error) {
	var u User
	err := s.DB.QueryRowContext(ctx,
		`SELECT id, username, email, created_at FROM users WHERE id = ?`, id).
		Scan(&u.ID, &u.Username, &u.Email, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) UserByUsername(ctx context.Context, username string) (*User, error) {
	var u User
	err := s.DB.QueryRowContext(ctx,
		`SELECT id, username, email, created_at FROM users WHERE username = ?`, username).
		Scan(&u.ID, &u.Username, &u.Email, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) CreateSession(ctx context.Context, tokenHash string, userID int64, userAgent string, ttl time.Duration) error {
	now := time.Now().UTC()
	if len(userAgent) > 255 {
		userAgent = userAgent[:255]
	}
	_, err := s.DB.ExecContext(ctx,
		`INSERT INTO sessions (token_hash, user_id, user_agent, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
		tokenHash, userID, userAgent, now, now.Add(ttl))
	return err
}

// UserBySession resolves a session token hash to its user, rejecting expired
// rows in the same query.
func (s *Store) UserBySession(ctx context.Context, tokenHash string) (*User, error) {
	var u User
	err := s.DB.QueryRowContext(ctx,
		`SELECT u.id, u.username, u.email, u.created_at
		   FROM sessions s JOIN users u ON u.id = s.user_id
		  WHERE s.token_hash = ? AND s.expires_at > ?`,
		tokenHash, time.Now().UTC()).
		Scan(&u.ID, &u.Username, &u.Email, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

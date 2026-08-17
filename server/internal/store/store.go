package store

import (
	"context"
	"database/sql"
	"fmt"
	"log"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

type Store struct {
	DB *sql.DB
}

// Open connects to MySQL and blocks until the server answers a ping, so the
// container can start alongside the database without a race.
func Open(ctx context.Context, dsn string) (*Store, error) {
	db, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)
	db.SetConnMaxLifetime(time.Hour)

	deadline := time.Now().Add(90 * time.Second)
	for {
		pingCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		err = db.PingContext(pingCtx)
		cancel()
		if err == nil {
			break
		}
		if time.Now().After(deadline) {
			return nil, fmt.Errorf("database unreachable after 90s: %w", err)
		}
		log.Printf("waiting for database: %v", err)
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}

	s := &Store{DB: db}
	if err := s.migrate(ctx); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error { return s.DB.Close() }

// migrations run in order exactly once; applied names are recorded so restarts
// are cheap and adding a migration later is a matter of appending to this slice.
var migrations = []struct {
	name string
	stmt string
}{
	{"001_users", `
CREATE TABLE IF NOT EXISTS users (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username      VARCHAR(32)     NOT NULL,
  email         VARCHAR(255)    NOT NULL,
  password_hash VARCHAR(255)    NOT NULL,
  created_at    DATETIME        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_users_username (username),
  UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`},

	{"002_sessions", `
CREATE TABLE IF NOT EXISTS sessions (
  token_hash CHAR(64)        NOT NULL,
  user_id    BIGINT UNSIGNED NOT NULL,
  user_agent VARCHAR(255)    NOT NULL DEFAULT '',
  created_at DATETIME        NOT NULL,
  expires_at DATETIME        NOT NULL,
  PRIMARY KEY (token_hash),
  KEY idx_sessions_user (user_id),
  KEY idx_sessions_expiry (expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`},

	{"003_playlists", `
CREATE TABLE IF NOT EXISTS playlists (
  id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id          BIGINT UNSIGNED NOT NULL,
  title             VARCHAR(200)    NOT NULL,
  description       TEXT            NULL,
  cover_url         VARCHAR(500)    NULL,
  visibility        ENUM('private','shared','public') NOT NULL DEFAULT 'private',
  share_token_hash  CHAR(64)        NULL,
  base_fan_id       BIGINT UNSIGNED NULL,
  base_fan_username VARCHAR(100)    NULL,
  sort_index        INT             NOT NULL DEFAULT 0,
  created_at        DATETIME        NOT NULL,
  updated_at        DATETIME        NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_playlists_share (share_token_hash),
  KEY idx_playlists_owner (owner_id, sort_index),
  CONSTRAINT fk_playlists_owner FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`},

	{"004_playlist_tracks", `
CREATE TABLE IF NOT EXISTS playlist_tracks (
  id          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  playlist_id BIGINT UNSIGNED NOT NULL,
  position    INT             NOT NULL,
  bc_track_id BIGINT UNSIGNED NOT NULL,
  bc_album_id BIGINT UNSIGNED NULL,
  bc_band_id  BIGINT UNSIGNED NULL,
  title       VARCHAR(300)    NOT NULL,
  artist      VARCHAR(300)    NOT NULL,
  album_title VARCHAR(300)    NULL,
  duration    DOUBLE          NOT NULL DEFAULT 0,
  art_id      BIGINT UNSIGNED NULL,
  track_url   VARCHAR(500)    NOT NULL DEFAULT '',
  added_by    BIGINT UNSIGNED NULL,
  added_at    DATETIME        NOT NULL,
  PRIMARY KEY (id),
  KEY idx_tracks_playlist (playlist_id, position),
  CONSTRAINT fk_tracks_playlist FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE,
  CONSTRAINT fk_tracks_user FOREIGN KEY (added_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`},

	{"005_collaborators", `
CREATE TABLE IF NOT EXISTS playlist_collaborators (
  playlist_id BIGINT UNSIGNED NOT NULL,
  user_id     BIGINT UNSIGNED NOT NULL,
  added_at    DATETIME        NOT NULL,
  PRIMARY KEY (playlist_id, user_id),
  KEY idx_collab_user (user_id),
  CONSTRAINT fk_collab_playlist FOREIGN KEY (playlist_id) REFERENCES playlists (id) ON DELETE CASCADE,
  CONSTRAINT fk_collab_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`},
}

func (s *Store) migrate(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name       VARCHAR(128) NOT NULL,
  applied_at DATETIME     NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)
	if err != nil {
		return err
	}

	for _, m := range migrations {
		var seen int
		err := s.DB.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM schema_migrations WHERE name = ?`, m.name).Scan(&seen)
		if err != nil {
			return err
		}
		if seen > 0 {
			continue
		}
		if _, err := s.DB.ExecContext(ctx, m.stmt); err != nil {
			return fmt.Errorf("%s: %w", m.name, err)
		}
		if _, err := s.DB.ExecContext(ctx,
			`INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)`,
			m.name, time.Now().UTC()); err != nil {
			return err
		}
		log.Printf("applied migration %s", m.name)
	}
	return nil
}

// PurgeExpiredSessions is run periodically so the sessions table does not grow
// without bound.
func (s *Store) PurgeExpiredSessions(ctx context.Context) error {
	_, err := s.DB.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at < ?`, time.Now().UTC())
	return err
}

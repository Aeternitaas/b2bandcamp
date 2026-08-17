package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds runtime configuration, sourced entirely from the environment so
// the same binary works in docker-compose and on a bare host.
type Config struct {
	Port          string
	DSN           string
	WebDir        string
	CookieSecure  bool
	CookieName    string
	CSRFCookie    string
	SessionTTL    time.Duration
	AllowRegister bool
}

func Load() (*Config, error) {
	c := &Config{
		Port:          env("PORT", "9185"),
		WebDir:        env("WEB_DIR", "./web"),
		CookieName:    env("SESSION_COOKIE", "b2b_session"),
		CSRFCookie:    env("CSRF_COOKIE", "b2b_csrf"),
		CookieSecure:  envBool("COOKIE_SECURE", false),
		AllowRegister: envBool("ALLOW_REGISTRATION", true),
	}

	days := envInt("SESSION_TTL_DAYS", 30)
	c.SessionTTL = time.Duration(days) * 24 * time.Hour

	if dsn := os.Getenv("MYSQL_DSN"); dsn != "" {
		c.DSN = dsn
	} else {
		user := env("MYSQL_USER", "b2b")
		pass := os.Getenv("MYSQL_PASSWORD")
		host := env("MYSQL_HOST", "127.0.0.1")
		port := env("MYSQL_PORT", "3306")
		name := env("MYSQL_DATABASE", "b2b_helper")
		if pass == "" {
			return nil, fmt.Errorf("MYSQL_PASSWORD (or MYSQL_DSN) must be set")
		}
		// parseTime so DATETIME columns scan straight into time.Time.
		c.DSN = fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&charset=utf8mb4&collation=utf8mb4_unicode_ci&loc=UTC",
			user, pass, host, port, name)
	}
	return c, nil
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envBool(key string, def bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return def
	}
	return b
}

func envInt(key string, def int) int {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def
	}
	return n
}

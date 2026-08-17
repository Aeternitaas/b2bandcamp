package config

import (
	"fmt"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
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

	// Canonical public address, e.g. https://music.example.com. Optional: the
	// UI builds share links from the browser's own origin, so this is only
	// needed when links must always name one host regardless of how the app
	// was reached.
	PublicBaseURL string

	// Networks whose X-Forwarded-For header may be believed. Behind a reverse
	// proxy every request arrives from the proxy, so without this the rate
	// limiters treat all users as one caller.
	TrustedProxies []*net.IPNet
}

func Load() (*Config, error) {
	c := &Config{
		Port:          env("PORT", "9185"),
		WebDir:        env("WEB_DIR", "./web"),
		CookieName:    env("SESSION_COOKIE", "b2bandcamp_session"),
		CSRFCookie:    env("CSRF_COOKIE", "b2bandcamp_csrf"),
		CookieSecure:  envBool("COOKIE_SECURE", false),
		AllowRegister: envBool("ALLOW_REGISTRATION", true),
	}

	days := envInt("SESSION_TTL_DAYS", 30)
	c.SessionTTL = time.Duration(days) * 24 * time.Hour

	if base := strings.TrimRight(os.Getenv("PUBLIC_BASE_URL"), "/"); base != "" {
		u, err := url.Parse(base)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("PUBLIC_BASE_URL must be an absolute http(s) url, got %q", base)
		}
		c.PublicBaseURL = base
	}

	proxies, err := parseTrustedProxies(os.Getenv("TRUSTED_PROXIES"))
	if err != nil {
		return nil, err
	}
	c.TrustedProxies = proxies

	if dsn := os.Getenv("MYSQL_DSN"); dsn != "" {
		c.DSN = dsn
	} else {
		user := env("MYSQL_USER", "b2bandcamp")
		pass := os.Getenv("MYSQL_PASSWORD")
		host := env("MYSQL_HOST", "127.0.0.1")
		port := env("MYSQL_PORT", "3306")
		name := env("MYSQL_DATABASE", "b2bandcamp")
		if pass == "" {
			return nil, fmt.Errorf("MYSQL_PASSWORD (or MYSQL_DSN) must be set")
		}
		// parseTime so DATETIME columns scan straight into time.Time.
		c.DSN = fmt.Sprintf("%s:%s@tcp(%s:%s)/%s?parseTime=true&charset=utf8mb4&collation=utf8mb4_unicode_ci&loc=UTC",
			user, pass, host, port, name)
	}
	return c, nil
}

// parseTrustedProxies accepts a comma-separated list of CIDRs or bare IPs, or
// the keyword "private" for the usual RFC1918 and loopback ranges — which is
// what a proxy on the same host or docker network will be.
func parseTrustedProxies(raw string) ([]*net.IPNet, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, nil
	}

	var out []*net.IPNet
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}

		if strings.EqualFold(part, "private") {
			for _, cidr := range []string{
				"127.0.0.0/8", "::1/128",
				"10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7",
			} {
				_, network, _ := net.ParseCIDR(cidr)
				out = append(out, network)
			}
			continue
		}

		if !strings.Contains(part, "/") {
			// A bare address is a /32 or /128.
			ip := net.ParseIP(part)
			if ip == nil {
				return nil, fmt.Errorf("TRUSTED_PROXIES: %q is not an ip or cidr", part)
			}
			bits := 32
			if ip.To4() == nil {
				bits = 128
			}
			out = append(out, &net.IPNet{IP: ip, Mask: net.CIDRMask(bits, bits)})
			continue
		}

		_, network, err := net.ParseCIDR(part)
		if err != nil {
			return nil, fmt.Errorf("TRUSTED_PROXIES: %q is not a valid cidr", part)
		}
		out = append(out, network)
	}
	return out, nil
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

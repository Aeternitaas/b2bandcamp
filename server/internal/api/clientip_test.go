package api

import (
	"net"
	"net/http"
	"testing"

	"github.com/aeternitaas/b2bandcamp/server/internal/config"
)

func withProxies(cidrs ...string) *Server {
	var nets []*net.IPNet
	for _, c := range cidrs {
		_, n, _ := net.ParseCIDR(c)
		nets = append(nets, n)
	}
	return &Server{cfg: &config.Config{TrustedProxies: nets}}
}

func req(remote, xff string) *http.Request {
	r := &http.Request{RemoteAddr: remote, Header: http.Header{}}
	if xff != "" {
		r.Header.Set("X-Forwarded-For", xff)
	}
	return r
}

func TestClientIP(t *testing.T) {
	cases := []struct {
		name   string
		server *Server
		req    *http.Request
		want   string
	}{
		{
			// No proxy configured: the header must be ignored entirely, or
			// anyone could evade the limiters by forging it.
			"spoofed header with no trusted proxies",
			withProxies(),
			req("203.0.113.9:5555", "1.2.3.4"),
			"203.0.113.9",
		},
		{
			// Same, but the peer is simply not a trusted proxy.
			"spoofed header from an untrusted peer",
			withProxies("10.0.0.0/8"),
			req("203.0.113.9:5555", "1.2.3.4"),
			"203.0.113.9",
		},
		{
			"real client behind a trusted proxy",
			withProxies("10.0.0.0/8"),
			req("10.1.2.3:5555", "198.51.100.7"),
			"198.51.100.7",
		},
		{
			// Chained proxies: take the outermost address that is not itself
			// one of ours.
			"chain of trusted proxies",
			withProxies("10.0.0.0/8"),
			req("10.1.2.3:5555", "198.51.100.7, 10.9.9.9, 10.1.2.3"),
			"198.51.100.7",
		},
		{
			// A client that forges a header while genuinely behind our proxy
			// still cannot pick an arbitrary identity for the *last* hop the
			// proxy appended, but it can influence earlier entries; taking the
			// rightmost untrusted value is what limits the damage.
			"forged prefix behind a trusted proxy",
			withProxies("10.0.0.0/8"),
			req("10.1.2.3:5555", "1.1.1.1, 198.51.100.7"),
			"198.51.100.7",
		},
		{
			"garbage header falls back to the peer",
			withProxies("10.0.0.0/8"),
			req("10.1.2.3:5555", "not-an-ip"),
			"10.1.2.3",
		},
		{
			"no header at all",
			withProxies("10.0.0.0/8"),
			req("10.1.2.3:5555", ""),
			"10.1.2.3",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.server.clientIP(tc.req); got != tc.want {
				t.Errorf("clientIP() = %q, want %q", got, tc.want)
			}
		})
	}
}

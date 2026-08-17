package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
)

// NewToken returns a 256-bit URL-safe random token. Used for session cookies,
// share links and CSRF tokens.
func NewToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// shareAlphabet omits characters that are easy to confuse when a link is read
// aloud or retyped (0/O, 1/I/l). 57 symbols over 10 characters is ~58 bits.
const shareAlphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

// ShareTokenLength is the visible length of a playlist share link's token.
const ShareTokenLength = 10

// NewShareToken returns a short, URL-friendly token for share links.
//
// It is deliberately shorter than a session token: share links get pasted into
// chats and typed by hand, so length is a usability cost. ~58 bits still leaves
// guessing infeasible against the server's rate limiter (a sustained 1000
// guesses/sec would need millions of years for even odds), and the token is
// stored only as a SHA-256 hash. Callers must handle the unique-index collision
// on insert rather than assuming uniqueness.
func NewShareToken() (string, error) {
	buf := make([]byte, ShareTokenLength)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}

	// Rejection sampling keeps every symbol equally likely; a plain modulo
	// would bias toward the front of the alphabet.
	const max = 256 - (256 % len(shareAlphabet))
	out := make([]byte, 0, ShareTokenLength)
	for len(out) < ShareTokenLength {
		if int(buf[0]) < max {
			out = append(out, shareAlphabet[int(buf[0])%len(shareAlphabet)])
		}
		if buf = buf[1:]; len(buf) == 0 {
			buf = make([]byte, ShareTokenLength)
			if _, err := rand.Read(buf); err != nil {
				return "", err
			}
		}
	}
	return string(out), nil
}

// HashToken is the at-rest representation of a bearer token. Session and share
// tokens are high-entropy random values, so a plain SHA-256 is the right tool
// here (no stretching needed, unlike passwords) and it means a database leak
// does not hand over live sessions or working share links.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

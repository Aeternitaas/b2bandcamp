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

// HashToken is the at-rest representation of a bearer token. Session and share
// tokens are high-entropy random values, so a plain SHA-256 is the right tool
// here (no stretching needed, unlike passwords) and it means a database leak
// does not hand over live sessions or working share links.
func HashToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

package auth

import (
	"strings"
	"testing"
)

func TestPasswordRoundTrip(t *testing.T) {
	const password = "correct horse battery staple"

	encoded, err := HashPassword(password)
	if err != nil {
		t.Fatalf("HashPassword: %v", err)
	}
	if !strings.HasPrefix(encoded, "$argon2id$v=19$") {
		t.Errorf("hash is not in argon2id PHC format: %q", encoded)
	}

	ok, err := VerifyPassword(password, encoded)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if !ok {
		t.Error("correct password was rejected")
	}

	ok, err = VerifyPassword(password+"x", encoded)
	if err != nil {
		t.Fatalf("VerifyPassword: %v", err)
	}
	if ok {
		t.Error("incorrect password was accepted")
	}
}

// The same password must never produce the same stored hash, or the salt is
// not doing its job and identical passwords become visible in a dump.
func TestPasswordHashesAreSalted(t *testing.T) {
	a, err := HashPassword("same password")
	if err != nil {
		t.Fatal(err)
	}
	b, err := HashPassword("same password")
	if err != nil {
		t.Fatal(err)
	}
	if a == b {
		t.Error("two hashes of the same password are identical; salt is missing")
	}
}

func TestVerifyRejectsMalformedHash(t *testing.T) {
	for _, bad := range []string{"", "not-a-hash", "$argon2id$v=19$broken", "$bcrypt$v=19$m=1,t=1,p=1$aa$bb"} {
		if _, err := VerifyPassword("x", bad); err == nil {
			t.Errorf("VerifyPassword(%q) returned no error", bad)
		}
	}
}

func TestShareTokenShape(t *testing.T) {
	for i := 0; i < 200; i++ {
		token, err := NewShareToken()
		if err != nil {
			t.Fatalf("NewShareToken: %v", err)
		}
		if len(token) != ShareTokenLength {
			t.Fatalf("token %q has length %d, want %d", token, len(token), ShareTokenLength)
		}
		for _, r := range token {
			if !strings.ContainsRune(shareAlphabet, r) {
				t.Fatalf("token %q contains %q, which is outside the alphabet", token, r)
			}
		}
	}
}

// Share links are looked up by a unique index, so repeats would surface as
// insert failures. This is a smoke test that the generator is actually random
// rather than, say, returning a constant.
func TestShareTokensAreDistinct(t *testing.T) {
	seen := make(map[string]bool, 5000)
	for i := 0; i < 5000; i++ {
		token, err := NewShareToken()
		if err != nil {
			t.Fatal(err)
		}
		if seen[token] {
			t.Fatalf("duplicate share token %q after %d draws", token, i)
		}
		seen[token] = true
	}
}

func TestHashTokenIsStableAndOpaque(t *testing.T) {
	token, err := NewToken()
	if err != nil {
		t.Fatal(err)
	}

	hash := HashToken(token)
	if hash != HashToken(token) {
		t.Error("HashToken is not deterministic")
	}
	if len(hash) != 64 {
		t.Errorf("hash length = %d, want 64 hex characters", len(hash))
	}
	if strings.Contains(hash, token) {
		t.Error("stored hash contains the raw token")
	}
}

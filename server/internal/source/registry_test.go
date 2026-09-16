package source

import (
	"context"
	"reflect"
	"strings"
	"testing"
)

// fake is a provider stub: the registry only ever calls ID, Match and CSP.
type fake struct {
	id     string
	prefix string
	csp    CSP
}

func (f fake) ID() string                                   { return f.id }
func (f fake) Name() string                                 { return f.id }
func (f fake) Match(u string) bool                          { return strings.HasPrefix(u, f.prefix) }
func (f fake) Caps() Caps                                   { return Caps{} }
func (f fake) CSP() CSP                                     { return f.csp }
func (f fake) Resolve(context.Context, string) (Ref, error) { return Ref{}, ErrNotFound }
func (f fake) Expand(context.Context, Ref) ([]Track, error) { return nil, ErrNotFound }

func TestForURLUsesRegistrationOrder(t *testing.T) {
	r := NewRegistry()
	// Both claim the same prefix; the one registered first must win, which is
	// what keeps the first-class source in charge of an ambiguous link.
	r.Register(fake{id: "first", prefix: "https://example.com/"})
	r.Register(fake{id: "second", prefix: "https://example.com/"})

	p, ok := r.ForURL("https://example.com/thing")
	if !ok {
		t.Fatal("no provider matched")
	}
	if p.ID() != "first" {
		t.Errorf("got %q, want the first registered provider", p.ID())
	}

	if _, ok := r.ForURL("https://elsewhere.test/thing"); ok {
		t.Error("an unclaimed url must not match a provider")
	}
}

func TestByID(t *testing.T) {
	r := NewRegistry()
	r.Register(fake{id: "bandcamp"})

	if _, ok := r.ByID("bandcamp"); !ok {
		t.Error("registered provider not found by id")
	}
	if _, ok := r.ByID("nope"); ok {
		t.Error("unregistered id must not resolve")
	}
}

func TestDuplicateIDPanics(t *testing.T) {
	defer func() {
		if recover() == nil {
			t.Error("registering a duplicate id must panic, not silently drop one")
		}
	}()
	r := NewRegistry()
	r.Register(fake{id: "dup"})
	r.Register(fake{id: "dup"})
}

func TestMergedCSPDedupesAndSorts(t *testing.T) {
	r := NewRegistry()
	r.Register(fake{id: "a", csp: CSP{
		Media:  []string{"https://b.example", "https://a.example"},
		Script: []string{"https://s.example"},
	}})
	r.Register(fake{id: "b", csp: CSP{
		Media: []string{"https://a.example", ""}, // duplicate and empty both dropped
		Frame: []string{"https://f.example"},
	}})

	got := r.MergedCSP()
	want := CSP{
		Media:  []string{"https://a.example", "https://b.example"},
		Script: []string{"https://s.example"},
		Frame:  []string{"https://f.example"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("merged csp\n got %+v\nwant %+v", got, want)
	}
}

func TestMergedCSPEmptyRegistry(t *testing.T) {
	if got := NewRegistry().MergedCSP(); !reflect.DeepEqual(got, CSP{}) {
		t.Errorf("empty registry should merge to a zero CSP, got %+v", got)
	}
}

package source

import "sort"

// Registry holds the providers this server was built with.
//
// It is filled once during startup and only read afterwards, so it carries no
// lock: adding a provider after the HTTP server is serving would be a data
// race, and there is no reason to do it.
type Registry struct {
	order []Provider
	byID  map[string]Provider
}

func NewRegistry() *Registry {
	return &Registry{byID: make(map[string]Provider)}
}

// Register adds a provider. Registration order is match order, so the
// first-class source is registered first and wins any URL both could claim.
// Registering the same id twice panics: that is a wiring mistake in main, and
// silently keeping one of the two would be far harder to notice than a crash
// at startup.
func (r *Registry) Register(p Provider) {
	id := p.ID()
	if id == "" {
		panic("source: provider with empty id")
	}
	if _, dup := r.byID[id]; dup {
		panic("source: duplicate provider id " + id)
	}
	r.byID[id] = p
	r.order = append(r.order, p)
}

// ByID looks a provider up by the key stored against a track row.
func (r *Registry) ByID(id string) (Provider, bool) {
	p, ok := r.byID[id]
	return p, ok
}

// ForURL finds the provider that claims a pasted link, in registration order.
func (r *Registry) ForURL(rawURL string) (Provider, bool) {
	for _, p := range r.order {
		if p.Match(rawURL) {
			return p, true
		}
	}
	return nil, false
}

// All returns the providers in registration order.
func (r *Registry) All() []Provider {
	out := make([]Provider, len(r.order))
	copy(out, r.order)
	return out
}

// MergedCSP collapses every registered provider's origins into one set per
// directive, deduplicated and ordered so the resulting header is stable across
// restarts and easy to diff.
func (r *Registry) MergedCSP() CSP {
	var m CSP
	for _, p := range r.order {
		c := p.CSP()
		m.Media = append(m.Media, c.Media...)
		m.Script = append(m.Script, c.Script...)
		m.Frame = append(m.Frame, c.Frame...)
		m.Connect = append(m.Connect, c.Connect...)
	}
	m.Media = dedupe(m.Media)
	m.Script = dedupe(m.Script)
	m.Frame = dedupe(m.Frame)
	m.Connect = dedupe(m.Connect)
	return m
}

func dedupe(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]bool, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

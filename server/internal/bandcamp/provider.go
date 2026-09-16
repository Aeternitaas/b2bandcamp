package bandcamp

import (
	"context"
	"fmt"
	"strconv"

	"github.com/aeternitaas/b2bandcamp/server/internal/source"
)

// Provider adapts Client to the source.Provider contract. It holds no state of
// its own: everything still goes through the same client, with the same cache
// and the same rate limiting, so routing an add through the registry changes
// nothing about how Bandcamp is actually talked to.
type Provider struct {
	c *Client
}

func NewProvider(c *Client) *Provider { return &Provider{c: c} }

// Compile-time proof that Bandcamp satisfies both the base contract and the
// optional streaming one.
var (
	_ source.Provider = (*Provider)(nil)
	_ source.Streamer = (*Provider)(nil)
)

// SourceID is the registry key and the value stored in playlist_tracks.source.
// It must never change: rows already reference it.
const SourceID = "bandcamp"

func (p *Provider) ID() string   { return SourceID }
func (p *Provider) Name() string { return "Bandcamp" }

// Match reuses the same host check that guards Resolve against being pointed at
// arbitrary hosts, so the registry and the fetcher can never disagree about
// which links belong to Bandcamp.
func (p *Provider) Match(rawURL string) bool {
	_, err := normalizeURL(rawURL)
	return err == nil
}

func (p *Provider) Resolve(ctx context.Context, rawURL string) (source.Ref, error) {
	itemType, itemID, bandID, err := p.c.Resolve(ctx, rawURL)
	if err != nil {
		return source.Ref{}, err
	}
	return source.Ref{
		Source: SourceID,
		Kind:   itemType,
		ID:     strconv.FormatInt(itemID, 10),
		Extra:  strconv.FormatInt(bandID, 10),
	}, nil
}

func (p *Provider) Expand(ctx context.Context, ref source.Ref) ([]source.Track, error) {
	itemID, bandID, err := refIDs(ref)
	if err != nil {
		return nil, err
	}
	detail, err := p.c.Details(ctx, ref.Kind, itemID, bandID)
	if err != nil {
		return nil, err
	}

	out := make([]source.Track, 0, len(detail.Tracks))
	for _, t := range detail.Tracks {
		out = append(out, source.Track{
			SourceID:   strconv.FormatInt(t.TrackID, 10),
			SourceRef:  strconv.FormatInt(t.BandID, 10),
			AlbumRef:   formatOptID(t.AlbumID),
			ArtRef:     formatOptID(t.ArtID),
			Title:      t.Title,
			Artist:     t.Artist,
			AlbumTitle: t.AlbumTitle,
			Duration:   t.Duration,
			ArtURL:     t.ArtURL,
			PageURL:    t.TrackURL,
			// A track with no preview stream could never be played back, which
			// is why adds have always skipped them.
			Playable: t.Streamable,
		})
	}
	return out, nil
}

func (p *Provider) StreamURL(ctx context.Context, ref source.Ref) (string, error) {
	trackID, bandID, err := refIDs(ref)
	if err != nil {
		return "", err
	}
	return p.c.StreamURL(ctx, trackID, bandID)
}

func (p *Provider) Caps() source.Caps {
	return source.Caps{
		Stream: true,
		// The audio can be relayed same-origin through /api/bc/audio, which is
		// what lets the browser read samples for tempo, key and waveform.
		Analyze: true,
		Search:  true,
		Embed:   false,
	}
}

// CSP reproduces exactly the origins the hard-coded policy carried before the
// header was assembled from providers: art comes from the bcbits CDN and audio
// is redirected there from /api/bc/stream.
func (p *Provider) CSP() source.CSP {
	return source.CSP{
		Media: []string{"https://*.bcbits.com", "https://bandcamp.com"},
	}
}

// formatOptID renders an optional Bandcamp id as text, empty for absent, which
// is how the neutral Track carries "this source has no such id".
func formatOptID(id *int64) string {
	if id == nil {
		return ""
	}
	return strconv.FormatInt(*id, 10)
}

// refIDs re-parses the two numbers a Bandcamp Ref carries. The contract keeps
// them as opaque text so that no other package has to know Bandcamp's ids are
// integers; this is the one place that knowledge lives.
func refIDs(ref source.Ref) (itemID, bandID int64, err error) {
	itemID, err = strconv.ParseInt(ref.ID, 10, 64)
	if err != nil || itemID <= 0 {
		return 0, 0, fmt.Errorf("bandcamp: invalid item id %q", ref.ID)
	}
	bandID, err = strconv.ParseInt(ref.Extra, 10, 64)
	if err != nil || bandID <= 0 {
		return 0, 0, fmt.Errorf("bandcamp: invalid band id %q", ref.Extra)
	}
	return itemID, bandID, nil
}

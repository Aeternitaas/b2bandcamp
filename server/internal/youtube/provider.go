// Package youtube adds YouTube videos and playlists as playlist tracks.
//
// How much it can do depends on how the instance is set up, and the provider
// reports that through Caps rather than the client guessing:
//
//   - With no configuration it adds videos by link, through the keyless oEmbed
//     endpoint, with no duration.
//   - With YOUTUBE_API_KEY it reports durations, expands playlist links, and
//     answers catalog search and channel browsing.
//   - With an audio extractor installed (see audio.go) it also streams, which
//     in turn makes tempo, key and waveform detection work, because those need
//     the same samples.
//
// Manual bpm, key and note edits work in every one of those cases: those
// columns were never tied to a source.
package youtube

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/aeternitaas/b2bandcamp/server/internal/source"
)

// SourceID is the registry key and the value stored in playlist_tracks.source.
const SourceID = "youtube"

const (
	apiBase       = "https://www.googleapis.com/youtube/v3"
	oembedURL     = "https://www.youtube.com/oembed"
	maxIDsPerCall = 50 // videos.list accepts 50 ids for one quota unit

	// maxPlaylistItems bounds expansion of a playlist link. YouTube playlists
	// run to thousands of entries, which would be both a wall of API calls and
	// more rows than anyone meant to add by pasting one URL.
	maxPlaylistItems = 200
)

// Provider implements source.Provider, and source.Streamer when an audio
// extractor is installed. See audio.go for why that one is conditional.
type Provider struct {
	apiKey string
	http   *http.Client
	// base is the Data API root. It is a field rather than the constant so
	// tests can point it at a stub and exercise the keyed path, which is
	// otherwise reachable only with real API credentials.
	base string

	// ytdlp is the resolved path to the audio extractor, empty when none is
	// installed. Resolved once at construction: see findExtractor.
	ytdlp string

	// streams holds resolved audio urls, which expire, and results holds
	// answers to catalog calls, which cost quota.
	streams *ttlCache[string]
	results *ttlCache[[]Result]
}

var (
	_ source.Provider = (*Provider)(nil)
	_ source.Streamer = (*Provider)(nil)
)

// New builds the provider. An empty key is valid and selects the keyless oEmbed
// path, which cannot report durations; that is a deliberate trade so a
// self-hosted instance works without anyone registering for API access.
func New(apiKey string, opts ...Option) *Provider {
	p := &Provider{
		apiKey:  strings.TrimSpace(apiKey),
		http:    &http.Client{Timeout: 15 * time.Second},
		base:    apiBase,
		streams: newTTLCache[string](),
		results: newTTLCache[[]Result](),
	}
	for _, opt := range opts {
		opt(p)
	}
	p.ytdlp = findExtractor(p.ytdlp)
	return p
}

// HasAPIKey reports whether the richer Data API path is in use. Callers use it
// for logging at startup, so an operator can tell which mode they are in
// without adding a track and inspecting its duration.
func (p *Provider) HasAPIKey() bool { return p.apiKey != "" }

func (p *Provider) ID() string   { return SourceID }
func (p *Provider) Name() string { return "YouTube" }

func (p *Provider) Match(rawURL string) bool {
	_, _, ok := parseURL(rawURL)
	return ok
}

// Resolve needs no network at all: a YouTube URL carries its own id.
func (p *Provider) Resolve(ctx context.Context, rawURL string) (source.Ref, error) {
	_ = ctx
	kind, id, ok := parseURL(rawURL)
	if !ok {
		return source.Ref{}, fmt.Errorf("youtube: %q is not a video or playlist link", rawURL)
	}
	if kind == KindPlaylist && p.apiKey == "" {
		return source.Ref{}, fmt.Errorf("youtube: expanding a playlist link needs YOUTUBE_API_KEY; add the videos individually, or set a key")
	}
	return source.Ref{Source: SourceID, Kind: kind, ID: id}, nil
}

func (p *Provider) Expand(ctx context.Context, ref source.Ref) ([]source.Track, error) {
	switch ref.Kind {
	case KindVideo:
		if !validVideoID(ref.ID) {
			return nil, fmt.Errorf("youtube: %q is not a video id", ref.ID)
		}
		return p.videos(ctx, []string{ref.ID})

	case KindPlaylist:
		if !validPlaylistID(ref.ID) {
			return nil, fmt.Errorf("youtube: %q is not a playlist id", ref.ID)
		}
		ids, err := p.playlistVideoIDs(ctx, ref.ID)
		if err != nil {
			return nil, err
		}
		if len(ids) == 0 {
			return nil, fmt.Errorf("youtube: that playlist has no playable videos")
		}
		return p.videos(ctx, ids)
	}
	return nil, fmt.Errorf("%w: youtube kind %q", source.ErrUnsupported, ref.Kind)
}

// Caps is answered from what this build can actually do rather than from a
// constant, because two of the four depend on how the instance is set up: an
// extractor makes audio reachable, and a key makes the catalog reachable.
func (p *Provider) Caps() source.Caps {
	stream := p.CanStream()
	return source.Caps{
		Stream: stream,
		// The same relay that feeds the audio element feeds an AnalyserNode,
		// same-origin, so these two are one question and not two.
		Analyze: stream,
		// search.list costs 100 of the 10,000 daily quota units, which is why
		// results are cached and why this is off without a key.
		Search: p.apiKey != "",
		// Embedding is the fallback for when this server cannot hand over the
		// audio itself. With an extractor the row plays like any other.
		Embed: !stream,
	}
}

// CSP asks for the embedded player's origins only when the embedded player is
// what plays these rows. When the audio comes through this server's own relay
// the policy needs nothing: media-src already carries 'self', and thumbnails
// are covered by the blanket https: img-src. An origin nothing loads from is
// still an origin the policy permits, so it is not left in.
func (p *Provider) CSP() source.CSP {
	if p.CanStream() {
		return source.CSP{}
	}
	return source.CSP{
		// The nocookie host is the same player without the tracking cookies.
		Frame:  []string{"https://www.youtube-nocookie.com"},
		Script: []string{"https://www.youtube.com"},
	}
}

// ---------- metadata ----------

// videos fetches display data for up to a few hundred ids, by whichever route
// is available.
func (p *Provider) videos(ctx context.Context, ids []string) ([]source.Track, error) {
	if p.apiKey == "" {
		return p.viaOEmbed(ctx, ids)
	}
	return p.viaDataAPI(ctx, ids)
}

type videoListResponse struct {
	Items []struct {
		ID      string `json:"id"`
		Snippet struct {
			Title        string `json:"title"`
			ChannelTitle string `json:"channelTitle"`
			Thumbnails   map[string]struct {
				URL string `json:"url"`
			} `json:"thumbnails"`
		} `json:"snippet"`
		ContentDetails struct {
			Duration string `json:"duration"`
		} `json:"contentDetails"`
		Status struct {
			Embeddable bool `json:"embeddable"`
		} `json:"status"`
	} `json:"items"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

// viaDataAPI is the full-fidelity path: titles, channel, thumbnail, a real
// duration, and whether the video may be embedded at all.
func (p *Provider) viaDataAPI(ctx context.Context, ids []string) ([]source.Track, error) {
	// The API returns items in an unspecified order and omits ids it cannot
	// serve, so results are collected by id and re-ordered to match the request.
	found := make(map[string]source.Track, len(ids))

	for start := 0; start < len(ids); start += maxIDsPerCall {
		end := min(start+maxIDsPerCall, len(ids))

		q := url.Values{}
		q.Set("part", "snippet,contentDetails,status")
		q.Set("id", strings.Join(ids[start:end], ","))
		q.Set("key", p.apiKey)
		q.Set("maxResults", "50")

		var out videoListResponse
		if err := p.getJSON(ctx, p.base+"/videos?"+q.Encode(), &out); err != nil {
			return nil, err
		}
		if out.Error != nil {
			return nil, fmt.Errorf("youtube: api error %d: %s", out.Error.Code, out.Error.Message)
		}

		for _, it := range out.Items {
			artist, title := artistAndTitle(it.Snippet.Title, it.Snippet.ChannelTitle)
			found[it.ID] = source.Track{
				SourceID: it.ID,
				Title:    title,
				Artist:   artist,
				Duration: parseISODuration(it.ContentDetails.Duration),
				ArtURL:   bestThumbnail(it.Snippet.Thumbnails),
				PageURL:  watchURL(it.ID),
				// Embedding only matters when the embedded player is what
				// plays these rows. With an extractor installed the audio comes
				// from this server, and an uploader's embedding setting has
				// nothing to say about that.
				Playable: it.Status.Embeddable || p.CanStream(),
			}
		}
	}

	out := make([]source.Track, 0, len(found))
	for _, id := range ids {
		if t, ok := found[id]; ok {
			out = append(out, t)
		}
	}
	if len(out) == 0 {
		return nil, source.ErrNotFound
	}
	return out, nil
}

type oembedResponse struct {
	Title        string `json:"title"`
	AuthorName   string `json:"author_name"`
	ThumbnailURL string `json:"thumbnail_url"`
}

// viaOEmbed is the keyless fallback. It costs one request per video and cannot
// report a duration, so rows added this way show 0:00 and contribute nothing to
// the playlist total until someone sets a key and they are re-added.
func (p *Provider) viaOEmbed(ctx context.Context, ids []string) ([]source.Track, error) {
	out := make([]source.Track, 0, len(ids))
	for _, id := range ids {
		q := url.Values{}
		q.Set("url", watchURL(id))
		q.Set("format", "json")

		var r oembedResponse
		if err := p.getJSON(ctx, oembedURL+"?"+q.Encode(), &r); err != nil {
			// One unavailable video in a batch should not sink the whole add.
			continue
		}
		artist, title := artistAndTitle(r.Title, r.AuthorName)
		out = append(out, source.Track{
			SourceID: id,
			Title:    title,
			Artist:   artist,
			ArtURL:   r.ThumbnailURL,
			PageURL:  watchURL(id),
			// oEmbed answering at all means the video exists and is embeddable;
			// it returns 401 for videos that are not.
			Playable: true,
		})
	}
	if len(out) == 0 {
		return nil, source.ErrNotFound
	}
	return out, nil
}

type playlistItemsResponse struct {
	NextPageToken string `json:"nextPageToken"`
	Items         []struct {
		ContentDetails struct {
			VideoID string `json:"videoId"`
		} `json:"contentDetails"`
	} `json:"items"`
	Error *struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"error"`
}

func (p *Provider) playlistVideoIDs(ctx context.Context, playlistID string) ([]string, error) {
	var ids []string
	pageToken := ""

	for len(ids) < maxPlaylistItems {
		q := url.Values{}
		q.Set("part", "contentDetails")
		q.Set("playlistId", playlistID)
		q.Set("maxResults", "50")
		q.Set("key", p.apiKey)
		if pageToken != "" {
			q.Set("pageToken", pageToken)
		}

		var out playlistItemsResponse
		if err := p.getJSON(ctx, p.base+"/playlistItems?"+q.Encode(), &out); err != nil {
			return nil, err
		}
		if out.Error != nil {
			return nil, fmt.Errorf("youtube: api error %d: %s", out.Error.Code, out.Error.Message)
		}

		for _, it := range out.Items {
			if id := it.ContentDetails.VideoID; validVideoID(id) {
				ids = append(ids, id)
				if len(ids) == maxPlaylistItems {
					return ids, nil
				}
			}
		}
		if out.NextPageToken == "" {
			break
		}
		pageToken = out.NextPageToken
	}
	return ids, nil
}

// ---------- http ----------

func (p *Provider) getJSON(ctx context.Context, endpoint string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	resp, err := p.http.Do(req)
	if err != nil {
		return err
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		resp.Body.Close()
	}()

	if resp.StatusCode == http.StatusNotFound || resp.StatusCode == http.StatusUnauthorized {
		return source.ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		// Google explains the refusal in the body, and that explanation is the
		// difference between "youtube is broken" and "your key is wrong" or
		// "you are out of quota". It is worth repeating; the request URL is
		// not, because the key is in its query string.
		return fmt.Errorf("youtube: %s (http %d)", apiErrorMessage(resp.Body), resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 4<<20)).Decode(out)
}

// bestThumbnail picks the largest thumbnail YouTube offers, preferring sizes
// that exist for every video over ones only some have.
func bestThumbnail(thumbs map[string]struct {
	URL string `json:"url"`
}) string {
	for _, name := range []string{"maxres", "standard", "high", "medium", "default"} {
		if t, ok := thumbs[name]; ok && t.URL != "" {
			return t.URL
		}
	}
	return ""
}

// parseISODuration reads the ISO-8601 form the Data API reports, PT1H2M3S.
// Anything it cannot read becomes 0, which renders as an unknown length rather
// than a wrong one. Live streams report P0D, which correctly yields 0.
func parseISODuration(s string) float64 {
	if !strings.HasPrefix(s, "P") {
		return 0
	}
	s = s[1:]

	var total, cur float64
	inTime := false
	for _, r := range s {
		switch {
		case r == 'T':
			inTime = true
			cur = 0
		case r >= '0' && r <= '9':
			cur = cur*10 + float64(r-'0')
		case r == 'H' && inTime:
			total += cur * 3600
			cur = 0
		case r == 'M' && inTime:
			total += cur * 60
			cur = 0
		case r == 'S' && inTime:
			total += cur
			cur = 0
		case r == 'D':
			total += cur * 86400
			cur = 0
		default:
			// Weeks, months and years cannot appear in a video duration.
			return 0
		}
	}
	return total
}

// apiErrorMessage pulls Google's own explanation out of an error response, so a
// misconfigured key or an exhausted quota says so instead of arriving as a bare
// status code.
func apiErrorMessage(body io.Reader) string {
	var envelope struct {
		Error struct {
			Message string `json:"message"`
			Errors  []struct {
				Reason string `json:"reason"`
			} `json:"errors"`
		} `json:"error"`
	}
	if err := json.NewDecoder(io.LimitReader(body, 64<<10)).Decode(&envelope); err != nil {
		return "request refused"
	}
	msg := strings.TrimSpace(envelope.Error.Message)
	if msg == "" {
		return "request refused"
	}
	if len(envelope.Error.Errors) > 0 && envelope.Error.Errors[0].Reason != "" {
		return envelope.Error.Errors[0].Reason + ": " + msg
	}
	return msg
}

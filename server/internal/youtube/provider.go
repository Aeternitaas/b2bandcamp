// Package youtube adds YouTube links as playlist tracks.
//
// It is a second-class source by design, and by necessity. YouTube's terms
// require playback through its own player, so this server never resolves or
// relays audio: it stores what a row needs to be displayed and identified, and
// the client mounts YouTube's iframe player on the video id. Because the audio
// samples never reach the browser same-origin, tempo, key and waveform
// detection cannot run on these tracks either. Manual bpm, key and note edits
// work exactly as they do for any other row.
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

// Provider implements source.Provider. It deliberately does not implement
// source.Streamer: see the package comment.
type Provider struct {
	apiKey string
	http   *http.Client
	// base is the Data API root. It is a field rather than the constant so
	// tests can point it at a stub and exercise the keyed path, which is
	// otherwise reachable only with real API credentials.
	base string
}

var _ source.Provider = (*Provider)(nil)

// New builds the provider. An empty key is valid and selects the keyless oEmbed
// path, which cannot report durations; that is a deliberate trade so a
// self-hosted instance works without anyone registering for API access.
func New(apiKey string) *Provider {
	return &Provider{
		apiKey: strings.TrimSpace(apiKey),
		http:   &http.Client{Timeout: 15 * time.Second},
		base:   apiBase,
	}
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

func (p *Provider) Caps() source.Caps {
	return source.Caps{
		Stream:  false, // playback is YouTube's player, never this server
		Analyze: false, // the samples never reach the browser same-origin
		Search:  false, // search.list costs 100 quota units per call
		Embed:   true,
	}
}

func (p *Provider) CSP() source.CSP {
	return source.CSP{
		// The nocookie host is the same player without the tracking cookies.
		Frame:  []string{"https://www.youtube-nocookie.com"},
		Script: []string{"https://www.youtube.com"},
		// Thumbnails are covered by the policy's blanket https: img-src.
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
			found[it.ID] = source.Track{
				SourceID: it.ID,
				Title:    it.Snippet.Title,
				Artist:   it.Snippet.ChannelTitle,
				Duration: parseISODuration(it.ContentDetails.Duration),
				ArtURL:   bestThumbnail(it.Snippet.Thumbnails),
				PageURL:  watchURL(it.ID),
				// A video the uploader blocked from embedding could never be
				// played here, so it is skipped the same way a Bandcamp track
				// with no preview stream is.
				Playable: it.Status.Embeddable,
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
		out = append(out, source.Track{
			SourceID: id,
			Title:    r.Title,
			Artist:   r.AuthorName,
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

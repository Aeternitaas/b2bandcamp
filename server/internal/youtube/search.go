package youtube

import (
	"context"
	"errors"
	"fmt"
	"html"
	"net/url"
	"strings"
	"time"

	"github.com/aeternitaas/b2bandcamp/server/internal/source"
)

// Catalog browsing: searching, resolving a channel, and listing what a channel
// has published. All of it needs YOUTUBE_API_KEY, and all of it is cached,
// because search.list costs 100 of the 10,000 daily quota units per call where
// everything else here costs 1.

const (
	// searchTTL keeps a repeated query off the quota. Typing "aphex" and then
	// "aphex twin" is two searches either way, but going back to the first one
	// should not be a third.
	searchTTL = 15 * time.Minute

	// browseTTL covers channel and playlist listings. They cost one unit each,
	// so this is about latency rather than quota.
	browseTTL = 10 * time.Minute

	maxSearchResults   = 25
	maxPlaylistsPerReq = 50
)

// Result is one row a browse or search returned: a video, a playlist or a
// channel. One type covers all three because the client renders them in one
// list, the way Bandcamp's search mixes albums, tracks and artists.
type Result struct {
	// Kind is "v", "p" or "c". The first two match the Ref kinds this provider
	// expands, so a client can hand either straight back as an add.
	Kind      string  `json:"kind"`
	ID        string  `json:"id"`
	Title     string  `json:"title"`
	Artist    string  `json:"artist"`
	ChannelID string  `json:"channel_id"`
	ArtURL    string  `json:"art_url"`
	URL       string  `json:"url"`
	Duration  float64 `json:"duration"`
	ItemCount int     `json:"item_count"`
	// Playable is false for a video this server could not play even if it were
	// added, such as one the uploader has taken down. Adding it would make a
	// row nobody can play, which is the same thing a non-streamable Bandcamp
	// track would be.
	Playable bool `json:"playable"`
}

// Channel is a YouTube account, as the browser of one needs it.
type Channel struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	Handle   string `json:"handle"`
	ImageURL string `json:"image_url"`
	// Uploads is the playlist id holding everything this channel has posted.
	// YouTube maintains it for every channel, and it is the only thing to show
	// for an account that publishes videos but curates no playlists.
	Uploads string `json:"uploads_playlist_id"`
}

// errNoKey is what every call here fails with when the instance has no key.
// Phrased for the person who sees it in the UI, since that is where it lands.
func errNoKey(what string) error {
	return fmt.Errorf("%w: youtube %s needs YOUTUBE_API_KEY to be set on this server", source.ErrUnsupported, what)
}

// ---------- search ----------

// Search queries the catalog. kind is "v", "p", "c", or empty for all three.
func (p *Provider) Search(ctx context.Context, query, kind string) ([]Result, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return nil, nil
	}
	if p.apiKey == "" {
		return nil, errNoKey("search")
	}

	cacheKey := "s:" + kind + ":" + strings.ToLower(query)
	if hit, ok := p.results.get(cacheKey); ok {
		return hit, nil
	}

	types, err := searchTypes(kind)
	if err != nil {
		return nil, err
	}

	q := url.Values{}
	q.Set("part", "snippet")
	q.Set("q", query)
	q.Set("type", types)
	q.Set("maxResults", fmt.Sprint(maxSearchResults))
	q.Set("key", p.apiKey)

	var out searchResponse
	if err := p.getJSON(ctx, p.base+"/search?"+q.Encode(), &out); err != nil {
		return nil, err
	}
	if out.Error != nil {
		return nil, fmt.Errorf("youtube: api error %d: %s", out.Error.Code, out.Error.Message)
	}

	results := make([]Result, 0, len(out.Items))
	for _, it := range out.Items {
		r := Result{
			Title:     decodeEntities(it.Snippet.Title),
			Artist:    it.Snippet.ChannelTitle,
			ChannelID: it.Snippet.ChannelID,
			ArtURL:    bestThumbnail(it.Snippet.Thumbnails),
		}
		switch {
		case it.ID.VideoID != "":
			r.Kind, r.ID, r.URL = KindVideo, it.ID.VideoID, watchURL(it.ID.VideoID)
			// search.list only returns videos that are up, so anything listed
			// here can be added; fillDurations corrects this from videos.list,
			// which is the call that actually knows.
			r.Playable = true
			// A video result's title is the raw upload title. Splitting it the
			// same way an added row is split keeps the list and the playlist
			// describing the track identically.
			r.Artist, r.Title = artistAndTitle(r.Title, it.Snippet.ChannelTitle)
		case it.ID.PlaylistID != "":
			r.Kind, r.ID, r.URL = KindPlaylist, it.ID.PlaylistID, playlistURL(it.ID.PlaylistID)
		case it.ID.ChannelID != "":
			r.Kind, r.ID = "c", it.ID.ChannelID
			r.ChannelID, r.URL = it.ID.ChannelID, channelURL(it.ID.ChannelID)
		default:
			continue
		}
		// search.list treats `type` as a hint rather than a filter: asking for
		// playlists still returns the channel it thinks you meant. Whoever
		// asked for one kind gets one kind.
		if kind != "" && r.Kind != kind {
			continue
		}
		results = append(results, r)
	}

	// search.list reports neither a video's duration nor a playlist's length,
	// and a list with neither is hard to read. Each of these costs one further
	// unit next to the hundred already spent.
	p.fillDurations(ctx, results)
	p.fillPlaylistCounts(ctx, results)

	p.results.set(cacheKey, results, searchTTL)
	return results, nil
}

func searchTypes(kind string) (string, error) {
	switch kind {
	case "":
		return "video,playlist,channel", nil
	case KindVideo:
		return "video", nil
	case KindPlaylist:
		return "playlist", nil
	case "c":
		return "channel", nil
	}
	return "", fmt.Errorf("youtube: unknown result kind %q", kind)
}

// fillDurations looks up the runtime of every video in the list, in place.
// A failure leaves the durations at zero rather than failing the search: a
// result list with no times is still a usable result list.
func (p *Provider) fillDurations(ctx context.Context, results []Result) {
	ids := make([]string, 0, len(results))
	for _, r := range results {
		if r.Kind == KindVideo {
			ids = append(ids, r.ID)
		}
	}
	if len(ids) == 0 {
		return
	}

	tracks, err := p.viaDataAPI(ctx, ids)
	if err != nil {
		return
	}
	byID := make(map[string]source.Track, len(tracks))
	for _, t := range tracks {
		byID[t.SourceID] = t
	}
	for i := range results {
		if t, ok := byID[results[i].ID]; ok {
			results[i].Duration = t.Duration
			results[i].Playable = t.Playable
		}
	}
}

// fillPlaylistCounts looks up how many videos each playlist holds, in place.
// Like fillDurations, a failure leaves the counts at zero rather than failing
// the search, and the client shows no count rather than a wrong one.
func (p *Provider) fillPlaylistCounts(ctx context.Context, results []Result) {
	ids := make([]string, 0, len(results))
	for _, r := range results {
		if r.Kind == KindPlaylist {
			ids = append(ids, r.ID)
		}
	}
	if len(ids) == 0 {
		return
	}

	q := url.Values{}
	q.Set("part", "contentDetails")
	q.Set("id", strings.Join(ids, ","))
	q.Set("maxResults", fmt.Sprint(maxPlaylistsPerReq))
	q.Set("key", p.apiKey)

	var out playlistListResponse
	if err := p.getJSON(ctx, p.base+"/playlists?"+q.Encode(), &out); err != nil || out.Error != nil {
		return
	}

	counts := make(map[string]int, len(out.Items))
	for _, it := range out.Items {
		counts[it.ID] = it.ContentDetails.ItemCount
	}
	for i := range results {
		if n, ok := counts[results[i].ID]; ok {
			results[i].ItemCount = n
		}
	}
}

// ---------- channels ----------

// LookupChannel resolves whatever someone typed into a channel: a @handle, a
// channel URL of any of YouTube's four shapes, or a plain name.
func (p *Provider) LookupChannel(ctx context.Context, input string) (Channel, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return Channel{}, fmt.Errorf("youtube: no channel given")
	}
	if p.apiKey == "" {
		return Channel{}, errNoKey("channel lookup")
	}

	if hit, ok := p.results.get("c:" + strings.ToLower(input)); ok && len(hit) == 1 {
		return channelFromResult(hit[0]), nil
	}

	param, value := channelQuery(input)
	ch, err := p.channelBy(ctx, param, value)
	if err == nil {
		p.results.set("c:"+strings.ToLower(input), []Result{resultFromChannel(ch)}, browseTTL)
		return ch, nil
	}
	if !isNotFound(err) {
		return Channel{}, err
	}

	// Nothing matched exactly. A person typing a display name rather than a
	// handle is the common case here, and search is the only way to resolve
	// one, so it is worth the quota as a fallback rather than as the first try.
	found, serr := p.Search(ctx, input, "c")
	if serr != nil || len(found) == 0 {
		return Channel{}, fmt.Errorf("%w: youtube: no channel called %q", source.ErrNotFound, input)
	}
	ch, err = p.channelBy(ctx, "id", found[0].ID)
	if err != nil {
		return Channel{}, err
	}
	p.results.set("c:"+strings.ToLower(input), []Result{resultFromChannel(ch)}, browseTTL)
	return ch, nil
}

// channelQuery decides which of channels.list's three mutually exclusive
// selectors fits the input. Handles are current, /user/ names are legacy, and a
// UC... id is what both eventually resolve to.
func channelQuery(input string) (param, value string) {
	if kind, id, ok := parseChannelURL(input); ok {
		return kind, id
	}
	if strings.HasPrefix(input, "@") {
		return "forHandle", input
	}
	if validChannelID(input) {
		return "id", input
	}
	return "forHandle", "@" + input
}

func (p *Provider) channelBy(ctx context.Context, param, value string) (Channel, error) {
	q := url.Values{}
	q.Set("part", "snippet,contentDetails")
	q.Set(param, value)
	q.Set("key", p.apiKey)

	var out channelListResponse
	if err := p.getJSON(ctx, p.base+"/channels?"+q.Encode(), &out); err != nil {
		return Channel{}, err
	}
	if out.Error != nil {
		return Channel{}, fmt.Errorf("youtube: api error %d: %s", out.Error.Code, out.Error.Message)
	}
	if len(out.Items) == 0 {
		return Channel{}, fmt.Errorf("%w: youtube: no channel for %s=%s", source.ErrNotFound, param, value)
	}

	it := out.Items[0]
	return Channel{
		ID:       it.ID,
		Title:    decodeEntities(it.Snippet.Title),
		Handle:   it.Snippet.CustomURL,
		ImageURL: bestThumbnail(it.Snippet.Thumbnails),
		Uploads:  it.ContentDetails.RelatedPlaylists.Uploads,
	}, nil
}

// Playlists lists one channel's public playlists, a page at a time.
func (p *Provider) Playlists(ctx context.Context, channelID, pageToken string) ([]Result, string, error) {
	if p.apiKey == "" {
		return nil, "", errNoKey("channel browsing")
	}
	if !validChannelID(channelID) {
		return nil, "", fmt.Errorf("youtube: %q is not a channel id", channelID)
	}

	q := url.Values{}
	q.Set("part", "snippet,contentDetails")
	q.Set("channelId", channelID)
	q.Set("maxResults", fmt.Sprint(maxPlaylistsPerReq))
	q.Set("key", p.apiKey)
	if pageToken != "" {
		q.Set("pageToken", pageToken)
	}

	var out playlistListResponse
	if err := p.getJSON(ctx, p.base+"/playlists?"+q.Encode(), &out); err != nil {
		return nil, "", err
	}
	if out.Error != nil {
		return nil, "", fmt.Errorf("youtube: api error %d: %s", out.Error.Code, out.Error.Message)
	}

	results := make([]Result, 0, len(out.Items))
	for _, it := range out.Items {
		results = append(results, resultFromPlaylist(it))
	}
	return results, out.NextPageToken, nil
}

// Lookup describes the video or the playlist behind a pasted link, and adds
// nothing. The client shows the result, and a person then confirms the add.
// A Bandcamp link gets the same step through /api/bc/resolve.
func (p *Provider) Lookup(ctx context.Context, rawURL string) (Result, error) {
	kind, id, ok := parseURL(rawURL)
	if !ok {
		return Result{}, fmt.Errorf("%w: youtube: that is not a video or playlist link", source.ErrUnsupported)
	}

	switch kind {
	case KindVideo:
		tracks, err := p.videos(ctx, []string{id})
		if isNotFound(err) {
			return Result{}, fmt.Errorf("%w: youtube: that video is private, removed or cannot be embedded", source.ErrNotFound)
		}
		if err != nil {
			return Result{}, err
		}
		t := tracks[0]
		return Result{
			Kind:     KindVideo,
			ID:       t.SourceID,
			Title:    t.Title,
			Artist:   t.Artist,
			ArtURL:   t.ArtURL,
			URL:      t.PageURL,
			Duration: t.Duration,
			Playable: t.Playable,
		}, nil

	case KindPlaylist:
		if p.apiKey == "" {
			return Result{}, errNoKey("playlist browsing")
		}
		q := url.Values{}
		q.Set("part", "snippet,contentDetails")
		q.Set("id", id)
		q.Set("key", p.apiKey)

		var out playlistListResponse
		if err := p.getJSON(ctx, p.base+"/playlists?"+q.Encode(), &out); err != nil {
			return Result{}, err
		}
		if out.Error != nil {
			return Result{}, fmt.Errorf("youtube: api error %d: %s", out.Error.Code, out.Error.Message)
		}
		if len(out.Items) == 0 {
			return Result{}, fmt.Errorf("%w: youtube: that playlist is private or does not exist", source.ErrNotFound)
		}
		return resultFromPlaylist(out.Items[0]), nil
	}
	return Result{}, fmt.Errorf("%w: youtube kind %q", source.ErrUnsupported, kind)
}

// PlaylistTracks expands one page of a playlist into the same Result rows a
// search returns, so every list the client renders from YouTube has one shape.
func (p *Provider) PlaylistTracks(ctx context.Context, playlistID, pageToken string) ([]Result, string, error) {
	if p.apiKey == "" {
		return nil, "", errNoKey("playlist browsing")
	}
	if !validPlaylistID(playlistID) {
		return nil, "", fmt.Errorf("youtube: %q is not a playlist id", playlistID)
	}

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
		return nil, "", err
	}
	if out.Error != nil {
		return nil, "", fmt.Errorf("youtube: api error %d: %s", out.Error.Code, out.Error.Message)
	}

	ids := make([]string, 0, len(out.Items))
	for _, it := range out.Items {
		if id := it.ContentDetails.VideoID; validVideoID(id) {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return nil, out.NextPageToken, nil
	}

	// playlistItems carries a title and a thumbnail of its own, but no
	// duration, and its title for a deleted video is the literal string
	// "Deleted video". Going back through videos.list costs one more unit and
	// gives the same rows an add would produce, including which are playable.
	tracks, err := p.videos(ctx, ids)
	if err != nil {
		return nil, "", err
	}

	results := make([]Result, 0, len(tracks))
	for _, t := range tracks {
		results = append(results, Result{
			Kind:     KindVideo,
			ID:       t.SourceID,
			Title:    t.Title,
			Artist:   t.Artist,
			ArtURL:   t.ArtURL,
			URL:      t.PageURL,
			Duration: t.Duration,
			Playable: t.Playable,
		})
	}
	return results, out.NextPageToken, nil
}

// ---------- response shapes ----------

type apiFailure struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type thumbnailSet map[string]struct {
	URL string `json:"url"`
}

type searchResponse struct {
	Items []struct {
		ID struct {
			VideoID    string `json:"videoId"`
			PlaylistID string `json:"playlistId"`
			ChannelID  string `json:"channelId"`
		} `json:"id"`
		Snippet struct {
			Title        string       `json:"title"`
			ChannelTitle string       `json:"channelTitle"`
			ChannelID    string       `json:"channelId"`
			Thumbnails   thumbnailSet `json:"thumbnails"`
		} `json:"snippet"`
	} `json:"items"`
	Error *apiFailure `json:"error"`
}

type channelListResponse struct {
	Items []struct {
		ID      string `json:"id"`
		Snippet struct {
			Title      string       `json:"title"`
			CustomURL  string       `json:"customUrl"`
			Thumbnails thumbnailSet `json:"thumbnails"`
		} `json:"snippet"`
		ContentDetails struct {
			RelatedPlaylists struct {
				Uploads string `json:"uploads"`
			} `json:"relatedPlaylists"`
		} `json:"contentDetails"`
	} `json:"items"`
	Error *apiFailure `json:"error"`
}

type playlistListResponse struct {
	NextPageToken string             `json:"nextPageToken"`
	Items         []playlistListItem `json:"items"`
	Error         *apiFailure        `json:"error"`
}

type playlistListItem struct {
	ID      string `json:"id"`
	Snippet struct {
		Title        string       `json:"title"`
		ChannelTitle string       `json:"channelTitle"`
		ChannelID    string       `json:"channelId"`
		Thumbnails   thumbnailSet `json:"thumbnails"`
	} `json:"snippet"`
	ContentDetails struct {
		ItemCount int `json:"itemCount"`
	} `json:"contentDetails"`
}

// resultFromPlaylist is the one mapping from a playlists.list item to a row, so
// channel browsing and link lookup can never describe a playlist differently.
func resultFromPlaylist(it playlistListItem) Result {
	return Result{
		Kind:      KindPlaylist,
		ID:        it.ID,
		Title:     decodeEntities(it.Snippet.Title),
		Artist:    it.Snippet.ChannelTitle,
		ChannelID: it.Snippet.ChannelID,
		ArtURL:    bestThumbnail(it.Snippet.Thumbnails),
		URL:       playlistURL(it.ID),
		ItemCount: it.ContentDetails.ItemCount,
	}
}

// ---------- small helpers ----------

func resultFromChannel(c Channel) Result {
	return Result{
		Kind: "c", ID: c.ID, Title: c.Title, Artist: c.Handle,
		ChannelID: c.ID, ArtURL: c.ImageURL, URL: channelURL(c.ID),
		ItemCount: 0,
	}
}

// channelFromResult is the inverse, for a cached lookup. Only the fields a
// Channel actually carries survive the round trip, which is all of them bar
// the uploads playlist; that is carried in URL, since a cached Result exists
// only to answer the same lookup again.
func channelFromResult(r Result) Channel {
	return Channel{ID: r.ID, Title: r.Title, Handle: r.Artist, ImageURL: r.ArtURL, Uploads: uploadsPlaylistID(r.ID)}
}

// decodeEntities undoes the HTML escaping that search.list applies to titles
// and channel names, where videos.list returns the same strings unescaped. A
// title reading "Slowdive &#39;Souvlaki&#39;" in one list and correctly in the
// other is that difference and nothing deeper.
func decodeEntities(s string) string { return html.UnescapeString(s) }

// isNotFound reports whether an error means "no such thing", as opposed to a
// failure to ask. Only the first is worth a second attempt by another route.
func isNotFound(err error) bool { return errors.Is(err, source.ErrNotFound) }

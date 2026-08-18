// Package bandcamp wraps the public endpoints that back Bandcamp's own web and
// mobile clients. Nothing here requires credentials, and no purchased or
// download-only media is touched — only the same 128kbps preview streams the
// public site plays.
//
// Endpoints used (verified against live responses):
//
//	POST /api/bcsearch_public_api/1/autocomplete_elastic  — search
//	GET  /api/mobile/24/tralbum_details                   — album/track detail
//	POST /api/fancollection/1/wishlist_items              — a fan's wishlist
//	GET  <tralbum page>                                   — url -> ids, via meta tags
package bandcamp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	searchURL   = "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic"
	detailsURL  = "https://bandcamp.com/api/mobile/24/tralbum_details"
	wishlistURL = "https://bandcamp.com/api/fancollection/1/wishlist_items"

	// A browser UA; Bandcamp serves a stripped page to unrecognised clients.
	userAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36"

	detailTTL = 5 * time.Minute  // holds signed stream urls, so keep it short
	pageTTL   = 30 * time.Minute // url -> id mapping is effectively permanent
	fanTTL    = 10 * time.Minute
)

var ErrNotFound = errors.New("bandcamp: not found")

type Client struct {
	http  *http.Client
	cache *cache
}

func New() *Client {
	return &Client{
		http: &http.Client{
			Timeout: 15 * time.Second,
			// Stream URLs are resolved, not followed — we hand the redirect to
			// the browser so audio bytes never transit this server.
			CheckRedirect: func(req *http.Request, via []*http.Request) error {
				if len(via) >= 5 {
					return errors.New("too many redirects")
				}
				return nil
			},
		},
		cache: newCache(),
	}
}

// ---------- public types ----------

type SearchResult struct {
	Type      string `json:"type"` // b=band, a=album, t=track, f=fan
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	BandID    int64  `json:"band_id,omitempty"`
	BandName  string `json:"band_name,omitempty"`
	AlbumName string `json:"album_name,omitempty"`
	URL       string `json:"url,omitempty"`
	ArtURL    string `json:"art_url,omitempty"`
	Location  string `json:"location,omitempty"`
	Username  string `json:"username,omitempty"`
}

type Track struct {
	TrackID    int64   `json:"track_id"`
	TrackNum   int     `json:"track_num"`
	Title      string  `json:"title"`
	Artist     string  `json:"artist"`
	AlbumTitle string  `json:"album_title"`
	AlbumID    *int64  `json:"album_id"`
	BandID     int64   `json:"band_id"`
	Duration   float64 `json:"duration"`
	ArtID      *int64  `json:"art_id"`
	ArtURL     string  `json:"art_url"`
	TrackURL   string  `json:"track_url"`
	Streamable bool    `json:"streamable"`
	StreamURL  string  `json:"-"` // signed + short-lived; never persisted
}

type Tralbum struct {
	ID          int64    `json:"id"`
	Type        string   `json:"type"` // "a" or "t"
	Title       string   `json:"title"`
	Artist      string   `json:"artist"`
	BandID      int64    `json:"band_id"`
	ArtID       *int64   `json:"art_id"`
	ArtURL      string   `json:"art_url"`
	URL         string   `json:"url"`
	About       string   `json:"about,omitempty"`
	ReleaseDate string   `json:"release_date,omitempty"`
	Tracks      []*Track `json:"tracks"`
}

type WishlistItem struct {
	TralbumID   int64  `json:"tralbum_id"`
	TralbumType string `json:"tralbum_type"` // "a" or "t"
	BandID      int64  `json:"band_id"`
	Title       string `json:"title"`
	BandName    string `json:"band_name"`
	ItemURL     string `json:"item_url"`
	ArtURL      string `json:"art_url"`
	TrackCount  int    `json:"track_count"`
}

type WishlistPage struct {
	Items         []*WishlistItem `json:"items"`
	LastToken     string          `json:"last_token"`
	MoreAvailable bool            `json:"more_available"`
}

type Fan struct {
	FanID     int64  `json:"fan_id"`
	Username  string `json:"username"`
	Name      string `json:"name"`
	ImageURL  string `json:"image_url"`
	WishCount int    `json:"wishlist_count"`
}

// ArtURL builds a Bandcamp CDN image URL. Format 9 is ~600px, 3 is a thumbnail.
func ArtURL(artID int64, format int) string {
	if artID == 0 {
		return ""
	}
	return fmt.Sprintf("https://f4.bcbits.com/img/a%d_%d.jpg", artID, format)
}

func bandImageURL(imgID int64, format int) string {
	if imgID == 0 {
		return ""
	}
	return fmt.Sprintf("https://f4.bcbits.com/img/%d_%d.jpg", imgID, format)
}

// ---------- search ----------

// Search queries Bandcamp's autocomplete index. filter is "" (everything), or
// one of b/a/t/f to restrict to bands, albums, tracks or fans.
func (c *Client) Search(ctx context.Context, query, filter string) ([]*SearchResult, error) {
	query = strings.TrimSpace(query)
	if query == "" {
		return []*SearchResult{}, nil
	}

	key := "search:" + filter + ":" + strings.ToLower(query)
	if v, ok := c.cache.get(key); ok {
		return v.([]*SearchResult), nil
	}

	body, _ := json.Marshal(map[string]any{
		"search_text":   query,
		"search_filter": filter,
		"full_page":     false,
		"fan_id":        nil,
	})

	var raw struct {
		Auto struct {
			Results []struct {
				Type        string  `json:"type"`
				ID          int64   `json:"id"`
				Name        string  `json:"name"`
				BandID      int64   `json:"band_id"`
				BandName    string  `json:"band_name"`
				AlbumName   string  `json:"album_name"`
				ItemURLPath string  `json:"item_url_path"`
				ItemURLRoot string  `json:"item_url_root"`
				Img         string  `json:"img"`
				ArtID       *int64  `json:"art_id"`
				ImgID       *int64  `json:"img_id"`
				Location    string  `json:"location"`
				Username    string  `json:"username"`
				IsLabel     bool    `json:"is_label"`
				Score       float64 `json:"score"`
			} `json:"results"`
		} `json:"auto"`
	}
	if err := c.postJSON(ctx, searchURL, body, &raw); err != nil {
		return nil, err
	}

	out := make([]*SearchResult, 0, len(raw.Auto.Results))
	for _, r := range raw.Auto.Results {
		sr := &SearchResult{
			Type: r.Type, ID: r.ID, Name: r.Name, BandID: r.BandID,
			BandName: r.BandName, AlbumName: r.AlbumName, Location: r.Location,
			Username: r.Username,
		}
		// Track and album results carry an art_id, and the CDN requires an "a"
		// prefix on the id for that size — which the "img" field this same
		// response hands back omits, 404ing. Band/label results have no
		// art_id, only an img_id for their photo, and that one's "img" field
		// is already correctly formed, so it is fine to use as-is.
		switch {
		case r.ArtID != nil:
			sr.ArtURL = ArtURL(*r.ArtID, 3)
		default:
			sr.ArtURL = r.Img
		}
		if sr.URL = r.ItemURLPath; sr.URL == "" {
			sr.URL = r.ItemURLRoot
		}
		// Bands are their own "band"; the UI relies on band_id being present.
		if sr.Type == "b" && sr.BandID == 0 {
			sr.BandID = r.ID
		}
		out = append(out, sr)
	}

	c.cache.set(key, out, detailTTL)
	return out, nil
}

// ---------- tralbum details ----------

var (
	pagePropsRe = regexp.MustCompile(`name="bc-page-properties"\s+content="([^"]+)"`)
	bandIDRes   = []*regexp.Regexp{
		regexp.MustCompile(`data-band-id="(\d+)"`),
		regexp.MustCompile(`"bandId":(\d+)`),
		regexp.MustCompile(`[?&]band_id=(\d+)`),
	}
)

// Resolve turns any Bandcamp album or track URL into the ids the details API
// needs. Bandcamp no longer inlines track data in the page, so we read only the
// small set of identifiers from meta tags and go to the API for everything else.
func (c *Client) Resolve(ctx context.Context, rawURL string) (itemType string, itemID, bandID int64, err error) {
	u, err := normalizeURL(rawURL)
	if err != nil {
		return "", 0, 0, err
	}

	key := "resolve:" + u
	if v, ok := c.cache.get(key); ok {
		r := v.([3]any)
		return r[0].(string), r[1].(int64), r[2].(int64), nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return "", 0, 0, err
	}
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", 0, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return "", 0, 0, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return "", 0, 0, fmt.Errorf("bandcamp: page returned %d", resp.StatusCode)
	}

	// Identifiers live in the head; no need to read the whole ~230KB page.
	body, err := io.ReadAll(io.LimitReader(resp.Body, 512*1024))
	if err != nil {
		return "", 0, 0, err
	}
	raw := string(body)

	// The attribute must be matched before unescaping: its value is JSON whose
	// own quotes are entity-encoded, and unescaping first would terminate the
	// attribute match at the first inner quote.
	m := pagePropsRe.FindStringSubmatch(raw)
	if m == nil {
		return "", 0, 0, fmt.Errorf("bandcamp: %q is not an album or track page", rawURL)
	}
	var props struct {
		ItemType string `json:"item_type"`
		ItemID   int64  `json:"item_id"`
	}
	if err := json.Unmarshal([]byte(html.UnescapeString(m[1])), &props); err != nil {
		return "", 0, 0, fmt.Errorf("bandcamp: unreadable page properties: %w", err)
	}
	if props.ItemType != "a" && props.ItemType != "t" {
		return "", 0, 0, fmt.Errorf("bandcamp: %q is a %q page, not an album or track", rawURL, props.ItemType)
	}

	// The artist id, in contrast, appears inside entity-encoded JSON and in
	// escaped query strings, so those patterns need the unescaped text.
	page := html.UnescapeString(raw)
	for _, re := range bandIDRes {
		if bm := re.FindStringSubmatch(page); bm != nil {
			bandID, _ = strconv.ParseInt(bm[1], 10, 64)
			if bandID > 0 {
				break
			}
		}
	}
	if bandID == 0 {
		return "", 0, 0, fmt.Errorf("bandcamp: could not determine artist id for %q", rawURL)
	}

	c.cache.set(key, [3]any{props.ItemType, props.ItemID, bandID}, pageTTL)
	return props.ItemType, props.ItemID, bandID, nil
}

// Details fetches full metadata for an album ("a") or single track ("t"),
// including the signed preview stream URL for each track.
func (c *Client) Details(ctx context.Context, itemType string, itemID, bandID int64) (*Tralbum, error) {
	if itemType != "a" && itemType != "t" {
		return nil, fmt.Errorf("bandcamp: invalid item type %q", itemType)
	}
	key := fmt.Sprintf("details:%s:%d:%d", itemType, itemID, bandID)
	if v, ok := c.cache.get(key); ok {
		return v.(*Tralbum), nil
	}

	q := url.Values{}
	q.Set("band_id", strconv.FormatInt(bandID, 10))
	q.Set("tralbum_id", strconv.FormatInt(itemID, 10))
	q.Set("tralbum_type", itemType)

	var raw struct {
		Error       any    `json:"error"`
		ID          int64  `json:"id"`
		Type        string `json:"type"`
		Title       string `json:"title"`
		BandcampURL string `json:"bandcamp_url"`
		ArtID       *int64 `json:"art_id"`
		About       string `json:"about"`
		ReleaseDate int64  `json:"release_date"` // unix seconds, not a string
		AlbumID     *int64 `json:"album_id"`
		AlbumTitle  string `json:"album_title"`
		TralbumArt  string `json:"tralbum_artist"`
		Band        struct {
			BandID  int64  `json:"band_id"`
			Name    string `json:"name"`
			ImageID int64  `json:"image_id"`
		} `json:"band"`
		Tracks []struct {
			TrackID      int64             `json:"track_id"`
			Title        string            `json:"title"`
			TrackNum     int               `json:"track_num"`
			Duration     float64           `json:"duration"`
			BandName     string            `json:"band_name"`
			AlbumTitle   string            `json:"album_title"`
			AlbumID      *int64            `json:"album_id"`
			ArtID        *int64            `json:"art_id"`
			BandID       int64             `json:"band_id"`
			IsStreamable bool              `json:"is_streamable"`
			TrackURL     string            `json:"track_url"`
			StreamingURL map[string]string `json:"streaming_url"`
		} `json:"tracks"`
	}
	if err := c.getJSON(ctx, detailsURL+"?"+q.Encode(), &raw); err != nil {
		return nil, err
	}
	if raw.Error != nil {
		return nil, ErrNotFound
	}

	artist := raw.TralbumArt
	if artist == "" {
		artist = raw.Band.Name
	}

	t := &Tralbum{
		ID: raw.ID, Type: raw.Type, Title: raw.Title, Artist: artist,
		BandID: raw.Band.BandID, ArtID: raw.ArtID, URL: raw.BandcampURL,
		About: raw.About,
	}
	if raw.ReleaseDate > 0 {
		t.ReleaseDate = time.Unix(raw.ReleaseDate, 0).UTC().Format("2006-01-02")
	}
	if t.BandID == 0 {
		t.BandID = bandID
	}
	if raw.ArtID != nil {
		t.ArtURL = ArtURL(*raw.ArtID, 9)
	}

	for _, rt := range raw.Tracks {
		tr := &Track{
			TrackID: rt.TrackID, TrackNum: rt.TrackNum, Title: rt.Title,
			Duration: rt.Duration, AlbumID: rt.AlbumID, BandID: rt.BandID,
			ArtID: rt.ArtID, TrackURL: rt.TrackURL, Streamable: rt.IsStreamable,
		}
		if tr.Artist = rt.BandName; tr.Artist == "" {
			tr.Artist = artist
		}
		if tr.AlbumTitle = rt.AlbumTitle; tr.AlbumTitle == "" && itemType == "a" {
			tr.AlbumTitle = raw.Title
		}
		if tr.BandID == 0 {
			tr.BandID = t.BandID
		}
		// Tracks on an album inherit the album's cover and id.
		if tr.AlbumID == nil && itemType == "a" {
			id := raw.ID
			tr.AlbumID = &id
		}
		if tr.ArtID == nil {
			tr.ArtID = raw.ArtID
		}
		// A tralbum_type=t response leaves the nested track_url null and puts the
		// real page URL at the top level, so single-track adds would otherwise be
		// saved with no link back to Bandcamp. For an album this degrades to the
		// album page, which is still a useful destination.
		if tr.TrackURL == "" {
			tr.TrackURL = t.URL
		}
		if tr.ArtID != nil {
			tr.ArtURL = ArtURL(*tr.ArtID, 9)
		}
		tr.StreamURL = rt.StreamingURL["mp3-128"]
		t.Tracks = append(t.Tracks, tr)
	}

	c.cache.set(key, t, detailTTL)
	return t, nil
}

// StreamURL returns a freshly signed preview URL for one track. Bandcamp signs
// these with an expiring timestamp, which is exactly why playlists store track
// ids rather than URLs.
func (c *Client) StreamURL(ctx context.Context, trackID, bandID int64) (string, error) {
	t, err := c.Details(ctx, "t", trackID, bandID)
	if err != nil {
		return "", err
	}
	for _, tr := range t.Tracks {
		if tr.StreamURL != "" && (tr.TrackID == trackID || len(t.Tracks) == 1) {
			return tr.StreamURL, nil
		}
	}
	return "", ErrNotFound
}

// ---------- fans and wishlists ----------

var pagedataRe = regexp.MustCompile(`id="pagedata"[^>]*data-blob="([^"]*)"`)

// Fan resolves a Bandcamp username, profile URL, or numeric fan id to the fan's
// identity plus their wishlist size.
func (c *Client) Fan(ctx context.Context, input string) (*Fan, error) {
	name := strings.TrimSpace(input)
	if name == "" {
		return nil, ErrNotFound
	}

	// Accept a full profile URL as well as a bare username. Take the first path
	// segment so trailing paths and query strings do not break the lookup.
	if strings.Contains(name, "bandcamp.com") {
		if u, err := url.Parse(ensureScheme(name)); err == nil {
			for _, seg := range strings.Split(u.Path, "/") {
				if seg != "" {
					name = seg
					break
				}
			}
		}
	}
	name = strings.Trim(name, "/@ ")

	key := "fan:" + strings.ToLower(name)
	if v, ok := c.cache.get(key); ok {
		return v.(*Fan), nil
	}

	fan, err := c.fanByUsername(ctx, name)
	if err == nil {
		c.cache.set(key, fan, fanTTL)
		return fan, nil
	}

	// The profile path only works for the exact URL slug. People typically know
	// their display name instead, so fall back to Bandcamp's fan search and
	// resolve that to a real profile.
	if fan, ferr := c.fanBySearch(ctx, name); ferr == nil {
		c.cache.set(key, fan, fanTTL)
		return fan, nil
	}
	return nil, err
}

// fanByUsername reads a fan's identity straight off their profile page.
func (c *Client) fanByUsername(ctx context.Context, name string) (*Fan, error) {
	if name == "" {
		return nil, ErrNotFound
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://bandcamp.com/"+url.PathEscape(name), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", userAgent)

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusNotFound {
		return nil, ErrNotFound
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("bandcamp: fan page returned %d", resp.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024))
	if err != nil {
		return nil, err
	}
	m := pagedataRe.FindSubmatch(body)
	if m == nil {
		return nil, ErrNotFound
	}

	var blob struct {
		FanData struct {
			FanID    int64  `json:"fan_id"`
			Username string `json:"username"`
			Name     string `json:"name"`
			Photo    *int64 `json:"photo"`
		} `json:"fan_data"`
		WishlistData struct {
			ItemCount int `json:"item_count"`
		} `json:"wishlist_data"`
	}
	if err := json.Unmarshal([]byte(html.UnescapeString(string(m[1]))), &blob); err != nil {
		return nil, fmt.Errorf("bandcamp: unreadable fan page: %w", err)
	}
	if blob.FanData.FanID == 0 {
		return nil, ErrNotFound
	}

	f := &Fan{
		FanID:     blob.FanData.FanID,
		Username:  blob.FanData.Username,
		Name:      blob.FanData.Name,
		WishCount: blob.WishlistData.ItemCount,
	}
	if blob.FanData.Photo != nil {
		f.ImageURL = bandImageURL(*blob.FanData.Photo, 22)
	}
	if f.Username == "" {
		f.Username = name
	}
	return f, nil
}

// fanBySearch resolves a display name (or any near-miss the user typed) to a
// real fan profile using Bandcamp's fan search index.
func (c *Client) fanBySearch(ctx context.Context, query string) (*Fan, error) {
	results, err := c.Search(ctx, query, "f")
	if err != nil {
		return nil, err
	}

	want := strings.ToLower(strings.TrimSpace(query))
	var best *SearchResult

	// Prefer an exact match on username, then on display name, then whatever
	// the index ranked first.
	for _, r := range results {
		if r.Type != "f" {
			continue
		}
		if strings.ToLower(r.Username) == want {
			best = r
			break
		}
		if best == nil || strings.ToLower(r.Name) == want {
			if best == nil || strings.ToLower(best.Username) != want {
				best = r
			}
		}
	}
	if best == nil {
		return nil, ErrNotFound
	}

	// Re-read the profile so the wishlist count is accurate.
	if best.Username != "" {
		if f, err := c.fanByUsername(ctx, best.Username); err == nil {
			return f, nil
		}
	}
	return &Fan{FanID: best.ID, Username: best.Username, Name: best.Name, ImageURL: best.ArtURL}, nil
}

// Wishlist pages through a fan's wishlist. Pass an empty token for the first
// page, then feed back the returned LastToken.
func (c *Client) Wishlist(ctx context.Context, fanID int64, token string, count int) (*WishlistPage, error) {
	if count <= 0 || count > 100 {
		count = 40
	}
	if token == "" {
		// Sentinel meaning "from the most recent item".
		token = fmt.Sprintf("%d::a::", time.Now().Unix()+86400)
	}

	body, _ := json.Marshal(map[string]any{
		"fan_id":           fanID,
		"older_than_token": token,
		"count":            count,
	})

	var raw struct {
		Items []struct {
			TralbumID   int64  `json:"tralbum_id"`
			BandID      int64  `json:"band_id"`
			ItemTitle   string `json:"item_title"`
			ItemURL     string `json:"item_url"`
			ItemArtURL  string `json:"item_art_url"`
			BandName    string `json:"band_name"`
			NumStream   int    `json:"num_streamable_tracks"`
			TralbumType string `json:"tralbum_type"`
			URLHints    struct {
				ItemType string `json:"item_type"`
			} `json:"url_hints"`
		} `json:"items"`
		MoreAvailable bool   `json:"more_available"`
		LastToken     string `json:"last_token"`
	}
	if err := c.postJSON(ctx, wishlistURL, body, &raw); err != nil {
		return nil, err
	}

	page := &WishlistPage{
		Items:         make([]*WishlistItem, 0, len(raw.Items)),
		LastToken:     raw.LastToken,
		MoreAvailable: raw.MoreAvailable,
	}
	for _, it := range raw.Items {
		typ := it.TralbumType
		if typ == "" {
			typ = it.URLHints.ItemType
		}
		if typ == "" {
			typ = "a"
		}
		page.Items = append(page.Items, &WishlistItem{
			TralbumID: it.TralbumID, TralbumType: typ, BandID: it.BandID,
			Title: it.ItemTitle, BandName: it.BandName, ItemURL: it.ItemURL,
			ArtURL: it.ItemArtURL, TrackCount: it.NumStream,
		})
	}
	return page, nil
}

// ---------- transport helpers ----------

func (c *Client) postJSON(ctx context.Context, endpoint string, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", userAgent)
	return c.do(req, out)
}

func (c *Client) getJSON(ctx context.Context, endpoint string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", userAgent)
	return c.do(req, out)
}

func (c *Client) do(req *http.Request, out any) error {
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bandcamp: %s returned %d", req.URL.Path, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if err != nil {
		return err
	}
	return json.Unmarshal(body, out)
}

func ensureScheme(s string) string {
	if !strings.HasPrefix(s, "http://") && !strings.HasPrefix(s, "https://") {
		return "https://" + s
	}
	return s
}

// normalizeURL rejects anything that is not a bandcamp.com address. Without
// this the resolve endpoint would be a server-side request forgery primitive.
func normalizeURL(raw string) (string, error) {
	u, err := url.Parse(ensureScheme(strings.TrimSpace(raw)))
	if err != nil {
		return "", fmt.Errorf("bandcamp: invalid url")
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", fmt.Errorf("bandcamp: unsupported url scheme")
	}
	host := strings.ToLower(u.Hostname())
	if host != "bandcamp.com" && !strings.HasSuffix(host, ".bandcamp.com") {
		return "", fmt.Errorf("bandcamp: %q is not a bandcamp.com url", host)
	}
	u.Scheme = "https"
	u.RawQuery = ""
	u.Fragment = ""
	return u.String(), nil
}

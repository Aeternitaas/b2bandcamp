package youtube

import (
	"net/url"
	"strings"
)

// Kinds of thing this provider can expand.
const (
	KindVideo    = "v"
	KindPlaylist = "p"
)

// parseURL pulls the video or playlist id out of a YouTube link. It is pure:
// no network, no API key, which is what lets Match be cheap enough for the
// registry to call it on every pasted link.
//
// Recognised: youtube.com/watch?v=, youtu.be/, /shorts/, /embed/, /live/,
// music.youtube.com, and /playlist?list=.
func parseURL(raw string) (kind, id string, ok bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", false
	}
	if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", false
	}

	host := strings.ToLower(u.Hostname())
	host = strings.TrimPrefix(host, "www.")

	switch host {
	case "youtu.be":
		// The short form puts the id in the path: youtu.be/dQw4w9WgXcQ
		if id := firstSegment(u.Path); validVideoID(id) {
			return KindVideo, id, true
		}
		return "", "", false

	case "youtube.com", "m.youtube.com", "music.youtube.com", "youtube-nocookie.com":
		q := u.Query()

		// A watch URL carrying a list= is a video seen in the context of a
		// playlist. Whoever pasted it meant the video, so the video wins; only
		// /playlist?list= means the whole playlist.
		if v := q.Get("v"); validVideoID(v) {
			return KindVideo, v, true
		}

		seg, rest := splitPath(u.Path)
		switch seg {
		case "shorts", "embed", "live", "v":
			if validVideoID(rest) {
				return KindVideo, rest, true
			}
		case "playlist":
			if l := q.Get("list"); validPlaylistID(l) {
				return KindPlaylist, l, true
			}
		}
		return "", "", false
	}
	return "", "", false
}

func firstSegment(p string) string {
	seg, _ := splitPath(p)
	return seg
}

// splitPath returns the first path segment and the one after it.
func splitPath(p string) (first, second string) {
	parts := strings.Split(strings.Trim(p, "/"), "/")
	if len(parts) > 0 {
		first = parts[0]
	}
	if len(parts) > 1 {
		second = parts[1]
	}
	return first, second
}

// validVideoID accepts YouTube's 11-character base64url id and nothing else, so
// a stray path segment cannot be pushed into an API call as an id.
func validVideoID(s string) bool {
	if len(s) != 11 {
		return false
	}
	return isBase64URL(s)
}

// validPlaylistID is looser: YouTube has issued several prefixes (PL, UU, LL,
// FL, RD, OLAK) and different lengths over the years, so this checks the
// alphabet and a sane length rather than guessing at the format.
func validPlaylistID(s string) bool {
	if len(s) < 2 || len(s) > 64 {
		return false
	}
	return isBase64URL(s)
}

func isBase64URL(s string) bool {
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '-', r == '_':
		default:
			return false
		}
	}
	return true
}

// watchURL is the canonical page for a video, used as the row's link back to
// the source and as the oEmbed lookup key.
func watchURL(videoID string) string {
	return "https://www.youtube.com/watch?v=" + videoID
}

// playlistURL is the canonical page for a playlist.
func playlistURL(playlistID string) string {
	return "https://www.youtube.com/playlist?list=" + playlistID
}

// channelURL is the canonical page for a channel.
func channelURL(channelID string) string {
	return "https://www.youtube.com/channel/" + channelID
}

// uploadsPlaylistID is the playlist holding everything a channel has posted.
// YouTube derives it from the channel id by swapping the leading "UC" for "UU",
// and has done so for every channel since ids were introduced, which is why
// this needs no API call.
func uploadsPlaylistID(channelID string) string {
	if !strings.HasPrefix(channelID, "UC") {
		return ""
	}
	return "UU" + strings.TrimPrefix(channelID, "UC")
}

// validChannelID accepts the "UC" + 22 characters form every current channel
// id takes, so a stray path segment cannot be pushed into an API call.
func validChannelID(s string) bool {
	return len(s) == 24 && strings.HasPrefix(s, "UC") && isBase64URL(s)
}

// parseChannelURL recognises the four shapes a channel link takes and reports
// which channels.list selector matches it. The handle and legacy forms cannot
// be turned into an id without asking YouTube, so they are returned as the
// selector that will do the asking.
//
// Recognised: /channel/UC..., /@handle, /c/Name, /user/Name.
func parseChannelURL(raw string) (param, value string, ok bool) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", "", false
	}
	if !strings.HasPrefix(raw, "http://") && !strings.HasPrefix(raw, "https://") {
		// A bare "@handle" is not a URL and is handled by the caller; anything
		// else without a scheme is only a link if it names a YouTube host.
		if !strings.Contains(raw, "youtube.com/") {
			return "", "", false
		}
		raw = "https://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return "", "", false
	}

	host := strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	switch host {
	case "youtube.com", "m.youtube.com", "music.youtube.com":
	default:
		return "", "", false
	}

	first, second := splitPath(u.Path)
	switch {
	case first == "channel" && validChannelID(second):
		return "id", second, true
	case strings.HasPrefix(first, "@") && len(first) > 1:
		return "forHandle", first, true
	case (first == "c" || first == "user") && second != "":
		// Both of these are display names rather than ids. forUsername only
		// resolves the older /user/ form, and it is the only selector that can
		// resolve any of it, so it is worth one try before the search fallback.
		return "forUsername", second, true
	}
	return "", "", false
}

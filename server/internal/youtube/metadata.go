package youtube

import (
	"regexp"
	"strings"
)

// YouTube gives a video title and a channel name. Neither one is the artist and
// track that a DJ needs to export. This file turns the pair into the two fields
// a playlist row wants.
//
// Three shapes cover almost everything YouTube returns:
//
//	channel "MUADEEP - Topic", title "Rainfall"
//	    An auto-generated art track. The channel names the artist exactly, and
//	    the title is exactly the track.
//	channel "Rick Astley", title "Rick Astley - Never Gonna Give You Up (Official Video)"
//	    A normal upload. The title carries "artist - track", and the promotional
//	    suffix is noise.
//	channel "Alan Walker", title "Faded"
//	    An upload with no separator. The channel is the best artist available.

// artistAndTitle derives the artist and the track title for one video.
func artistAndTitle(videoTitle, channelTitle string) (artist, title string) {
	videoTitle = collapse(videoTitle)
	channelTitle = collapse(channelTitle)

	// An art track channel is authoritative, so trust it and do not split the
	// title. Splitting would be wrong for a track whose own name holds a dash,
	// for example "Blue Monday - 2016 Remaster".
	if base, ok := topicArtist(channelTitle); ok {
		return base, stripPromo(videoTitle)
	}

	if a, t, ok := splitArtistTitle(videoTitle); ok {
		return a, stripPromo(t)
	}

	return cleanChannel(channelTitle), stripPromo(videoTitle)
}

// topicArtist recognises the auto-generated "<artist> - Topic" channel that
// YouTube creates for a label's catalogue, and returns the artist alone.
// YouTube Music displays these channels without the suffix, and so do we.
func topicArtist(channel string) (string, bool) {
	const suffix = " - Topic"
	if len(channel) > len(suffix) && strings.EqualFold(channel[len(channel)-len(suffix):], suffix) {
		return strings.TrimSpace(channel[:len(channel)-len(suffix)]), true
	}
	return "", false
}

// dashSplit matches the separator between artist and track. YouTube titles use
// a hyphen, an en dash or an em dash, and the spaces around it are what make it
// a separator rather than part of a word, as in "Jay-Z" or "Sixty-Eight".
var dashSplit = regexp.MustCompile(`\s+[-\x{2013}\x{2014}]\s+`)

// splitArtistTitle reads the "artist - track" convention that most YouTube
// uploads follow. It splits on the first separator only, so "Artist - Song -
// Remix" keeps "Song - Remix" as the track.
func splitArtistTitle(videoTitle string) (artist, title string, ok bool) {
	loc := dashSplit.FindStringIndex(videoTitle)
	if loc == nil {
		return "", "", false
	}
	artist = strings.TrimSpace(videoTitle[:loc[0]])
	title = strings.TrimSpace(videoTitle[loc[1]:])
	if artist == "" || title == "" {
		return "", "", false
	}
	// A very long left side is a sentence, not an artist name. Uploads titled
	// "Some long thought - and another" would otherwise produce nonsense.
	if len([]rune(artist)) > 80 {
		return "", "", false
	}
	return artist, title, true
}

// vevoSuffix matches the channel naming that distributors use, as in
// "LuisFonsiVEVO".
var vevoSuffix = regexp.MustCompile(`(?i)vevo$`)

// cleanChannel removes the decoration that channel names carry when the channel
// itself has to stand in as the artist.
func cleanChannel(channel string) string {
	channel = vevoSuffix.ReplaceAllString(channel, "")
	channel = strings.TrimSpace(channel)

	// "Queen Official" is the band, not a band called Official.
	for _, suffix := range []string{" Official", " official", " OFFICIAL", " - Official", " Music", " TV"} {
		if strings.HasSuffix(channel, suffix) && len(channel) > len(suffix) {
			channel = strings.TrimSpace(channel[:len(channel)-len(suffix)])
			break
		}
	}
	return collapse(channel)
}

// promoGroup matches a bracketed or parenthesised group anywhere in a title.
var promoGroup = regexp.MustCompile(`\s*[\(\[]([^\(\)\[\]]*)[\)\]]`)

// trailingBar matches a promotional tail introduced by a vertical bar, as in
// "Song | Official Video".
var trailingBar = regexp.MustCompile(`\s*\|\s*([^|]*)$`)

// yearOnly strips a leading or trailing four-digit year, so that "Remastered
// 2011" and "2011 Remaster" both reduce to a promotional word.
var yearOnly = regexp.MustCompile(`(?i)^(?:\d{4}\s+)?(.*?)(?:\s+\d{4})?$`)

// keepWords name something a DJ needs. A group that holds any of them stays,
// whatever else it says. This is the safety net: when in doubt, keep the text.
// Losing "(Extended Mix)" from a track title is far worse than keeping an
// occasional "(Official Live Video)".
var keepWords = []string{
	"mix", "remix", "edit", "version", "feat", "ft.", "ft ", "with ",
	"bootleg", "dub", "vip", "instrumental", "acapella", "a cappella",
	"live", "acoustic", "cover", "extended", "radio", "club", "original",
	"demo", "reprise", "interlude", "intro", "outro", "session", "rework",
	"flip", "refix", "remake", "mashup", "bpm", "key", "sped", "slowed",
}

// promoPhrases are the exact contents this code will remove, once lowercased
// and stripped of a year. Anything not on this list stays.
var promoPhrases = map[string]bool{
	"official": true, "official video": true, "official music video": true,
	"official audio": true, "official lyric video": true,
	"official lyrics video": true, "official visualizer": true,
	"official visualiser": true, "official hd video": true,
	"official video remastered": true, "official music video remastered": true,
	"music video": true, "lyric video": true, "lyrics video": true,
	"lyrics": true, "lyric": true, "audio": true, "video": true,
	"visualizer": true, "visualiser": true, "m/v": true, "mv": true,
	"hd": true, "hq": true, "4k": true, "8k": true, "full hd": true,
	"1080p": true, "720p": true, "high quality": true,
	"remaster": true, "remastered": true, "hd remaster": true,
	"4k remaster": true, "hd remastered": true, "4k remastered": true,
	"video remaster": true, "video remastered": true,
	"free download": true, "out now": true,
}

// isPromo reports whether a group holds only promotional decoration.
func isPromo(content string) bool {
	c := strings.ToLower(collapse(content))
	if c == "" {
		return false
	}
	for _, w := range keepWords {
		if strings.Contains(c, w) {
			return false
		}
	}
	if promoPhrases[c] {
		return true
	}
	// Retry without a leading or trailing year, which catches "Remastered
	// 2011" and "2009 Remaster".
	if m := yearOnly.FindStringSubmatch(c); m != nil && m[1] != c {
		return promoPhrases[strings.TrimSpace(m[1])]
	}
	return false
}

// stripPromo removes promotional decoration from a track title and leaves
// everything else alone.
func stripPromo(title string) string {
	out := promoGroup.ReplaceAllStringFunc(title, func(group string) string {
		m := promoGroup.FindStringSubmatch(group)
		if m != nil && isPromo(m[1]) {
			return ""
		}
		return group
	})

	if m := trailingBar.FindStringSubmatch(out); m != nil && isPromo(m[1]) {
		out = trailingBar.ReplaceAllString(out, "")
	}

	// A bare trailing "M/V" is the same decoration without brackets.
	for _, tail := range []string{" M/V", " MV", " m/v"} {
		if strings.HasSuffix(out, tail) {
			out = out[:len(out)-len(tail)]
			break
		}
	}

	out = collapse(out)
	// Removing a group can leave a dangling separator, as in "Song - ".
	out = strings.TrimRight(out, " -–—,")
	out = collapse(out)
	if out == "" {
		return collapse(title) // never return nothing
	}
	return out
}

// collapse trims the ends and reduces every run of whitespace to one space.
func collapse(s string) string { return strings.Join(strings.Fields(s), " ") }

package youtube

import "testing"

// The cases below that carry a video id came from a live oEmbed response, so
// they record what YouTube actually returns rather than what it ought to.
func TestArtistAndTitle(t *testing.T) {
	cases := []struct {
		name       string
		videoTitle string
		channel    string
		wantArtist string
		wantTitle  string
	}{
		// The case that prompted this: an auto-generated art track. YouTube
		// Music shows "MUADEEP", and so must we.
		{"topic channel", "Rainfall", "MUADEEP - Topic", "MUADEEP", "Rainfall"},
		{"topic channel keeps a dash in the track",
			"Blue Monday - 2016 Remaster", "New Order - Topic",
			"New Order", "Blue Monday - 2016 Remaster"},
		{"topic channel with a dash in the artist",
			"Sequence 3", "Jean-Michel Jarre - Topic", "Jean-Michel Jarre", "Sequence 3"},

		// dQw4w9WgXcQ, live response.
		{"artist in title plus two promo groups",
			"Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)",
			"Rick Astley", "Rick Astley", "Never Gonna Give You Up"},
		// JGwWNGJdvx8, live response.
		{"official music video",
			"Ed Sheeran - Shape of You (Official Music Video)", "Ed Sheeran",
			"Ed Sheeran", "Shape of You"},
		// fJ9rUzIMcZQ, live response. Note the en dash separator.
		{"en dash separator",
			"Queen – Bohemian Rhapsody (Official Video Remastered)", "Queen Official",
			"Queen", "Bohemian Rhapsody"},
		// kJQP7kiw5Fk, live response.
		{"featured artist stays in the title",
			"Luis Fonsi - Despacito ft. Daddy Yankee", "LuisFonsiVEVO",
			"Luis Fonsi", "Despacito ft. Daddy Yankee"},
		// 9bZkp7q19f0, live response. The Korean title is the real title.
		{"non-latin title survives, bare M/V does not",
			"PSY - GANGNAM STYLE(강남스타일) M/V", "officialpsy",
			"PSY", "GANGNAM STYLE(강남스타일)"},
		// 60ItHLz5WEA, live response.
		{"no separator falls back to the channel",
			"Faded", "Alan Walker", "Alan Walker", "Faded"},

		// The reason stripping is conservative: a DJ needs these.
		{"extended mix survives",
			"Artist - Track (Extended Mix)", "Artist", "Artist", "Track (Extended Mix)"},
		{"radio edit survives",
			"Artist - Track (Radio Edit) (Official Video)", "Artist",
			"Artist", "Track (Radio Edit)"},
		{"remix credit survives",
			"Artist - Track (Someone Remix) [Official Audio]", "Artist",
			"Artist", "Track (Someone Remix)"},
		{"live survives",
			"Artist - Track (Live at Wembley)", "Artist", "Artist", "Track (Live at Wembley)"},
		{"original mix survives",
			"Artist - Track (Original Mix)", "Artist", "Artist", "Track (Original Mix)"},

		// Promotional decoration that should go.
		{"bracketed lyrics", "Artist - Track [Lyrics]", "Artist", "Artist", "Track"},
		{"trailing bar", "Artist - Track | Official Video", "Artist", "Artist", "Track"},
		{"remastered with a year",
			"Artist - Track (Remastered 2011)", "Artist", "Artist", "Track"},
		{"year then remaster",
			"Artist - Track (2009 Remaster)", "Artist", "Artist", "Track"},
		{"visualizer", "Artist - Track (Official Visualizer)", "Artist", "Artist", "Track"},

		// A hyphenated name is not a separator, because it has no spaces.
		{"hyphenated artist name", "Jay-Z", "Some Channel", "Some Channel", "Jay-Z"},
		{"hyphenated name with a real separator",
			"Jay-Z - Song Name", "Some Channel", "Jay-Z", "Song Name"},

		// Degenerate input must not produce an empty field.
		{"promo only title", "(Official Video)", "Some Channel", "Some Channel", "(Official Video)"},
		{"empty channel", "Artist - Track", "", "Artist", "Track"},
		{"whitespace collapses", "  Artist   -   Track  ", " Channel ", "Artist", "Track"},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			artist, title := artistAndTitle(c.videoTitle, c.channel)
			if artist != c.wantArtist {
				t.Errorf("artist = %q, want %q", artist, c.wantArtist)
			}
			if title != c.wantTitle {
				t.Errorf("title = %q, want %q", title, c.wantTitle)
			}
		})
	}
}

func TestTopicArtist(t *testing.T) {
	for in, want := range map[string]string{
		"MUADEEP - Topic":           "MUADEEP",
		"Jean-Michel Jarre - Topic": "Jean-Michel Jarre",
		"Boards of Canada - Topic":  "Boards of Canada",
	} {
		got, ok := topicArtist(in)
		if !ok || got != want {
			t.Errorf("topicArtist(%q) = (%q, %v), want (%q, true)", in, got, ok, want)
		}
	}

	// A channel that merely mentions the word is not an art track channel.
	for _, in := range []string{"Topic", "Topical Records", "Artist Topic", ""} {
		if _, ok := topicArtist(in); ok {
			t.Errorf("topicArtist(%q) claimed an art track channel", in)
		}
	}
}

func TestIsPromoKeepsMusicalDetail(t *testing.T) {
	// These must never be stripped: each one changes which record a DJ cues.
	keep := []string{
		"Extended Mix", "Radio Edit", "Original Mix", "Club Mix", "VIP Mix",
		"Someone Remix", "feat. Another", "ft. Another", "Live", "Acoustic",
		"Instrumental", "Acapella", "Bootleg", "Dub Mix", "Live Session",
		"Slowed + Reverb", "128 BPM", "Extended Version",
	}
	for _, s := range keep {
		if isPromo(s) {
			t.Errorf("isPromo(%q) = true, this would delete something a DJ needs", s)
		}
	}

	drop := []string{
		"Official Video", "Official Music Video", "Official Audio", "Lyrics",
		"Lyric Video", "Audio", "HD", "4K", "4K Remaster", "Remastered 2011",
		"2009 Remaster", "Official Visualizer", "M/V", "Music Video",
	}
	for _, s := range drop {
		if !isPromo(s) {
			t.Errorf("isPromo(%q) = false, this is promotional noise", s)
		}
	}
}

func TestCleanChannel(t *testing.T) {
	for in, want := range map[string]string{
		"LuisFonsiVEVO":  "LuisFonsi",
		"KatyPerryVEVO":  "KatyPerry",
		"Queen Official": "Queen",
		"Alan Walker":    "Alan Walker",
		"officialpsy":    "officialpsy", // leading "official" is part of the name
	} {
		if got := cleanChannel(in); got != want {
			t.Errorf("cleanChannel(%q) = %q, want %q", in, got, want)
		}
	}
}

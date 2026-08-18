package store

import "time"

type User struct {
	ID        int64     `json:"id"`
	Username  string    `json:"username"`
	Email     string    `json:"email,omitempty"`
	CreatedAt time.Time `json:"created_at"`

	// Optional link to a Bandcamp profile, and the avatar shown beside tracks
	// this user added.
	BandcampUsername string `json:"bandcamp_username,omitempty"`
	BandcampFanID    *int64 `json:"bandcamp_fan_id,omitempty"`
	AvatarURL        string `json:"avatar_url,omitempty"`
}

// Visibility controls who may edit a playlist.
//
//	private — owner only; the share link is inert.
//	shared  — owner plus users who have opened the share link while signed in.
//	public  — anyone holding the share link, signed in or not.
type Visibility string

const (
	VisibilityPrivate Visibility = "private"
	VisibilityShared  Visibility = "shared"
	VisibilityPublic  Visibility = "public"
)

func (v Visibility) Valid() bool {
	switch v {
	case VisibilityPrivate, VisibilityShared, VisibilityPublic:
		return true
	}
	return false
}

type Playlist struct {
	ID              int64      `json:"id"`
	OwnerID         int64      `json:"owner_id"`
	OwnerName       string     `json:"owner_name"`
	Title           string     `json:"title"`
	Description     string     `json:"description"`
	CoverURL        string     `json:"cover_url"`
	// Art of the first track that has any, so list views can show a cover
	// without loading the whole tracklist. cover_url overrides it.
	CoverArtID *int64 `json:"cover_art_id"`
	Visibility      Visibility `json:"visibility"`
	HasShareLink    bool       `json:"has_share_link"`
	SortIndex       int        `json:"sort_index"`
	TrackCount      int        `json:"track_count"`
	DurationSeconds float64    `json:"duration_seconds"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`

	// Populated per-request for the caller, not stored.
	Role string `json:"role"`
}

type Track struct {
	ID         int64     `json:"id"`
	PlaylistID int64     `json:"playlist_id"`
	Position   int       `json:"position"`
	TrackID    int64     `json:"bc_track_id"`
	AlbumID    *int64    `json:"bc_album_id"`
	BandID     *int64    `json:"bc_band_id"`
	Title      string    `json:"title"`
	Artist     string    `json:"artist"`
	AlbumTitle string    `json:"album_title"`
	Duration   float64   `json:"duration"`
	// BPM is the user's override for this playlist row, or null to use whatever
	// analysis found. Keeping the two apart means re-analysing a track never
	// discards a correction somebody made by hand.
	BPM        *float64  `json:"bpm"`
	// Camelot code entered by hand, or empty to use what analysis found.
	KeyOverride string   `json:"key_override"`
	ArtID      *int64    `json:"art_id"`
	TrackURL   string    `json:"track_url"`
	AddedBy    *int64    `json:"added_by"`
	AddedAt    time.Time `json:"added_at"`

	// Denormalised for display: who added this track, and their avatar.
	AddedByName   string `json:"added_by_name"`
	AddedByAvatar string `json:"added_by_avatar"`

	// Joined from the shared analysis cache, keyed on the Bandcamp track id, so
	// a track analysed anywhere shows its tempo and key everywhere.
	DetectedBPM *float64 `json:"detected_bpm"`
	KeyCamelot  string   `json:"key_camelot"`
	KeyName     string   `json:"key_name"`
}

// TrackAnalysis is the cached result of analysing one Bandcamp track. Peaks are
// stored as one byte per bucket — the waveform is drawn a few pixels tall, so
// 8 bits of amplitude is plenty and keeps a row well under a kilobyte.
type TrackAnalysis struct {
	TrackID         int64     `json:"bc_track_id"`
	AnalyzerVersion int       `json:"analyzer_version"`
	BPM             *float64  `json:"bpm"`
	BPMConfidence   *float64  `json:"bpm_confidence"`
	KeyName         string    `json:"key_name,omitempty"`
	KeyCamelot      string    `json:"key_camelot,omitempty"`
	KeyTonic        *int      `json:"key_tonic,omitempty"`
	KeyScale        string    `json:"key_scale,omitempty"`
	KeyConfidence   *float64  `json:"key_confidence,omitempty"`
	Peaks           []byte    `json:"-"`
	PeaksB64        string    `json:"peaks,omitempty"`
	AnalyzedAt      time.Time `json:"analyzed_at"`
}

// ShareLink is one of an owner's live invite links, paired with the playlist it
// opens. The raw token is included, so this is only ever assembled for the
// owner of the playlists in question.
type ShareLink struct {
	PlaylistID   int64      `json:"playlist_id"`
	Title        string     `json:"title"`
	Visibility   Visibility `json:"visibility"`
	Token        string     `json:"token"`
	CoverURL     string     `json:"cover_url"`
	CoverArtID   *int64     `json:"cover_art_id"`
	TrackCount   int        `json:"track_count"`
	Collaborators int       `json:"collaborators"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

type Collaborator struct {
	UserID    int64     `json:"user_id"`
	Username  string    `json:"username"`
	AvatarURL string    `json:"avatar_url"`
	AddedAt   time.Time `json:"added_at"`
}

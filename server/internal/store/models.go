package store

import "time"

type User struct {
	ID        int64     `json:"id"`
	Username  string    `json:"username"`
	Email     string    `json:"email,omitempty"`
	CreatedAt time.Time `json:"created_at"`
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
	Visibility      Visibility `json:"visibility"`
	HasShareLink    bool       `json:"has_share_link"`
	BaseFanID       *int64     `json:"base_fan_id"`
	BaseFanUsername string     `json:"base_fan_username"`
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
	ArtID      *int64    `json:"art_id"`
	TrackURL   string    `json:"track_url"`
	AddedBy    *int64    `json:"added_by"`
	AddedAt    time.Time `json:"added_at"`
}

type Collaborator struct {
	UserID   int64     `json:"user_id"`
	Username string    `json:"username"`
	AddedAt  time.Time `json:"added_at"`
}

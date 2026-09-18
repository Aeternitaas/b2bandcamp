package youtube

import (
	"bytes"
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/aeternitaas/b2bandcamp/server/internal/source"
)

// This file is what makes YouTube streamable and analysable, and it is the one
// part of this integration that depends on something outside the binary.
//
// YouTube serves a page, not an audio file. Getting a playable url out of it
// means running an extractor, and yt-dlp is the one that keeps working. The
// dependency is therefore optional and checked once at startup: with no
// extractor on PATH the provider reports Stream and Analyze false, adding
// videos by link still works, and the client shows a link out instead of a play
// button. Nothing 500s because an operator did not install a binary.
//
// Note for whoever reads this next: relaying YouTube's audio is not something
// YouTube's terms permit. This exists because the person running the instance
// asked for it on their own server. It is not on by default anywhere it is not
// installed.

const (
	// extractTimeout bounds one extractor run. The work is a handful of HTTPS
	// round trips plus signature decoding, so anything past this is a hang.
	extractTimeout = 30 * time.Second

	// streamTTL is how long a resolved url is reused. YouTube signs these for
	// several hours, and two is comfortably inside that while still saving the
	// extractor run on a replay, a seek, or the analysis pass that follows a
	// play.
	streamTTL = 2 * time.Hour

	// audioFormat prefers m4a over the also-common opus-in-webm, because every
	// browser decodes m4a and Safari does not decode opus. The trailing
	// fallbacks are for the rare video that offers no audio-only stream.
	audioFormat = "bestaudio[ext=m4a]/bestaudio/best"
)

// Option adjusts a Provider at construction. It exists so the extractor's
// location can be configured without every caller, including the tests, having
// to name one.
type Option func(*Provider)

// WithExtractor points the provider at a specific yt-dlp binary. An empty path
// means "look on PATH", which is what a container install gives.
func WithExtractor(path string) Option {
	return func(p *Provider) { p.ytdlp = strings.TrimSpace(path) }
}

// CanStream reports whether this server can hand YouTube audio to a browser,
// which is the same question as whether it can be analysed: both need the
// samples, same-origin. Callers use it for the startup log and for Caps.
func (p *Provider) CanStream() bool { return p.ytdlp != "" }

// findExtractor resolves the binary once, at construction. Looking it up per
// request would turn a missing install into a per-play error rather than one
// line at startup, and would cost a PATH walk on every play.
func findExtractor(configured string) string {
	if configured != "" {
		// An explicitly configured path that does not work is a mistake worth
		// reporting through CanStream rather than silently falling back to a
		// different binary than the operator named.
		if _, err := exec.LookPath(configured); err != nil {
			return ""
		}
		return configured
	}
	path, err := exec.LookPath("yt-dlp")
	if err != nil {
		return ""
	}
	return path
}

// StreamURL resolves a direct audio url for one video, satisfying
// source.Streamer.
//
// The url is signed and expires, so it is resolved per play rather than stored
// against the track, exactly as Bandcamp's is.
func (p *Provider) StreamURL(ctx context.Context, ref source.Ref) (string, error) {
	if !validVideoID(ref.ID) {
		return "", fmt.Errorf("youtube: %q is not a video id", ref.ID)
	}
	if !p.CanStream() {
		return "", fmt.Errorf("%w: youtube: no audio extractor is installed on this server", source.ErrUnsupported)
	}
	if cached, ok := p.streams.get(ref.ID); ok {
		return cached, nil
	}

	url, err := p.extract(ctx, ref.ID)
	if err != nil {
		return "", err
	}
	p.streams.set(ref.ID, url, streamTTL)
	return url, nil
}

// extract runs the extractor and reads the one url it prints.
func (p *Provider) extract(ctx context.Context, videoID string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, extractTimeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, p.ytdlp,
		"--quiet", "--no-warnings",
		// A watch url can carry a list=, and expanding it here would resolve
		// the wrong video.
		"--no-playlist",
		"--format", audioFormat,
		"--get-url",
		"--socket-timeout", "10",
		"--", watchURL(videoID),
	)

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			return "", fmt.Errorf("youtube: the extractor timed out resolving %s", videoID)
		}
		return "", extractError(videoID, stderr.String())
	}

	// --get-url prints one line per selected stream, and the format selector
	// above selects one. Anything else means the video had no audio to take.
	for _, line := range strings.Split(stdout.String(), "\n") {
		if line = strings.TrimSpace(line); strings.HasPrefix(line, "https://") {
			return line, nil
		}
	}
	return "", fmt.Errorf("%w: youtube: %s has no audio stream", source.ErrNotFound, videoID)
}

// extractError turns the extractor's own complaint into something worth showing
// a person. Its messages are written for humans already; what they are not
// written for is being pasted into a web page whole, so only the first line is
// kept and the "ERROR:" prefix goes.
func extractError(videoID, stderr string) error {
	msg := ""
	for _, line := range strings.Split(stderr, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		msg = strings.TrimSpace(strings.TrimPrefix(line, "ERROR:"))
		break
	}

	// These are the two the listener can act on, and both mean the same thing
	// to this server as a deleted Bandcamp track does.
	lower := strings.ToLower(msg)
	if strings.Contains(lower, "unavailable") || strings.Contains(lower, "private") ||
		strings.Contains(lower, "removed") || strings.Contains(lower, "does not exist") {
		return fmt.Errorf("%w: youtube: %s is unavailable", source.ErrNotFound, videoID)
	}
	if msg == "" {
		msg = "the extractor failed"
	}
	return fmt.Errorf("youtube: could not resolve audio for %s: %s", videoID, msg)
}

// ---------- downloading, for analysis ----------

const (
	// downloadTimeout bounds one download. A track is a few megabytes over a
	// connection YouTube throttles, so this is far longer than resolving a url.
	downloadTimeout = 5 * time.Minute

	// analysisFormat caps the download at 192 kbps instead of taking the best
	// audio the video offers. Tempo and key come out of the spectrum, and that
	// spectrum does not change between 192 kbps and 256 kbps, so the extra
	// bytes buy the analysis nothing and cost it download time. The cap selects
	// a stream YouTube already serves at that rate or below. It does not
	// re-encode: re-encoding needs ffmpeg, and it makes most of these files
	// larger, because the usual audio-only streams are below 192 kbps already.
	// A video that offers nothing under the cap still downloads, at its best
	// rate, through the last two fallbacks.
	analysisFormat = "bestaudio[ext=m4a][abr<=192]/bestaudio[abr<=192]/" + audioFormat

	// maxDownloadMB refuses a file nobody meant to analyse. Tempo and key
	// detection is for tracks; a three-hour set upload would fill the disk and
	// then produce one meaningless number.
	maxDownloadMB = 60
)

// Download fetches one video's audio to a temporary file and returns its path
// along with the function that removes it.
//
// Playback does not use this: it relays the stream url instead, so a play costs
// no disk at all. Analysis does, because it needs the whole file decoded rather
// than a progressive read, and because a signed url proxied straight through is
// throttled hard enough that a full decode often stalls. The extractor knows how
// to work around that; a plain proxy does not.
//
// The caller must always call cleanup, including on error. Nothing here is kept
// after the bytes have been handed over: the file exists for one request.
func (p *Provider) Download(ctx context.Context, videoID string) (path string, cleanup func(), err error) {
	noop := func() {}
	if !validVideoID(videoID) {
		return "", noop, fmt.Errorf("youtube: %q is not a video id", videoID)
	}
	if !p.CanStream() {
		return "", noop, fmt.Errorf("%w: youtube: no audio extractor is installed on this server", source.ErrUnsupported)
	}

	dir, err := os.MkdirTemp("", "b2b-yt-")
	if err != nil {
		return "", noop, fmt.Errorf("youtube: could not make a working directory: %w", err)
	}
	// One directory per download, removed whole, so a partial file or one of
	// the extractor's own .part files cannot outlive the request either.
	cleanup = func() {
		if rmErr := os.RemoveAll(dir); rmErr != nil {
			log.Printf("youtube: could not remove %s: %v", dir, rmErr)
		}
	}

	ctx, cancel := context.WithTimeout(ctx, downloadTimeout)
	defer cancel()

	// The output name is fixed rather than templated on the title, so finding
	// the result afterwards needs no guessing at what the extractor sanitised.
	target := filepath.Join(dir, "audio")
	cmd := exec.CommandContext(ctx, p.ytdlp,
		"--quiet", "--no-warnings", "--no-playlist",
		"--format", analysisFormat,
		"--max-filesize", fmt.Sprintf("%dM", maxDownloadMB),
		"--no-part",
		"--socket-timeout", "10",
		"--output", target+".%(ext)s",
		"--", watchURL(videoID),
	)

	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		if ctx.Err() != nil {
			cleanup()
			return "", noop, fmt.Errorf("youtube: the download of %s timed out", videoID)
		}
		cleanup()
		return "", noop, extractError(videoID, stderr.String())
	}

	// The extension depends on which format was selected, so the one file in
	// the directory is the answer rather than a name that can be predicted.
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) == 0 {
		cleanup()
		// An over-size video exits cleanly having written nothing, which is
		// the same outcome as a video with no audio and worth saying plainly.
		return "", noop, fmt.Errorf("%w: youtube: nothing to analyse for %s, it may be longer than %d MB of audio",
			source.ErrNotFound, videoID, maxDownloadMB)
	}
	return filepath.Join(dir, entries[0].Name()), cleanup, nil
}

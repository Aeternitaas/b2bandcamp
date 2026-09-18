import { useCallback, useRef, useState } from 'react'
import { usePlayer } from '../state/player'
import type { SourceId, Track } from '../types'

/** Number of positions a repeated press steps through before wrapping. */
const SCRUB_STEPS = 6

/**
 * Something playable that is not a playlist row: a wishlist item, a search
 * result, a song on an album nobody has added yet.
 *
 * The fields are named as a Track's are, because that is what this becomes, and
 * two names for the same value is how they drift apart.
 */
export interface PreviewSource {
  source: SourceId
  source_id: string
  source_ref?: string
  title: string
  artist: string
  album_title?: string
  art_id?: number | null
  art_url?: string
  duration?: number
  track_url?: string
}

/**
 * Bandcamp's ids are numbers everywhere it hands them out, and text everywhere
 * this app carries them. This is the one conversion, so no caller has to
 * remember which side of that line it is on.
 */
export function bcSource(trackId: number, bandId: number): Pick<PreviewSource, 'source' | 'source_id' | 'source_ref'> {
  return { source: 'bandcamp', source_id: String(trackId), source_ref: String(bandId) }
}

/**
 * Preview playback for things that are not in a playlist yet, wishlist items
 * and album listings.
 *
 * Pressing once starts the track; pressing again scrubs forward by a sixth,
 * wrapping back to the start after the last step, which makes it quick to hear
 * whether a track is worth adding without committing to it first.
 */
export function usePreview() {
  const player = usePlayer()
  const pressesRef = useRef(0)
  const [previewing, setPreviewing] = useState<string | null>(null)

  const press = useCallback((source: PreviewSource) => {
    const isSame = isLoaded(player.current, source.source, source.source_id)

    if (!isSame) {
      pressesRef.current = 1
      setPreviewing(source.source_id)

      // playlist_id 0 marks this as ephemeral, so nothing tries to persist a
      // detected tempo against a playlist row that does not exist. The row id
      // only has to be unique and negative, for the same reason.
      const track: Track = {
        id: -Date.now(),
        playlist_id: 0,
        position: 0,
        source: source.source,
        source_id: source.source_id,
        source_ref: source.source_ref ?? '',
        // The Bandcamp-only ids stay filled for a Bandcamp preview, because
        // views that have not moved off them yet still read them.
        bc_track_id: source.source === 'bandcamp' ? Number(source.source_id) : null,
        bc_album_id: null,
        bc_band_id: source.source === 'bandcamp' ? Number(source.source_ref) : null,
        title: source.title,
        artist: source.artist,
        album_title: source.album_title ?? '',
        duration: source.duration ?? 0,
        bpm: null,
        key_override: '',
        note: '',
        detected_bpm: null,
        key_camelot: '',
        key_name: '',
        art_id: source.art_id ?? null,
        art_url: source.art_url ?? '',
        track_url: source.track_url ?? '',
        added_by: null,
        added_at: new Date().toISOString(),
        added_by_name: '',
        added_by_avatar: '',
      }
      player.play([track], 0)
      return
    }

    // Already playing this one: step forward, wrapping past the last position.
    pressesRef.current += 1
    const step = (pressesRef.current - 1) % SCRUB_STEPS
    const total = player.duration || source.duration || 0
    player.seek(total > 0 ? (step / SCRUB_STEPS) * total : 0)
  }, [player])

  /**
   * Stops playback if what is playing is an ephemeral preview. Leaves a real
   * playlist track alone, closing the wishlist should not interrupt listening
   * that was already under way.
   */
  const stopPreview = useCallback(() => {
    if (player.current && player.current.playlist_id <= 0) player.stop()
  }, [player])

  return {
    press,
    stopPreview,
    previewing,
    /** True while this track is the one currently loaded in the player. */
    isPreviewing: (source: SourceId, sourceId: string) => isLoaded(player.current, source, sourceId),
  }
}

/** Identity is (source, id): two sources can and do use the same id text. */
function isLoaded(current: Track | null, source: SourceId, sourceId: string): boolean {
  return !!current && current.source === source && current.source_id === sourceId
}

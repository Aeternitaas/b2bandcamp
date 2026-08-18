import { useCallback, useRef, useState } from 'react'
import { usePlayer } from '../state/player'
import type { Track } from '../types'

/** Number of positions a repeated press steps through before wrapping. */
const SCRUB_STEPS = 6

export interface PreviewSource {
  trackId: number
  bandId: number
  title: string
  artist: string
  albumTitle?: string
  artId?: number | null
  duration?: number
  trackUrl?: string
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
  const [previewing, setPreviewing] = useState<number | null>(null)

  const press = useCallback((source: PreviewSource) => {
    const isSame = player.current?.bc_track_id === source.trackId

    if (!isSame) {
      pressesRef.current = 1
      setPreviewing(source.trackId)

      // playlist_id 0 marks this as ephemeral, so nothing tries to persist a
      // detected tempo against a playlist row that does not exist.
      const track: Track = {
        id: -source.trackId,
        playlist_id: 0,
        position: 0,
        bc_track_id: source.trackId,
        bc_album_id: null,
        bc_band_id: source.bandId,
        title: source.title,
        artist: source.artist,
        album_title: source.albumTitle ?? '',
        duration: source.duration ?? 0,
        bpm: null,
        key_override: '',
        note: '',
        detected_bpm: null,
        key_camelot: '',
        key_name: '',
        art_id: source.artId ?? null,
        track_url: source.trackUrl ?? '',
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
    isPreviewing: (trackId: number) => player.current?.bc_track_id === trackId,
  }
}

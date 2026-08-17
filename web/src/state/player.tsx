import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { artUrl } from '../utils'
import type { Track } from '../types'

interface PlayerValue {
  queue: Track[]
  index: number
  current: Track | null
  playing: boolean
  position: number
  duration: number
  error: string
  play: (queue: Track[], startIndex: number) => void
  toggle: () => void
  next: () => void
  prev: () => void
  seek: (seconds: number) => void
  stop: () => void
}

const PlayerContext = createContext<PlayerValue | null>(null)

export function PlayerProvider({ children }: { children: ReactNode }) {
  // One audio element for the lifetime of the app. Reusing it matters on iOS,
  // where playback may only start from inside a user gesture — creating a new
  // element per track would break autoplay of the next track in the queue.
  const audioRef = useRef<HTMLAudioElement | null>(null)
  if (audioRef.current === null && typeof Audio !== 'undefined') {
    audioRef.current = new Audio()
    audioRef.current.preload = 'metadata'
  }

  const [queue, setQueue] = useState<Track[]>([])
  const [index, setIndex] = useState(-1)
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [error, setError] = useState('')

  const current = index >= 0 && index < queue.length ? queue[index] : null

  // Keep a ref of the queue so audio event handlers, which are bound once, can
  // advance without being re-registered on every state change.
  const queueRef = useRef(queue)
  const indexRef = useRef(index)
  queueRef.current = queue
  indexRef.current = index

  const loadTrack = useCallback((track: Track, autoplay: boolean) => {
    const audio = audioRef.current
    if (!audio) return

    if (!track.bc_band_id) {
      setError('This track is missing its Bandcamp artist id and cannot be played.')
      return
    }

    setError('')
    setPosition(0)
    setDuration(track.duration || 0)
    audio.src = api.streamUrl(track.bc_track_id, track.bc_band_id)
    audio.load()

    if (autoplay) {
      audio.play().catch((err: unknown) => {
        // Autoplay rejection is expected until the user has interacted.
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setPlaying(false)
          return
        }
        setError('Playback failed. Bandcamp may have expired this stream.')
      })
    }
  }, [])

  const play = useCallback((nextQueue: Track[], startIndex: number) => {
    const playable = nextQueue.filter((t) => t.bc_band_id)
    if (playable.length === 0) {
      setError('None of these tracks can be streamed.')
      return
    }
    // Map the requested index through the filter so the right track starts.
    const wanted = nextQueue[startIndex]
    const mapped = wanted ? playable.findIndex((t) => t.id === wanted.id) : 0

    setQueue(playable)
    const target = mapped >= 0 ? mapped : 0
    setIndex(target)
    const track = playable[target]
    if (track) loadTrack(track, true)
  }, [loadTrack])

  const next = useCallback(() => {
    const q = queueRef.current
    const i = indexRef.current
    if (i + 1 >= q.length) {
      setPlaying(false)
      return
    }
    setIndex(i + 1)
    const track = q[i + 1]
    if (track) loadTrack(track, true)
  }, [loadTrack])

  const prev = useCallback(() => {
    const audio = audioRef.current
    // Match the usual convention: restart the track unless we're near the start.
    if (audio && audio.currentTime > 3) {
      audio.currentTime = 0
      return
    }
    const i = indexRef.current
    if (i <= 0) return
    setIndex(i - 1)
    const track = queueRef.current[i - 1]
    if (track) loadTrack(track, true)
  }, [loadTrack])

  const toggle = useCallback(() => {
    const audio = audioRef.current
    if (!audio || !audio.src) return
    if (audio.paused) {
      audio.play().catch(() => setError('Playback failed.'))
    } else {
      audio.pause()
    }
  }, [])

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current
    if (audio && Number.isFinite(seconds)) audio.currentTime = seconds
  }, [])

  const stop = useCallback(() => {
    const audio = audioRef.current
    if (audio) {
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
    }
    setQueue([])
    setIndex(-1)
    setPlaying(false)
    setPosition(0)
    setDuration(0)
  }, [])

  // Bind audio element events once.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onTime = () => setPosition(audio.currentTime)
    const onMeta = () => { if (Number.isFinite(audio.duration)) setDuration(audio.duration) }
    const onEnded = () => next()
    const onError = () => {
      if (audio.src) setError('Could not load this track from Bandcamp.')
    }

    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('timeupdate', onTime)
    audio.addEventListener('loadedmetadata', onMeta)
    audio.addEventListener('ended', onEnded)
    audio.addEventListener('error', onError)

    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('timeupdate', onTime)
      audio.removeEventListener('loadedmetadata', onMeta)
      audio.removeEventListener('ended', onEnded)
      audio.removeEventListener('error', onError)
    }
  }, [next])

  // Lock-screen / notification controls. This is what makes the app usable as a
  // music player on a phone once the screen is off.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !current) return

    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      album: current.album_title || undefined,
      artwork: current.art_id
        ? [
            { src: artUrl(current.art_id, 3), sizes: '150x150', type: 'image/jpeg' },
            { src: artUrl(current.art_id, 9), sizes: '600x600', type: 'image/jpeg' },
          ]
        : [],
    })

    navigator.mediaSession.setActionHandler('play', () => toggle())
    navigator.mediaSession.setActionHandler('pause', () => toggle())
    navigator.mediaSession.setActionHandler('previoustrack', () => prev())
    navigator.mediaSession.setActionHandler('nexttrack', () => next())
  }, [current, toggle, prev, next])

  useEffect(() => {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
    }
  }, [playing])

  const value = useMemo(
    () => ({ queue, index, current, playing, position, duration, error, play, toggle, next, prev, seek, stop }),
    [queue, index, current, playing, position, duration, error, play, toggle, next, prev, seek, stop],
  )

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}

export function usePlayer(): PlayerValue {
  const ctx = useContext(PlayerContext)
  if (!ctx) throw new Error('usePlayer must be used inside PlayerProvider')
  return ctx
}

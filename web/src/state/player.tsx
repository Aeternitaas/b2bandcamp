import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { artUrl } from '../utils'
import type { Track } from '../types'
import type { KeyResult, TempoResult } from '../audio/analysis'
import { analyzeTrack } from '../audio/analyzeTrack'

export interface Analysis {
  status: 'idle' | 'loading' | 'ready' | 'error'
  trackId: number | null
  peaks: Float32Array | null
  tempo: TempoResult | null
  key: KeyResult | null
  error: string
}

interface PlayerValue {
  queue: Track[]
  index: number
  current: Track | null
  playing: boolean
  position: number
  duration: number
  error: string

  volume: number
  muted: boolean
  rate: number
  preservePitch: boolean
  analysis: Analysis

  play: (queue: Track[], startIndex: number) => void
  toggle: () => void
  next: () => void
  prev: () => void
  seek: (seconds: number) => void
  stop: () => void
  setVolume: (v: number) => void
  toggleMute: () => void
  setRate: (r: number) => void
  setPreservePitch: (on: boolean) => void
  analyze: () => void
}

const PlayerContext = createContext<PlayerValue | null>(null)

const VOLUME_KEY = 'b2bandcamp:volume'
const PLAYBACK_KEY = 'b2bandcamp:playback'

/** Discard a restored position older than this, resuming a track from weeks
 *  ago is more surprising than useful. */
const RESUME_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

/** Queues longer than this are not persisted whole; only the current track is,
 *  so a 2000-track playlist cannot fill localStorage. */
const MAX_PERSISTED_QUEUE = 400

interface PersistedPlayback {
  queue: Track[]
  index: number
  position: number
  savedAt: number
}
const IDLE_ANALYSIS: Analysis = {
  status: 'idle', trackId: null, peaks: null, tempo: null, key: null, error: '',
}

export function PlayerProvider({ children }: { children: ReactNode }) {
  // One audio element for the lifetime of the app. Reusing it matters on iOS,
  // where playback may only start from inside a user gesture, creating a new
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

  const [volume, setVolumeState] = useState(() => {
    const stored = Number(localStorage.getItem(VOLUME_KEY))
    return Number.isFinite(stored) && stored > 0 ? Math.min(1, stored) : 1
  })
  const [muted, setMuted] = useState(false)
  const [rate, setRateState] = useState(1)
  const [preservePitch, setPreservePitchState] = useState(true)
  const [analysis, setAnalysis] = useState<Analysis>(IDLE_ANALYSIS)

  // Position to apply once the restored track reports its duration; seeking
  // before metadata arrives is silently ignored by the audio element.
  const pendingSeekRef = useRef<number | null>(null)

  // A double/triple-click on a track row fires onPlay more than once for the
  // same track within milliseconds. Without this, each extra call re-assigns
  // audio.src and re-calls audio.play(), which aborts the prior play()
  // promise and surfaces a spurious "Playback failed" error.
  const lastLoadRef = useRef<{ id: number; time: number } | null>(null)
  const LOAD_DEBOUNCE_MS = 600

  const current = index >= 0 && index < queue.length ? queue[index] : null

  // Keep refs of the queue so audio event handlers, which are bound once, can
  // advance without being re-registered on every state change.
  const queueRef = useRef(queue)
  const indexRef = useRef(index)
  queueRef.current = queue
  indexRef.current = index

  const loadTrack = useCallback((track: Track, autoplay: boolean, resumeAt?: number) => {
    const audio = audioRef.current
    if (!audio) return

    if (!track.bc_band_id) {
      setError('This track is missing its Bandcamp artist id and cannot be played.')
      return
    }

    const now = Date.now()
    const last = lastLoadRef.current
    if (last && last.id === track.id && now - last.time < LOAD_DEBOUNCE_MS) return
    lastLoadRef.current = { id: track.id, time: now }

    setError('')
    setPosition(0)
    setDuration(track.duration || 0)
    setAnalysis(IDLE_ANALYSIS) // analysis belongs to the previous track

    pendingSeekRef.current = resumeAt && resumeAt > 1 ? resumeAt : null
    audio.src = api.streamUrl(track.bc_track_id, track.bc_band_id)
    audio.load()

    if (autoplay) {
      audio.play().catch((err: unknown) => {
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
    setAnalysis(IDLE_ANALYSIS)
    try {
      localStorage.removeItem(PLAYBACK_KEY)
    } catch {
      // ignored
    }
  }, [])

  // Restore the last track on load. Playback stays paused: browsers block
  // autoplay without a user gesture, so starting here would either fail or be
  // unwelcome, the track is simply cued up where it left off.
  useEffect(() => {
    let saved: PersistedPlayback | null = null
    try {
      const raw = localStorage.getItem(PLAYBACK_KEY)
      saved = raw ? (JSON.parse(raw) as PersistedPlayback) : null
    } catch {
      saved = null
    }

    if (!saved || !Array.isArray(saved.queue) || saved.queue.length === 0) return
    if (Date.now() - (saved.savedAt ?? 0) > RESUME_MAX_AGE_MS) {
      localStorage.removeItem(PLAYBACK_KEY)
      return
    }

    const index = Math.min(Math.max(0, saved.index ?? 0), saved.queue.length - 1)
    const track = saved.queue[index]
    if (!track?.bc_band_id) return

    setQueue(saved.queue)
    setIndex(index)
    loadTrack(track, false, saved.position)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---------- volume / rate ----------

  const setVolume = useCallback((v: number) => {
    const clamped = Math.min(1, Math.max(0, v))
    setVolumeState(clamped)
    setMuted(clamped === 0)
    localStorage.setItem(VOLUME_KEY, String(clamped))
  }, [])

  const toggleMute = useCallback(() => setMuted((m) => !m), [])

  // Bounded to +/-20%, the range of a DJ pitch fader. Beyond that the
  // time-stretcher audibly degrades and the tempo is no longer the same track.
  const setRate = useCallback((r: number) => {
    setRateState(Math.min(1.2, Math.max(0.8, r)))
  }, [])

  const setPreservePitch = useCallback((on: boolean) => setPreservePitchState(on), [])

  // Apply volume/mute/rate to the element whenever they change.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = volume
    audio.muted = muted
  }, [volume, muted])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.playbackRate = rate
    // Time-stretch instead of resampling, so changing tempo does not transpose
    // the track. Supported in current Chrome/Firefox/Safari.
    if ('preservesPitch' in audio) audio.preservesPitch = preservePitch
  }, [rate, preservePitch])

  // Persisting the whole queue means the rest of the playlist survives a
  // refresh too, not just the one track.
  const lastSaveRef = useRef(0)
  const persist = useCallback((force = false) => {
    const q = queueRef.current
    const i = indexRef.current
    const audio = audioRef.current
    if (!audio || q.length === 0 || i < 0) return

    const now = Date.now()
    if (!force && now - lastSaveRef.current < 5000) return
    lastSaveRef.current = now

    const payload: PersistedPlayback = {
      queue: q.length > MAX_PERSISTED_QUEUE ? [q[i]] : q,
      index: q.length > MAX_PERSISTED_QUEUE ? 0 : i,
      position: audio.currentTime,
      savedAt: now,
    }
    try {
      localStorage.setItem(PLAYBACK_KEY, JSON.stringify(payload))
    } catch {
      // Quota or private mode; resuming is a convenience, not a requirement.
    }
  }, [])

  // Save on the way out, including the mobile case where the tab is frozen
  // rather than unloaded.
  useEffect(() => {
    const onHide = () => persist(true)
    window.addEventListener('pagehide', onHide)
    document.addEventListener('visibilitychange', onHide)
    return () => {
      window.removeEventListener('pagehide', onHide)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [persist])

  // ---------- offline analysis ----------

  const requestIdRef = useRef(0)

  const analyze = useCallback(() => {
    const track = queueRef.current[indexRef.current]
    if (!track || !track.bc_band_id) return

    setAnalysis({ ...IDLE_ANALYSIS, status: 'loading', trackId: track.id })
    const requestId = ++requestIdRef.current

    analyzeTrack(track.bc_track_id, track.bc_band_id)
      .then((result) => {
        if (requestId !== requestIdRef.current) return // superseded
        setAnalysis({
          status: 'ready',
          trackId: track.id,
          peaks: result.peaks,
          tempo: result.tempo,
          key: result.key,
          error: '',
        })
      })
      .catch((err: Error) => {
        if (requestId !== requestIdRef.current) return
        setAnalysis({ ...IDLE_ANALYSIS, status: 'error', error: err.message })
      })
  }, [])

  // ---------- audio element events ----------

  // Loading a new source resets playbackRate in some browsers, so the current
  // value has to be reapplied from a ref the once-bound handler can read.
  const rateRef = useRef(rate)
  rateRef.current = rate

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onPlay = () => setPlaying(true)
    const onPause = () => {
      setPlaying(false)
      persistRef.current(true)
    }
    const onTime = () => {
      setPosition(audio.currentTime)
      persistRef.current()
    }
    const onMeta = () => {
      if (Number.isFinite(audio.duration)) setDuration(audio.duration)
      audio.playbackRate = rateRef.current

      const resumeAt = pendingSeekRef.current
      if (resumeAt !== null) {
        pendingSeekRef.current = null
        if (Number.isFinite(audio.duration) && resumeAt < audio.duration - 1) {
          audio.currentTime = resumeAt
          setPosition(resumeAt)
        }
      }
    }
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

  const persistRef = useRef<(force?: boolean) => void>(() => {})
  persistRef.current = persist

  // Lock-screen / notification controls.
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
    () => ({
      queue, index, current, playing, position, duration, error,
      volume, muted, rate, preservePitch, analysis,
      play, toggle, next, prev, seek, stop,
      setVolume, toggleMute, setRate, setPreservePitch, analyze,
    }),
    [queue, index, current, playing, position, duration, error,
      volume, muted, rate, preservePitch, analysis,
      play, toggle, next, prev, seek, stop,
      setVolume, toggleMute, setRate, setPreservePitch, analyze],
  )

  return <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
}

export function usePlayer(): PlayerValue {
  const ctx = useContext(PlayerContext)
  if (!ctx) throw new Error('usePlayer must be used inside PlayerProvider')
  return ctx
}

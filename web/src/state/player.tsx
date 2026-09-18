import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react'
import type { ReactNode } from 'react'
import { api } from '../api'
import { trackArt } from '../utils'
import { capsOf, playbackUnavailable, sourceMeta, useSourceCaps } from '../sources'
import type { Track } from '../types'
import type { KeyResult, TempoResult } from '../audio/analysis'
import { analyzeTrack } from '../audio/analyzeTrack'
import { YT_STATE, loadYouTubeApi, youTubeErrorMessage } from '../audio/youtubeEmbed'
import type { YTPlayer } from '../audio/youtubeEmbed'

/** Which player the current track is loaded into. */
type Engine = 'audio' | 'youtube'

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
  /** True when the current track plays in YouTube's iframe player. */
  embedded: boolean
  /** Callback ref for the element that holds the iframe player. */
  attachEmbed: (slot: HTMLDivElement | null) => void

  play:(queue: Track[], startIndex: number) => void
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

  // What each source can do here, which decides whether a row can be played at
  // all. Held in a ref as well, because the audio element's handlers and the
  // load path are bound once and must still see the current answer.
  const caps = useSourceCaps()
  const capsRef = useRef(caps)
  capsRef.current = caps
  const canPlay = useCallback((track: Track) => {
    const c = capsOf(capsRef.current, track.source)
    return c.stream || c.embed
  }, [])
  // A server that can stream a row always wins over the embedded player.
  const embeds = useCallback((track: Track) => {
    const c = capsOf(capsRef.current, track.source)
    return !c.stream && c.embed
  }, [])

  // A row that cannot stream plays in YouTube's iframe player instead. The
  // engine is recorded per load, so a late capabilities answer cannot move a
  // track that is already loaded to the other player.
  const [engine, setEngine] = useState<Engine>('audio')
  const engineRef = useRef<Engine>('audio')
  const selectEngine = useCallback((next: Engine) => {
    engineRef.current = next
    setEngine(next)
  }, [])

  const ytRef = useRef<YTPlayer | null>(null)
  const ytReadyRef = useRef(false)
  // The video to load when the iframe player is ready. The player bar mounts
  // the iframe after the track is chosen, so a load can arrive first.
  const ytPendingRef = useRef<{ videoId: string; autoplay: boolean; start: number } | null>(null)

  const applyYtPending = useCallback(() => {
    const yt = ytRef.current
    const pending = ytPendingRef.current
    if (!yt || !ytReadyRef.current || !pending) return
    ytPendingRef.current = null
    const request = { videoId: pending.videoId, startSeconds: pending.start }
    if (pending.autoplay) yt.loadVideoById(request)
    else yt.cueVideoById(request)
  }, [])

  const currentTime = useCallback(() => {
    if (engineRef.current === 'youtube') {
      return ytReadyRef.current ? ytRef.current?.getCurrentTime() ?? 0 : 0
    }
    return audioRef.current?.currentTime ?? 0
  }, [])

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

    if (!canPlay(track)) {
      setError(playbackUnavailable(track.source))
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

    const start = resumeAt && resumeAt > 1 ? resumeAt : null

    if (embeds(track)) {
      selectEngine('youtube')
      pendingSeekRef.current = null
      if (audio.src) {
        audio.pause()
        audio.removeAttribute('src')
        audio.load()
      }
      setPlaying(false) // the iframe player reports when it really starts
      setPosition(start ?? 0)
      ytPendingRef.current = { videoId: track.source_id, autoplay, start: start ?? 0 }
      applyYtPending()
      return
    }

    selectEngine('audio')
    pendingSeekRef.current = start
    audio.src = api.streamUrl(track)
    audio.load()

    if (autoplay) {
      audio.play().catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setPlaying(false)
          return
        }
        setError(`Playback failed. ${sourceMeta(track.source).label} may have expired this stream.`)
      })
    }
  }, [canPlay, embeds, selectEngine, applyYtPending])

  const seek = useCallback((seconds: number) => {
    if (!Number.isFinite(seconds)) return
    if (engineRef.current === 'youtube') {
      if (ytReadyRef.current) ytRef.current?.seekTo(seconds, true)
      setPosition(seconds)
      return
    }
    const audio = audioRef.current
    if (audio) audio.currentTime = seconds
  }, [])

  const play =useCallback((nextQueue: Track[], startIndex: number) => {
    const playable = nextQueue.filter(canPlay)
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
  }, [canPlay, loadTrack])

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
    if (currentTime() > 3) {
      seek(0)
      return
    }
    const i = indexRef.current
    if (i <= 0) return
    setIndex(i - 1)
    const track = queueRef.current[i - 1]
    if (track) loadTrack(track, true)
  }, [loadTrack, currentTime, seek])

  const toggle = useCallback(() => {
    if (engineRef.current === 'youtube') {
      const yt = ytRef.current
      if (!yt || !ytReadyRef.current) return
      const state = yt.getPlayerState()
      if (state === YT_STATE.PLAYING || state === YT_STATE.BUFFERING) yt.pauseVideo()
      else yt.playVideo()
      return
    }
    const audio = audioRef.current
    if (!audio || !audio.src) return
    if (audio.paused) {
      audio.play().catch(() => setError('Playback failed.'))
    } else {
      audio.pause()
    }
  }, [])

  const stop = useCallback(() => {
    // The player bar unmounts, which removes the iframe player.
    ytPendingRef.current = null
    selectEngine('audio')
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
  }, [selectEngine])

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
    if (!track || !canPlay(track)) return

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
  // The iframe player reads the same values when it becomes ready.
  const volumeRef = useRef(volume)
  const mutedRef = useRef(muted)
  volumeRef.current = volume
  mutedRef.current = muted

  const applyYtSettings = useCallback(() => {
    const yt = ytReadyRef.current ? ytRef.current : null
    if (!yt) return
    yt.setVolume(Math.round(volumeRef.current * 100))
    if (mutedRef.current) yt.mute()
    else yt.unMute()
    yt.setPlaybackRate(rateRef.current)
  }, [])

  useEffect(() => {
    applyYtSettings()
  }, [volume, muted, rate, applyYtSettings])

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
    if (q.length === 0 || i < 0) return

    const now = Date.now()
    if (!force && now - lastSaveRef.current < 5000) return
    lastSaveRef.current = now

    const payload: PersistedPlayback = {
      queue: q.length > MAX_PERSISTED_QUEUE ? [q[i]] : q,
      index: q.length > MAX_PERSISTED_QUEUE ? 0 : i,
      position: currentTime(),
      savedAt: now,
    }
    try {
      localStorage.setItem(PLAYBACK_KEY, JSON.stringify(payload))
    } catch {
      // Quota or private mode; resuming is a convenience, not a requirement.
    }
  }, [currentTime])

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
    if (!track || !capsOf(capsRef.current, track.source).analyze) return

    setAnalysis({ ...IDLE_ANALYSIS, status: 'loading', trackId: track.id })
    const requestId = ++requestIdRef.current

    analyzeTrack(track)
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

    // The element keeps sending events for a short time after a switch to the
    // iframe player. Those events must not change the state of the new track.
    const onAudio = () => engineRef.current === 'audio'

    const onPlay = () => {
      if (onAudio()) setPlaying(true)
    }
    const onPause = () => {
      if (!onAudio()) return
      setPlaying(false)
      persistRef.current(true)
    }
    const onTime = () => {
      if (!onAudio()) return
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
    const onEnded = () => {
      if (onAudio()) next()
    }
    const onError = () => {
      const track = queueRef.current[indexRef.current]
      if (audio.src && onAudio()) setError(`Could not load this track from ${sourceMeta(track?.source).label}.`)
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

  // ---------- YouTube iframe player ----------

  // Bound into the iframe player once, so it reads the current `next` here.
  const onYtStateRef = useRef<(state: number) => void>(() => {})
  onYtStateRef.current = (state: number) => {
    const yt = ytRef.current
    if (engineRef.current !== 'youtube' || !yt) return
    if (state === YT_STATE.PLAYING) {
      setPlaying(true)
      setError('')
      const d = yt.getDuration()
      if (d > 0) setDuration(d)
      // A new video starts at normal speed, so the fader value is set again.
      yt.setPlaybackRate(rateRef.current)
    } else if (state === YT_STATE.PAUSED) {
      setPlaying(false)
      persistRef.current(true)
    } else if (state === YT_STATE.ENDED) {
      next()
    }
  }

  /**
   * Creates the iframe player inside `slot`, and removes it when the slot
   * unmounts.
   *
   * The app creates the iframe itself and gives it to YouTube's API. React must
   * never own that element, so it is created here, as the only child of the
   * slot. The page sends no referrer, and YouTube refuses to play in a frame
   * that has none (error 153), so this frame sets its own referrer policy.
   */
  const attachEmbed = useCallback((slot: HTMLDivElement | null) => {
    ytRef.current?.destroy()
    ytRef.current = null
    ytReadyRef.current = false
    if (!slot) return

    const params = new URLSearchParams({
      enablejsapi: '1',
      origin: window.location.origin,
      controls: '0',
      disablekb: '1',
      fs: '0',
      iv_load_policy: '3',
      playsinline: '1',
      rel: '0',
    })
    const frame = document.createElement('iframe')
    frame.src = `https://www.youtube-nocookie.com/embed/?${params}`
    frame.title = 'YouTube player'
    frame.allow = 'autoplay; encrypted-media'
    frame.referrerPolicy = 'strict-origin-when-cross-origin'
    // Tab and Space stay with the page, where the bar handles them.
    frame.tabIndex = -1
    slot.replaceChildren(frame)

    loadYouTubeApi()
      .then((YT) => {
        if (!frame.isConnected) return // the slot unmounted during the load
        const yt = new YT.Player(frame, {
          events: {
            onReady: () => {
              if (ytRef.current !== yt) return
              ytReadyRef.current = true
              applyYtSettings()
              applyYtPending()
            },
            onStateChange: (e) => {
              if (ytRef.current === yt) onYtStateRef.current(e.data)
            },
            onPlaybackRateChange: (e) => {
              // YouTube can round a rate. Show the rate that really plays.
              if (ytRef.current === yt) setRate(e.data)
            },
            onError: (e) => {
              if (ytRef.current !== yt || engineRef.current !== 'youtube') return
              setPlaying(false)
              setError(youTubeErrorMessage(e.data))
            },
          },
        })
        ytRef.current = yt
      })
      .catch((err: Error) => setError(err.message))
  }, [applyYtSettings, applyYtPending, setRate])

  // The iframe player sends no time events, so the position is read here.
  useEffect(() => {
    if (engine !== 'youtube' || !playing) return
    const id = window.setInterval(() => {
      const yt = ytReadyRef.current ? ytRef.current : null
      if (!yt) return
      setPosition(yt.getCurrentTime())
      const d = yt.getDuration()
      if (d > 0) setDuration(d)
      persistRef.current()
    }, 250)
    return () => window.clearInterval(id)
  }, [engine, playing])

  // Lock-screen / notification controls.
  useEffect(() => {
    if (!('mediaSession' in navigator) || !current) return

    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      album: current.album_title || undefined,
      // Two sizes where the source lets this app choose one, and the single
      // image it published where it does not.
      artwork: current.art_id
        ? [
            { src: trackArt(current, 3), sizes: '150x150', type: 'image/jpeg' },
            { src: trackArt(current, 9), sizes: '600x600', type: 'image/jpeg' },
          ]
        : current.art_url
          ? [{ src: current.art_url, type: 'image/jpeg' }]
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

  // Space toggles playback from anywhere on the page, the same shortcut every
  // media site uses. Skipped whenever it would otherwise land on a form field
  // or a real button/link, those already do their own thing with Space (type
  // a space, or activate the control on keyup), and stealing that would
  // conflict with typing a literal space into a bpm/key/note field.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== ' ') return
      const target = e.target as HTMLElement | null
      if (target?.closest('input, textarea, select, button, a[href], [role="button"], [contenteditable="true"]')) return
      e.preventDefault() // stop the page from scrolling on a bare Space
      toggle()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [toggle])

  const embedded = engine === 'youtube' && current !== null

  const value = useMemo(
    () => ({
      queue, index, current, playing, position, duration, error,
      volume, muted, rate, preservePitch, analysis, embedded, attachEmbed,
      play, toggle, next, prev, seek, stop,
      setVolume, toggleMute, setRate, setPreservePitch, analyze,
    }),
    [queue, index, current, playing, position, duration, error,
      volume, muted, rate, preservePitch, analysis, embedded, attachEmbed,
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

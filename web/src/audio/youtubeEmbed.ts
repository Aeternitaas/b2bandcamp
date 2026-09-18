/**
 * The part of YouTube's IFrame Player API that this app uses.
 *
 * A YouTube row plays in YouTube's own player when the server has no audio
 * extractor (`embed: true` from GET /api/sources). The API is one global
 * script. This file loads that script once and shares the result, so the app
 * needs no extra package for it.
 */

/** Values of `getPlayerState()` and of the `onStateChange` event. */
export const YT_STATE = {
  ENDED: 0,
  PLAYING: 1,
  PAUSED: 2,
  BUFFERING: 3,
  CUED: 5,
} as const

interface VideoRequest {
  videoId: string
  startSeconds?: number
}

export interface YTPlayer {
  loadVideoById(request: VideoRequest): void
  cueVideoById(request: VideoRequest): void
  playVideo(): void
  pauseVideo(): void
  seekTo(seconds: number, allowSeekAhead: boolean): void
  getCurrentTime(): number
  getDuration(): number
  getPlayerState(): number
  setVolume(volume: number): void
  mute(): void
  unMute(): void
  setPlaybackRate(rate: number): void
  destroy(): void
}

interface YTEvent<T = undefined> {
  target: YTPlayer
  data: T
}

interface YTPlayerOptions {
  events?: {
    onReady?: (event: YTEvent) => void
    onStateChange?: (event: YTEvent<number>) => void
    onPlaybackRateChange?: (event: YTEvent<number>) => void
    onError?: (event: YTEvent<number>) => void
  }
}

interface YTNamespace {
  Player: new (target: HTMLElement, options: YTPlayerOptions) => YTPlayer
}

declare global {
  interface Window {
    YT?: YTNamespace
    onYouTubeIframeAPIReady?: () => void
  }
}

let loading: Promise<YTNamespace> | null = null

/** Loads the IFrame Player API script once. A failed load can be tried again. */
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (!loading) {
    loading = new Promise<YTNamespace>((resolve, reject) => {
      const previous = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => {
        previous?.()
        if (window.YT) resolve(window.YT)
      }

      const script = document.createElement('script')
      script.src = 'https://www.youtube.com/iframe_api'
      script.async = true
      script.onerror = () => {
        loading = null
        script.remove()
        reject(new Error('Could not load the YouTube player.'))
      }
      document.head.appendChild(script)
    })
  }
  return loading
}

/** A message for the person listening, from an `onError` code. */
export function youTubeErrorMessage(code: number): string {
  switch (code) {
    case 100:
      return 'This video is private or was removed.'
    case 101:
    case 150:
      return 'The uploader does not allow this video to play outside YouTube.'
    case 153:
      return 'YouTube refused the player because the page sent no referrer.'
    default:
      return 'YouTube could not play this video.'
  }
}

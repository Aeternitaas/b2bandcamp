import { api } from '../api'
import type { KeyResult, TempoResult } from './analysis'
import type { AnalyzeRequest, AnalyzeResponse } from './analyzer.worker'

export interface TrackAnalysis {
  peaks: Float32Array
  tempo: TempoResult
  key: KeyResult | null
  /** True when this came from the server rather than being computed here. */
  cached?: boolean
}

/**
 * Peaks are normalised to 0–1 and drawn a few pixels tall, so one byte per
 * bucket is ample precision and keeps a stored waveform under half a kilobyte.
 */
function encodePeaks(peaks: Float32Array): string {
  const bytes = new Uint8Array(peaks.length)
  for (let i = 0; i < peaks.length; i++) {
    bytes[i] = Math.max(0, Math.min(255, Math.round(peaks[i] * 255)))
  }
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function decodePeaks(b64: string): Float32Array {
  const binary = atob(b64)
  const peaks = new Float32Array(binary.length)
  for (let i = 0; i < binary.length; i++) peaks[i] = binary.charCodeAt(i) / 255
  return peaks
}

/**
 * Analyses one track's audio: waveform peaks, tempo and key.
 *
 * Shared by the player (current track) and the playlist's batch action, so
 * both paths produce identical numbers. The worker is created once and reused,
 * spinning one up per track would cost more than the analysis itself.
 */

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, {
  resolve: (value: TrackAnalysis) => void
  reject: (reason: Error) => void
}>()

/**
 * Analyses already running, keyed by track. Analysing one track twice at once
 *, say the player panel and a batch run reaching it together, would download
 * and decode the same audio twice and race to write the same cache row, so
 * callers share the in-flight promise instead.
 */
const inFlight = new Map<number, Promise<TrackAnalysis>>()

function getWorker(): Worker {
  if (worker) return worker

  worker = new Worker(new URL('./analyzer.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (event: MessageEvent<AnalyzeResponse>) => {
    const data = event.data
    const entry = pending.get(data.id)
    if (!entry) return
    pending.delete(data.id)

    if (data.error) entry.reject(new Error(data.error))
    else entry.resolve({ peaks: data.peaks, tempo: data.tempo, key: data.key })
  }
  worker.onerror = () => {
    for (const entry of pending.values()) entry.reject(new Error('analysis worker failed'))
    pending.clear()
  }
  return worker
}

/** Decodes audio to mono PCM. Must run on the main thread: decodeAudioData
 *  needs an AudioContext, which workers do not reliably have. */
async function decodeMono(
  trackId: number,
  bandId: number,
  signal?: AbortSignal,
): Promise<{ samples: Float32Array; sampleRate: number }> {
  // The proxied endpoint is same-origin, so Web Audio may read the samples;
  // the CDN URL used for playback is not.
  const res = await fetch(api.audioUrl(trackId, bandId), { signal })
  if (!res.ok) throw new Error(`could not fetch audio (${res.status})`)
  const bytes = await res.arrayBuffer()

  const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
  const ctx = new Ctx()
  try {
    const buffer = await ctx.decodeAudioData(bytes)

    // Downmix: analysis gains nothing from stereo and it halves the work.
    const length = buffer.length
    const mono = new Float32Array(length)
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch)
      for (let i = 0; i < length; i++) mono[i] += data[i]
    }
    if (buffer.numberOfChannels > 1) {
      for (let i = 0; i < length; i++) mono[i] /= buffer.numberOfChannels
    }
    return { samples: mono, sampleRate: buffer.sampleRate }
  } finally {
    void ctx.close()
  }
}

/**
 * Analyses a track, reusing the server's cached result when there is one.
 *
 * The cache is keyed by Bandcamp track id, so a track analysed in one playlist
 * is already done everywhere it appears, for every user. A hit skips the
 * download and decode entirely, which is the expensive part.
 */
export function analyzeTrack(
  trackId: number,
  bandId: number,
  opts: { buckets?: number; signal?: AbortSignal; force?: boolean } = {},
): Promise<TrackAnalysis> {
  const existing = inFlight.get(trackId)
  if (existing && !opts.force) return existing

  const run = runAnalysis(trackId, bandId, opts)
  inFlight.set(trackId, run)
  // Clear the slot either way; a failure should not poison later attempts.
  void run.finally(() => {
    if (inFlight.get(trackId) === run) inFlight.delete(trackId)
  })
  return run
}

async function runAnalysis(
  trackId: number,
  bandId: number,
  opts: { buckets?: number; signal?: AbortSignal; force?: boolean },
): Promise<TrackAnalysis> {
  if (!opts.force) {
    try {
      const cached = await api.getAnalysis(trackId)
      if (cached) {
        return {
          peaks: decodePeaks(cached.peaks ?? ''),
          tempo: { bpm: cached.bpm ?? 0, confidence: cached.bpm_confidence ?? 0 },
          key: cached.key_name && cached.key_tonic !== undefined && cached.key_tonic !== null
            ? {
                name: cached.key_name,
                camelot: cached.key_camelot ?? '',
                tonic: cached.key_name.split(' ')[0],
                tonicIndex: cached.key_tonic,
                scale: cached.key_scale === 'major' ? 'major' : 'minor',
                confidence: cached.key_confidence ?? 0,
              }
            : null,
          cached: true,
        }
      }
    } catch {
      // A cache miss or an unreachable cache is not a failure, fall through
      // and compute it locally.
    }
  }

  const { samples, sampleRate } = await decodeMono(trackId, bandId, opts.signal)

  const id = nextId++
  const request: AnalyzeRequest = {
    id,
    samples,
    sampleRate,
    buckets: opts.buckets ?? 400,
  }

  const result = await new Promise<TrackAnalysis>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    // Transfer the sample buffer rather than copying it across.
    getWorker().postMessage(request, [samples.buffer])
  })

  // Publish it so nobody repeats this work. Failures here (not signed in, for
  // instance) must not fail the analysis the caller asked for.
  api.saveAnalysis(trackId, {
    bpm: result.tempo.bpm > 0 ? result.tempo.bpm : null,
    bpm_confidence: result.tempo.confidence,
    key_name: result.key?.name ?? '',
    key_camelot: result.key?.camelot ?? '',
    key_tonic: result.key?.tonicIndex ?? null,
    key_scale: result.key?.scale ?? '',
    key_confidence: result.key?.confidence ?? null,
    peaks: encodePeaks(result.peaks),
  }).catch(() => undefined)

  return result
}

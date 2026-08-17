/// <reference lib="webworker" />

/**
 * Runs waveform/tempo/key analysis off the main thread.
 *
 * A five-minute track is tens of millions of samples; doing the FFT work
 * inline would stall the UI for seconds. The caller decodes the audio (which
 * needs an AudioContext, so it must happen on the main thread) and transfers
 * the raw samples here.
 */

import { computePeaks, detectKey, detectTempo } from './analysis'
import type { KeyResult, TempoResult } from './analysis'

export interface AnalyzeRequest {
  id: number
  samples: Float32Array
  sampleRate: number
  buckets: number
}

export interface AnalyzeResponse {
  id: number
  peaks: Float32Array
  tempo: TempoResult
  key: KeyResult | null
  error?: string
}

self.onmessage = (event: MessageEvent<AnalyzeRequest>) => {
  const { id, samples, sampleRate, buckets } = event.data

  try {
    const peaks = computePeaks(samples, buckets)
    const tempo = detectTempo(samples, sampleRate)
    const key = detectKey(samples, sampleRate)

    const response: AnalyzeResponse = { id, peaks, tempo, key }
    // Transfer the peaks buffer rather than copying it back.
    ;(self as unknown as Worker).postMessage(response, [peaks.buffer])
  } catch (err) {
    const response: AnalyzeResponse = {
      id,
      peaks: new Float32Array(0),
      tempo: { bpm: 0, confidence: 0 },
      key: null,
      error: err instanceof Error ? err.message : 'analysis failed',
    }
    ;(self as unknown as Worker).postMessage(response)
  }
}

/**
 * Offline audio analysis: waveform peaks, tempo, and musical key.
 *
 * These run on decoded PCM rather than on a live AnalyserNode, because the
 * results should describe the whole track rather than whatever happens to be
 * playing. Everything here is pure and DOM-free so it can run inside a worker.
 */

export interface TempoResult {
  bpm: number
  /** 0–1. Low values mean the autocorrelation peak was not clearly defined. */
  confidence: number
}

export interface KeyResult {
  /** e.g. "F# minor" */
  name: string
  /** Camelot wheel notation, e.g. "11A", what DJs actually match on. */
  camelot: string
  tonic: string
  /** Pitch class of the tonic, 0 = C. Kept so the key can be transposed. */
  tonicIndex: number
  scale: 'major' | 'minor'
  confidence: number
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// Camelot wheel positions, indexed by pitch class (0 = C).
const CAMELOT_MAJOR = ['8B', '3B', '10B', '5B', '12B', '7B', '2B', '9B', '4B', '11B', '6B', '1B']
const CAMELOT_MINOR = ['5A', '12A', '7A', '2A', '9A', '4A', '11A', '6A', '1A', '8A', '3A', '10A']

// Krumhansl–Kessler key profiles: averaged listener ratings of how well each
// pitch class fits a key. Correlating a track's chroma against all 24 rotations
// of these is the standard way to estimate key.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

/**
 * Reduces the track to `buckets` peak amplitudes for drawing. Each bucket holds
 * the maximum absolute sample in its slice, which preserves transients that
 * averaging would smooth away.
 */
export function computePeaks(samples: Float32Array, buckets: number): Float32Array {
  const peaks = new Float32Array(buckets)
  if (samples.length === 0) return peaks

  const per = samples.length / buckets
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor(i * per)
    const end = Math.min(samples.length, Math.floor((i + 1) * per))
    let max = 0
    for (let j = start; j < end; j++) {
      const v = samples[j] < 0 ? -samples[j] : samples[j]
      if (v > max) max = v
    }
    peaks[i] = max
  }

  // Normalise so quiet masters still fill the display.
  let loudest = 0
  for (let i = 0; i < buckets; i++) if (peaks[i] > loudest) loudest = peaks[i]
  if (loudest > 0) for (let i = 0; i < buckets; i++) peaks[i] /= loudest

  return peaks
}

/**
 * Onset-strength envelope via spectral flux.
 *
 * Summing the positive frame-to-frame change across all spectral bins responds
 * to any percussive event, a hi-hat shows up even under a loud sustained bass
 * note, where a broadband energy difference would miss it entirely. This is the
 * standard front end for tempo estimation (Ellis, "Beat Tracking by Dynamic
 * Programming", 2007).
 */
function melFilterbank(bands: number, fftSize: number, sampleRate: number): Int32Array[] {
  const toMel = (f: number) => 2595 * Math.log10(1 + f / 700)
  const fromMel = (m: number) => 700 * (Math.pow(10, m / 2595) - 1)

  const fMin = 30
  const fMax = Math.min(11025, sampleRate / 2)
  const melMin = toMel(fMin)
  const melMax = toMel(fMax)

  const edges: number[] = []
  for (let i = 0; i < bands + 1; i++) {
    const hz = fromMel(melMin + ((melMax - melMin) * i) / bands)
    edges.push(Math.round((hz * fftSize) / sampleRate))
  }

  const filters: Int32Array[] = []
  for (let b = 0; b < bands; b++) {
    const lo = Math.max(1, edges[b])
    const hi = Math.max(lo + 1, Math.min(fftSize / 2, edges[b + 1]))
    const bins: number[] = []
    for (let k = lo; k < hi; k++) bins.push(k)
    filters.push(Int32Array.from(bins))
  }
  return filters
}

function onsetEnvelope(samples: Float32Array, sampleRate: number): {
  env: Float64Array
  envRate: number
} {
  const fftSize = 1024
  const hop = 512
  const frames = Math.max(0, Math.floor((samples.length - fftSize) / hop))
  if (frames < 8) return { env: new Float64Array(0), envRate: sampleRate / hop }

  // Mel bands rather than raw FFT bins. A 55 Hz kick spans about two of 512
  // linear bins and so contributes almost nothing to a bin-wise flux sum,
  // which biases the envelope towards broadband snares, and snares typically
  // fall on every second beat, which is exactly how half-tempo errors arise.
  // Mel spacing gives the low end its own bands and restores the kick.
  const BANDS = 40
  const filters = melFilterbank(BANDS, fftSize, sampleRate)

  const window = hannWindow(fftSize)
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)
  let prev = new Float64Array(BANDS)
  let cur = new Float64Array(BANDS)
  const env = new Float64Array(frames)

  for (let f = 0; f < frames; f++) {
    const start = f * hop
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[start + i] * window[i]
      im[i] = 0
    }
    fft(re, im)

    let flux = 0
    for (let b = 0; b < BANDS; b++) {
      let energy = 0
      const bins = filters[b]
      for (let i = 0; i < bins.length; i++) {
        const k = bins[i]
        energy += re[k] * re[k] + im[k] * im[k]
      }
      // Log compression so a loud band cannot swamp the sum.
      const mag = Math.log1p(Math.sqrt(energy / Math.max(1, bins.length)))
      cur[b] = mag
      const diff = mag - prev[b]
      if (diff > 0) flux += diff
    }
    env[f] = flux

    const swap = prev
    prev = cur
    cur = swap
  }

  // Remove slow drift so the autocorrelation measures periodicity rather than
  // overall loudness, then normalise.
  const smoothed = new Float64Array(frames)
  const radius = 16
  for (let i = 0; i < frames; i++) {
    let sum = 0
    let count = 0
    for (let j = Math.max(0, i - radius); j <= Math.min(frames - 1, i + radius); j++) {
      sum += env[j]
      count++
    }
    smoothed[i] = sum / Math.max(1, count)
  }

  let peak = 0
  for (let i = 0; i < frames; i++) {
    env[i] = Math.max(0, env[i] - smoothed[i])
    if (env[i] > peak) peak = env[i]
  }
  if (peak > 0) for (let i = 0; i < frames; i++) env[i] /= peak

  return { env, envRate: sampleRate / hop }
}

/**
 * Estimates tempo.
 *
 * Autocorrelating an onset envelope cannot by itself distinguish a beat from
 * its multiples: a 150 BPM track with snares on 2 and 4 correlates most
 * strongly at 75. A log-Gaussian prior over tempo, applied across the whole
 * curve before peak-picking, resolves that, measuring on-beat against
 * off-beat onset strength was tried first and discarded, because the two are
 * indistinguishable in practice (both sit near 0.5).
 */
export function detectTempo(samples: Float32Array, sampleRate: number): TempoResult {
  const { env, envRate } = onsetEnvelope(samples, sampleRate)
  const frames = env.length
  if (frames < 32) return { bpm: 0, confidence: 0 }

  const MIN_BPM = 50
  const MAX_BPM = 210
  const minLag = Math.max(2, Math.floor((60 * envRate) / MAX_BPM))
  const maxLag = Math.min(frames - 1, Math.ceil((60 * envRate) / MIN_BPM))
  if (maxLag <= minLag) return { bpm: 0, confidence: 0 }

  // Autocorrelation of the onset envelope.
  const acf = new Float64Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0
    for (let i = 0; i + lag < frames; i++) sum += env[i] * env[i + lag]
    acf[lag] = sum / (frames - lag)
  }

  // Weight by a log-normal prior centred on 130 BPM. Applying it to the whole
  // curve before peak-picking (rather than to a shortlist afterwards) is what
  // keeps a merely-strong slow peak from winning outright.
  // Tuned by sweeping both parameters against drum, four-on-the-floor and slow
  // ballad patterns at known tempos; 130-135 with sigma 0.55-0.7 all scored
  // perfectly, so these sit in the middle of that plateau rather than on an
  // edge. Raw autocorrelation always favours the half-tempo peak (1.1-1.7x
  // here), and this prior is what overrides it.
  const CENTER = 132
  const SIGMA = 0.65 // octaves
  const weighted = new Float64Array(maxLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * envRate) / lag
    const octaves = Math.log2(bpm / CENTER)
    weighted[lag] = acf[lag] * Math.exp(-0.5 * (octaves / SIGMA) * (octaves / SIGMA))
  }

  let bestLag = minLag
  for (let lag = minLag; lag <= maxLag; lag++) {
    if (weighted[lag] > weighted[bestLag]) bestLag = lag
  }
  if (acf[bestLag] <= 0) return { bpm: 0, confidence: 0 }

  // Sub-frame refinement: lags are whole frames, which quantises tempo to
  // roughly 1.5 BPM near 128.
  const refine = (lag: number): number => {
    if (lag <= minLag || lag >= maxLag) return lag
    const denom = acf[lag - 1] - 2 * acf[lag] + acf[lag + 1]
    if (denom === 0) return lag
    const delta = (0.5 * (acf[lag - 1] - acf[lag + 1])) / denom
    return Number.isFinite(delta) && Math.abs(delta) <= 1 ? lag + delta : lag
  }

  let period = refine(bestLag)

  let bpm = (60 * envRate) / period
  while (bpm < MIN_BPM) bpm *= 2
  while (bpm > MAX_BPM) bpm /= 2

  // Confidence: how far the winning peak stands above the spread of all lags.
  let total = 0
  let count = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    total += acf[lag]
    count++
  }
  const mean = count > 0 ? total / count : 0
  let variance = 0
  for (let lag = minLag; lag <= maxLag; lag++) {
    const d = acf[lag] - mean
    variance += d * d
  }
  const stdDev = Math.sqrt(variance / Math.max(1, count))
  const zScore = stdDev > 0 ? (acf[bestLag] - mean) / stdDev : 0
  const confidence = Math.max(0, Math.min(1, zScore / 8))

  return { bpm: Math.round(bpm * 10) / 10, confidence }
}

/**
 * Estimates musical key from a Harmonic Pitch Class Profile (HPCP): spectral
 * peaks are picked and frequency-refined per frame, then each peak's energy
 * is folded across the pitch classes its likely subharmonics would occupy,
 * before the resulting chroma is correlated against Krumhansl–Kessler key
 * profiles.
 *
 * The previous version summed every FFT bin's raw magnitude straight into
 * the pitch class nearest its rounded frequency. That works on an isolated
 * sine wave, but real instruments are harmonic-rich, and every one of a
 * note's overtones landed in whatever pitch class it happened to round to,
 * a single guitar note could spray energy across four or five unrelated
 * chroma bins. It also broke down at the low end: a 4096-point FFT has
 * ~10.8 Hz bins at 44.1kHz, wider than a semitone below about A2, so bass
 * content, usually the strongest cue to the tonic, was largely rounding
 * noise. Folding each peak across its candidate fundamentals (this is the
 * HPCP approach: Gómez, "Tonal Description of Music Audio Signals", 2006)
 * fixes both: a note's own harmonics reinforce its true pitch class instead
 * of each casting an independent, wrong vote, and parabolic interpolation of
 * the peak recovers sub-bin frequency accuracy cheaply, without a bigger FFT.
 */
export function detectKey(samples: Float32Array, sampleRate: number): KeyResult | null {
  const fftSize = 4096
  const hop = 2048
  if (samples.length < fftSize) return null

  const window = hannWindow(fftSize)
  const re = new Float64Array(fftSize)
  const im = new Float64Array(fftSize)

  // Peaks are hunted across a wider band than a chroma bin could ever occupy:
  // a cymbal-range peak at 4 kHz can still be the 8th harmonic of a bass note,
  // and folding it down is exactly what recovers that note. This range
  // matches the default most HPCP implementations use.
  const minBin = Math.max(2, Math.floor((40 * fftSize) / sampleRate))
  const maxBin = Math.min(fftSize / 2 - 2, Math.ceil((5000 * fftSize) / sampleRate))
  const mag = new Float64Array(maxBin + 2)

  const chroma = new Float64Array(12)
  // A second, low-register-only chroma. Krumhansl–Kessler correlation alone
  // cannot separate a relative major and minor, they share all seven notes,
  // so their rotated profiles differ only in shading, but in most tonal
  // music the tonic sits under the harmony far more than plain chroma credits
  // it for. Below here is roughly the top of a bassline in popular and
  // electronic music, clear of a chord's upper voicing.
  const bassChroma = new Float64Array(12)
  const BASS_MAX_HZ = 250
  // Weight falls off close to 1/h for most acoustic and synthesized tones,
  // not exact for any one instrument, but a reasonable stand-in across a
  // catalogue this varied.
  const MAX_HARMONIC = 8

  let analysed = 0
  for (let start = 0; start + fftSize <= samples.length; start += hop) {
    for (let i = 0; i < fftSize; i++) {
      re[i] = samples[start + i] * window[i]
      im[i] = 0
    }
    fft(re, im)

    let frameMax = 0
    for (let k = minBin; k <= maxBin + 1; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k])
      mag[k] = m
      if (m > frameMax) frameMax = m
    }
    if (frameMax <= 0) { analysed++; continue }

    // Local maxima well above the frame's noise floor, everything else is
    // spectral leakage, not a note.
    const threshold = frameMax * 0.05
    for (let k = minBin; k <= maxBin; k++) {
      const m = mag[k]
      if (m < threshold || m < mag[k - 1] || m < mag[k + 1]) continue

      // Quadratic interpolation of the log-magnitude around the peak refines
      // its frequency to sub-bin accuracy, the fix for bins being coarser
      // than a semitone in the low register.
      const a = Math.log(mag[k - 1] + 1e-9)
      const b = Math.log(m + 1e-9)
      const c = Math.log(mag[k + 1] + 1e-9)
      const denom = a - 2 * b + c
      const offset = denom !== 0 ? (0.5 * (a - c)) / denom : 0
      const freq = ((k + offset) * sampleRate) / fftSize
      if (freq <= 0) continue

      const weight = Math.log1p(m)
      if (freq < BASS_MAX_HZ) addToChroma(bassChroma, pitchClassOf(freq), weight)

      for (let h = 1; h <= MAX_HARMONIC; h++) {
        const subFreq = freq / h
        if (subFreq < 25) break
        addToChroma(chroma, pitchClassOf(subFreq), weight / h)
      }
    }
    analysed++
  }
  if (analysed === 0) return null

  let bassPeak = 0
  for (let i = 0; i < 12; i++) if (bassChroma[i] > bassPeak) bassPeak = bassChroma[i]
  if (bassPeak > 0) for (let i = 0; i < 12; i++) bassChroma[i] /= bassPeak

  // How far the bass gets to nudge the major/minor tie-break. Kept small
  // relative to the correlation's [-1, 1] range so it settles a close call
  // rather than overriding a clear chroma-profile match.
  const BASS_WEIGHT = 0.25

  let best: KeyResult | null = null
  let bestScore = -Infinity
  for (let tonic = 0; tonic < 12; tonic++) {
    for (const scale of ['major', 'minor'] as const) {
      const profile = scale === 'major' ? MAJOR_PROFILE : MINOR_PROFILE
      const rotated = new Array(12)
      for (let i = 0; i < 12; i++) rotated[i] = profile[(i - tonic + 12) % 12]

      const corr = pearson(Array.from(chroma), rotated)
      const score = corr + BASS_WEIGHT * bassChroma[tonic]
      if (score > bestScore) {
        bestScore = score
        best = {
          name: `${NOTE_NAMES[tonic]} ${scale}`,
          camelot: scale === 'major' ? CAMELOT_MAJOR[tonic] : CAMELOT_MINOR[tonic],
          tonic: NOTE_NAMES[tonic],
          tonicIndex: tonic,
          scale,
          // Reported separately from the score the bass nudged: confidence
          // describes how well the chroma itself matches a key, so a tie
          // broken by bass emphasis should not read as more certain than the
          // chroma match actually was.
          confidence: corr,
        }
      }
    }
  }

  if (best) best.confidence = Math.max(0, Math.min(1, best.confidence))
  return best
}

/**
 * Pitch shift, in semitones, caused by playing at `rate`.
 *
 * Changing playback rate without pitch correction resamples the audio, so
 * frequency scales with the rate and the shift is 12·log2(rate): 2x is exactly
 * an octave, and 2^(1/12) is one semitone. With pitch correction on, the
 * browser time-stretches instead and the pitch, and therefore the key, is
 * unchanged.
 */
export function semitonesForRate(rate: number): number {
  if (!Number.isFinite(rate) || rate <= 0) return 0
  return 12 * Math.log2(rate)
}

/**
 * Transposes a detected key by a number of semitones. The scale is unchanged;
 * only the tonic moves, which also moves its position on the Camelot wheel.
 */
export function transposeKey(key: KeyResult, semitones: number): KeyResult {
  const steps = Math.round(semitones)
  if (steps === 0) return key

  const tonic = (((key.tonicIndex + steps) % 12) + 12) % 12
  return {
    ...key,
    tonic: NOTE_NAMES[tonic],
    tonicIndex: tonic,
    name: `${NOTE_NAMES[tonic]} ${key.scale}`,
    camelot: key.scale === 'major' ? CAMELOT_MAJOR[tonic] : CAMELOT_MINOR[tonic],
  }
}

/**
 * How far the shifted pitch sits from the nearest semitone, in cents. The rate
 * slider is continuous, so most settings land between semitones and the
 * transposed key is only an approximation, this says by how much.
 */
export function centsOffset(semitones: number): number {
  return Math.round((semitones - Math.round(semitones)) * 100)
}

/** True when `code` is a position on the Camelot wheel (1-12, A or B). */
export function isCamelot(code: string): boolean {
  return /^(1[0-2]|[1-9])[AB]$/.test(code.trim().toUpperCase())
}

/**
 * Conventional key name for a Camelot code, e.g. "8A" -> "A minor". Used when
 * the key was entered by hand and so has no detected name attached.
 */
export function keyNameFromCamelot(code: string): string {
  const normalized = code.trim().toUpperCase()
  if (!isCamelot(normalized)) return ''

  const minor = normalized.endsWith('A')
  const table = minor ? CAMELOT_MINOR : CAMELOT_MAJOR
  const tonic = table.indexOf(normalized)
  if (tonic === -1) return ''
  return `${NOTE_NAMES[tonic]} ${minor ? 'minor' : 'major'}`
}

// ---------- helpers ----------

function hannWindow(size: number): Float64Array {
  const w = new Float64Array(size)
  for (let i = 0; i < size; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)))
  return w
}

/** Fractional pitch class (0–12, C = 0) for a frequency. 69 = A4 = 440 Hz. */
function pitchClassOf(freq: number): number {
  const midi = 69 + 12 * Math.log2(freq / 440)
  return ((midi % 12) + 12) % 12
}

/**
 * Spreads weight across the two chroma bins nearest a fractional pitch class
 * instead of rounding to one. Hard rounding means a note a few cents off the
 * tuning grid, routine on a real recording, can flip which bin it lands in
 * outright; splitting it proportionally keeps a small tuning or analysis
 * error a small error in the chroma too.
 */
function addToChroma(chroma: Float64Array, pitchClass: number, weight: number): void {
  const lo = Math.floor(pitchClass)
  const frac = pitchClass - lo
  const i0 = lo % 12
  const i1 = (i0 + 1) % 12
  chroma[i0] += weight * (1 - frac)
  chroma[i1] += weight * frac
}

function pearson(a: number[], b: number[]): number {
  const n = a.length
  let meanA = 0
  let meanB = 0
  for (let i = 0; i < n; i++) {
    meanA += a[i]
    meanB += b[i]
  }
  meanA /= n
  meanB /= n

  let num = 0
  let devA = 0
  let devB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA
    const db = b[i] - meanB
    num += da * db
    devA += da * da
    devB += db * db
  }

  const denom = Math.sqrt(devA * devB)
  return denom === 0 ? 0 : num / denom
}

/** In-place iterative radix-2 Cooley–Tukey FFT. Length must be a power of two. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      ;[re[i], re[j]] = [re[j], re[i]]
      ;[im[i], im[j]] = [im[j], im[i]]
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len
    const wRe = Math.cos(angle)
    const wIm = Math.sin(angle)

    for (let i = 0; i < n; i += len) {
      let curRe = 1
      let curIm = 0
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j]
        const uIm = im[i + j]
        const vRe = re[i + j + len / 2] * curRe - im[i + j + len / 2] * curIm
        const vIm = re[i + j + len / 2] * curIm + im[i + j + len / 2] * curRe

        re[i + j] = uRe + vRe
        im[i + j] = uIm + vIm
        re[i + j + len / 2] = uRe - vRe
        im[i + j + len / 2] = uIm - vIm

        const nextRe = curRe * wRe - curIm * wIm
        curIm = curRe * wIm + curIm * wRe
        curRe = nextRe
      }
    }
  }
}

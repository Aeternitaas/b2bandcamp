/**
 * Accuracy checks for the tempo and key detectors, run against synthesised
 * audio whose answers are known exactly.
 *
 *   node --run analysis-test     (see package.json)
 *
 * These exist because the numbers feed the playlist's BPM column, so a
 * regression here silently writes wrong data rather than throwing.
 */
import {
  detectTempo, detectKey, computePeaks, transposeKey, semitonesForRate, centsOffset,
} from './analysis.built.mjs'

const SR = 44100
let failures = 0
const check = (name, ok, detail) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
  if (!ok) failures++
}

/**
 * A realistic drum pattern: kick every beat, snare on 2 and 4, offbeat hats.
 * The snare accent every second beat is what pulls naive detectors to half
 * tempo — this pattern at 150 BPM used to report 75.
 */
function drumPattern(bpm, seconds = 20) {
  const n = SR * seconds
  const x = new Float32Array(n)
  const beat = (60 / bpm) * SR
  const hit = (at, freq, decay, amp, noisy) => {
    const s = Math.round(at)
    for (let j = 0; j < decay * SR && s + j < n; j++) {
      const env = Math.exp(-j / ((decay * SR) / 5))
      const tone = Math.sin((2 * Math.PI * freq * j) / SR)
      x[s + j] += amp * env * (noisy ? (Math.random() * 2 - 1) * 0.7 + tone * 0.3 : tone)
    }
  }
  const beats = Math.floor((seconds * bpm) / 60)
  for (let b = 0; b < beats; b++) {
    hit(b * beat, 55, 0.18, 1.0, false)      // kick body
    hit(b * beat, 1600, 0.012, 0.35, true)   // beater click
    if (b % 2 === 1) hit(b * beat, 200, 0.14, 0.95, true) // snare on 2 and 4
    hit(b * beat + beat / 2, 8000, 0.04, 0.3, true)       // offbeat hat
  }
  for (let i = 0; i < n; i++) x[i] += (Math.random() - 0.5) * 0.005
  return x
}

/** Sparse and genuinely slow — the case a strong tempo prior could wrongly double. */
function slowPattern(bpm, seconds = 20) {
  const n = SR * seconds
  const x = new Float32Array(n)
  const beat = (60 / bpm) * SR
  const beats = Math.floor((seconds * bpm) / 60)
  for (let b = 0; b < beats; b++) {
    const s = Math.round(b * beat)
    for (let j = 0; j < 0.25 * SR && s + j < n; j++) {
      x[s + j] += Math.exp(-j / 4000) * (Math.sin((2 * Math.PI * 90 * j) / SR) * 0.8 + (Math.random() * 2 - 1) * 0.15)
    }
  }
  return x
}

function clickTrack(bpm, seconds = 30) {
  const n = SR * seconds
  const x = new Float32Array(n)
  const period = Math.round((60 / bpm) * SR)
  for (let i = 0; i < n; i += period) {
    for (let j = 0; j < 1800 && i + j < n; j++) {
      x[i + j] += Math.exp(-j / 220) * Math.sin((2 * Math.PI * 160 * j) / SR) * 0.9
    }
  }
  for (let i = 0; i < n; i++) x[i] += (Math.random() - 0.5) * 0.01
  return x
}

function chord(freqs, seconds = 12) {
  const n = SR * seconds
  const x = new Float32Array(n)
  for (const f of freqs) for (let i = 0; i < n; i++) x[i] += Math.sin((2 * Math.PI * f * i) / SR) / freqs.length
  return x
}

console.log('tempo:')
// 174 covers the 3:2 ambiguity and 128 the frame-quantisation limit; both
// were real failures before the octave correction and parabolic refinement.
for (const bpm of [90, 100, 120, 128, 140, 174]) {
  const r = detectTempo(clickTrack(bpm), SR)
  check(`${bpm} BPM`, Math.abs(r.bpm - bpm) < 2, `got ${r.bpm}`)
}

console.log('tempo on drum patterns (octave errors):')
for (const bpm of [100, 124, 128, 140, 150, 174]) {
  const r = detectTempo(drumPattern(bpm), SR)
  const ratio = r.bpm / bpm
  const how = Math.abs(ratio - 0.5) < 0.04 ? ' (HALF)' : Math.abs(ratio - 2) < 0.04 ? ' (DOUBLE)' : ''
  check(`${bpm} BPM drums`, Math.abs(ratio - 1) < 0.04, `got ${r.bpm}${how}`)
}

console.log('tempo on slow material (must not double):')
for (const bpm of [62, 68, 75, 85, 90]) {
  const r = detectTempo(slowPattern(bpm), SR)
  check(`${bpm} BPM slow`, Math.abs(r.bpm / bpm - 1) < 0.04, `got ${r.bpm}`)
}

console.log('key:')
const cmaj = detectKey(chord([261.63, 329.63, 392.0]), SR)
check('C major triad', cmaj?.name === 'C major' && cmaj?.camelot === '8B', `got ${cmaj?.name} ${cmaj?.camelot}`)
const amin = detectKey(chord([220.0, 261.63, 329.63]), SR)
check('A minor triad', amin?.name === 'A minor' && amin?.camelot === '8A', `got ${amin?.name} ${amin?.camelot}`)

console.log('peaks:')
const peaks = computePeaks(clickTrack(120, 5), 40)
check('bucket count', peaks.length === 40)
check('normalised to 1', Math.abs(Math.max(...peaks) - 1) < 1e-6)
check('silence is safe', computePeaks(new Float32Array(0), 8).length === 8)

console.log('rate -> pitch shift:')
// 2x is exactly an octave; 2^(1/12) is exactly one semitone.
check('1.0x is no shift', semitonesForRate(1) === 0)
check('2.0x is +12 st', Math.abs(semitonesForRate(2) - 12) < 1e-9)
check('0.5x is -12 st', Math.abs(semitonesForRate(0.5) + 12) < 1e-9)
check('2^(1/12) is +1 st', Math.abs(semitonesForRate(Math.pow(2, 1 / 12)) - 1) < 1e-9)

console.log('key transposition:')
const aMinor = detectKey(chord([220.0, 261.63, 329.63]), SR)
check('baseline A minor 8A', aMinor.name === 'A minor' && aMinor.camelot === '8A')

// Up a semitone: A minor -> A# minor, which is 3A on the wheel.
const up1 = transposeKey(aMinor, 1)
check('+1 st -> A# minor 3A', up1.name === 'A# minor' && up1.camelot === '3A', `got ${up1.name} ${up1.camelot}`)

// Up a fifth (7 semitones): A minor -> E minor, 9A. Adjacent on the wheel,
// which is the whole point of Camelot notation.
const up7 = transposeKey(aMinor, 7)
check('+7 st -> E minor 9A', up7.name === 'E minor' && up7.camelot === '9A', `got ${up7.name} ${up7.camelot}`)

// A full octave must round-trip to the same pitch class.
check('+12 st is unchanged', transposeKey(aMinor, 12).camelot === aMinor.camelot)
check('-12 st is unchanged', transposeKey(aMinor, -12).camelot === aMinor.camelot)

// Wrapping below C must stay in range rather than going negative.
const cMajor = detectKey(chord([261.63, 329.63, 392.0]), SR)
const down2 = transposeKey(cMajor, -2)
check('C major -2 st -> A# major 6B', down2.name === 'A# major' && down2.camelot === '6B', `got ${down2.name} ${down2.camelot}`)

console.log('detune reporting:')
check('exact semitone has no cents', centsOffset(semitonesForRate(Math.pow(2, 1 / 12))) === 0)
check('1.10x is off-semitone', Math.abs(centsOffset(semitonesForRate(1.1))) > 5,
  `${centsOffset(semitonesForRate(1.1))} cents`)

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 1 * 0 + (failures ? 1 : 0) : 0)

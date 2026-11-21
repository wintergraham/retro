// Original chiptunes, written in a tiny text notation and compiled into timed charts
// that both the host (audio) and the phones (games) read from.
//
// Melody tokens: NOTE[:len] where len is in eighth notes (default 1), "r" is a rest.
// Drum bars: 16 chars of sixteenth steps. k = kick, s = snare, t = tom, . = nothing.
// Hi-hats are added automatically on every eighth.

export interface Note {
  t: number // seconds from song start
  d: number // seconds
  midi: number
}

export interface LeadNote extends Note {
  lane: number // 0..3
}

export interface DrumHit {
  t: number
  pad: number // 0 kick, 1 snare, 2 tom
}

export interface Chart {
  id: string
  title: string
  difficulty: string
  bpm: number
  beat: number // seconds per beat
  bar: number // seconds per bar
  bars: number
  duration: number
  lead: LeadNote[]
  bass: Note[]
  bassPath: { t: number; x: number }[] // one point per bar, x in 0..1
  drums: DrumHit[]
  hats: number[]
  arp: Note[] // CPU backing, not played by anyone
}

interface SongSource {
  id: string
  title: string
  difficulty: string
  bpm: number
  chords: string[] // one per bar
  lead: string[] // one per bar
  drums: string[] // one per bar
  bassStyle: number[][] // [semitone offset, eighths] repeated each bar
}

const NOTE_INDEX: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }

export function noteToMidi(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name)
  if (!m) throw new Error(`bad note ${name}`)
  return NOTE_INDEX[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + (Number(m[3]) + 1) * 12
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12)
}

function chordTones(chord: string): number[] {
  const m = /^([A-G][#b]?)(m?)$/.exec(chord)
  if (!m) throw new Error(`bad chord ${chord}`)
  const root = noteToMidi(`${m[1]}3`)
  return [root, root + (m[2] ? 3 : 4), root + 7]
}

function compile(src: SongSource): Chart {
  const beat = 60 / src.bpm
  const eighth = beat / 2
  const bar = beat * 4
  const bars = src.chords.length
  for (const [name, list] of [['lead', src.lead], ['drums', src.drums]] as const) {
    if (list.length !== bars) throw new Error(`${src.id}: ${name} has ${list.length} bars, chords have ${bars}`)
  }

  // Lead
  const leadRaw: Note[] = []
  src.lead.forEach((line, b) => {
    let pos = 0
    for (const tok of line.trim().split(/\s+/)) {
      const [name, len = '1'] = tok.split(':')
      const n = Number(len)
      if (name !== 'r') leadRaw.push({ t: b * bar + pos * eighth, d: n * eighth, midi: noteToMidi(name) })
      pos += n
    }
    if (pos !== 8) throw new Error(`${src.id}: lead bar ${b + 1} is ${pos} eighths`)
  })
  // Lanes follow pitch so a rising phrase walks left to right, split by note count so lanes stay balanced.
  const sorted = leadRaw.map((n) => n.midi).sort((a, b) => a - b)
  const laneOf = (midi: number) => {
    const below = sorted.indexOf(midi)
    const count = sorted.lastIndexOf(midi) - below + 1
    return Math.min(3, Math.floor(((below + count / 2) / sorted.length) * 4))
  }
  const lead = leadRaw.map((n) => ({ ...n, lane: laneOf(n.midi) }))

  // Bass + the smooth path the tilt game follows (chord root height)
  const bass: Note[] = []
  const bassPath: { t: number; x: number }[] = []
  src.chords.forEach((c, b) => {
    const root = chordTones(c)[0] - 12
    let pos = 0
    for (const [off, len] of src.bassStyle) {
      bass.push({ t: b * bar + pos * eighth, d: len * eighth * 0.9, midi: root + off })
      pos += len
    }
    bassPath.push({ t: b * bar, x: 0.15 + (((root % 12) + 12) % 12) / 11 * 0.7 })
  })

  // Drums
  const drums: DrumHit[] = []
  const hats: number[] = []
  src.drums.forEach((line, b) => {
    if (line.length !== 16) throw new Error(`${src.id}: drum bar ${b + 1} is ${line.length} steps`)
    ;[...line].forEach((ch, i) => {
      const pad = 'kst'.indexOf(ch)
      if (pad >= 0) drums.push({ t: b * bar + (i * eighth) / 2, pad })
    })
    for (let i = 0; i < 8; i++) hats.push(b * bar + i * eighth)
  })

  // Arpeggio backing: sixteenths cycling root/3rd/5th/octave
  const arp: Note[] = []
  src.chords.forEach((c, b) => {
    const tones = chordTones(c).map((m) => m + 24)
    const cycle = [tones[0], tones[1], tones[2], tones[0] + 12]
    for (let i = 0; i < 16; i++) arp.push({ t: b * bar + (i * eighth) / 2, d: eighth / 2 * 0.8, midi: cycle[i % 4] })
  })

  return {
    id: src.id,
    title: src.title,
    difficulty: src.difficulty,
    bpm: src.bpm,
    beat,
    bar,
    bars,
    duration: bars * bar,
    lead,
    bass,
    bassPath,
    drums,
    hats,
    arp,
  }
}

// --- Pixel Highway: A minor, driving ------------------------------------------------
const highwayVerse = {
  chords: ['Am', 'F', 'C', 'G', 'Am', 'F', 'G', 'E'],
  lead: [
    'A4:2 C5 E5 D5:2 C5 B4',
    'A4:3 F4 A4 C5:3',
    'G4:2 C5 E5 G5:2 E5 C5',
    'D5:4 B4:2 G4:2',
    'A4:2 C5 E5 A5:2 G5 E5',
    'F5:2 E5 D5 C5:2 A4:2',
    'B4 C5 D5 G5 F5:2 D5:2',
    'E5:4 G#4:2 B4:2',
  ],
  drums: [
    'k.......s.......',
    'k.......s.......',
    'k.....k.s.......',
    'k.......s...s...',
    'k.......s.......',
    'k.......s.......',
    'k.....k.s.......',
    'k...s...t.t.t.t.',
  ],
}
const highwayChorus = {
  chords: ['F', 'G', 'Em', 'Am', 'F', 'G', 'E', 'Am'],
  lead: [
    'C6:2 A5 F5 C5:2 F5:2',
    'D6:2 B5 G5 D5:2 G5:2',
    'E5 G5 B5 E6 D6:2 B5:2',
    'C6:3 B5 A5:4',
    'A5 G5 F5 A5 C6:2 A5:2',
    'B5 A5 G5 B5 D6:2 B5:2',
    'G#5:2 E5:2 B5:2 G#5:2',
    'A5:6 r:2',
  ],
  drums: [
    'k...s...k.k.s...',
    'k...s...k.k.s...',
    'k...s...k.k.s...',
    'k...s...k.k.s.s.',
    'k...s...k.k.s...',
    'k...s...k.k.s...',
    'k...s...k.k.s...',
    'k...s...t.t.t.k.',
  ],
}

// --- Sugar Rush: C major, bouncy and easier ----------------------------------------
const sugarA = {
  chords: ['C', 'C', 'F', 'G', 'C', 'Am', 'F', 'G'],
  lead: [
    'E5:2 G5:2 C6:2 G5:2',
    'A5:2 G5:2 E5:4',
    'F5:2 A5:2 C6:2 A5:2',
    'G5:4 D5:4',
    'E5:2 G5:2 C6:2 E6:2',
    'D6:2 C6:2 A5:4',
    'F5:2 G5:2 A5:2 C6:2',
    'B5:4 G5:4',
  ],
  drums: [
    'k.......s.......',
    'k.......s.......',
    'k.......s.......',
    'k.......s.......',
    'k.......s.......',
    'k.......s.......',
    'k.......s.......',
    'k.......s...t.t.',
  ],
}
const sugarB = {
  chords: ['Am', 'F', 'C', 'G', 'Am', 'F', 'G', 'C'],
  lead: [
    'A5 B5 C6:2 B5:2 A5:2',
    'F5 G5 A5:2 C6:4',
    'E5 F5 G5:2 C6:2 G5:2',
    'D5:2 G5:2 B5:4',
    'C6 B5 A5:2 E5:2 A5:2',
    'C6 A5 F5:2 A5:2 C6:2',
    'D6:2 B5:2 G5:2 D6:2',
    'C6:6 r:2',
  ],
  drums: [
    'k...s...k...s...',
    'k...s...k...s...',
    'k...s...k...s...',
    'k...s...k...s...',
    'k...s...k...s...',
    'k...s...k...s...',
    'k...s...k...s...',
    'k...s...t.t.t.t.',
  ],
}

// --- Moonlit Arcade: F major, laid back ---------------------------------------------
const moonA = {
  chords: ['F', 'Am', 'Bb', 'C', 'F', 'Am', 'Bb', 'C'],
  lead: [
    'A4:2 C5:2 F5:4',
    'E5:2 C5:2 A4:4',
    'D5:2 F5:2 Bb5:2 A5:2',
    'G5:4 E5:2 C5:2',
    'A4:2 C5:2 F5:3 G5',
    'A5:2 G5:2 E5:4',
    'F5:2 D5:2 Bb4:2 D5:2',
    'C5:6 r:2',
  ],
  drums: [
    'k.......s.......',
    'k.......s.......',
    'k.....k.s.......',
    'k.......s.......',
    'k.......s.......',
    'k.......s.......',
    'k.....k.s.......',
    'k.......s...t.t.',
  ],
}
const moonB = {
  chords: ['Dm', 'Bb', 'F', 'C', 'Dm', 'Bb', 'Gm', 'C'],
  lead: [
    'D5:3 E5 F5:2 A5:2',
    'Bb5:2 A5:2 F5:4',
    'C5:2 F5:2 A5:2 C6:2',
    'G5:6 r:2',
    'F5:2 E5:2 D5:2 A4:2',
    'Bb4:2 D5:2 F5:4',
    'G5:2 F5:2 D5:2 Bb4:2',
    'C5:4 E5:2 G5:2',
  ],
  drums: [
    'k.......s.......',
    'k.....k.s.......',
    'k.......s.......',
    'k.....k.s...s...',
    'k.......s.......',
    'k.....k.s.......',
    'k.......s.......',
    'k...s...t...t...',
  ],
}
const moonEnd = { ...moonA, chords: [...moonA.chords.slice(0, 7), 'F'], lead: [...moonA.lead.slice(0, 7), 'F5:6 r:2'] }

// --- Turbo Circuit: D major, fast, sixteenth-note runs ------------------------------
const turboA = {
  chords: ['D', 'A', 'Bm', 'G', 'D', 'A', 'G', 'A'],
  lead: [
    'D5 F#5 A5 D6:2 A5 F#5 A5',
    'C#6:.5 D6:.5 C#6 A5 E5:2 A5:2 C#6',
    'B5 F#5 D5 F#5 B5:2 D6:2',
    'G5:.5 A5:.5 B5:.5 C#6:.5 D6:2 B5 G5 D5:2',
    'D5 F#5 A5 D6:2 E6 F#6:2',
    'E6 C#6 A5 E5 A5:.5 B5:.5 C#6:.5 E6:.5 C#6:2',
    'B5:.5 A5:.5 G5:.5 F#5:.5 G5 B5 D6:2 B5:2',
    'A5:2 E5:.5 F#5:.5 G5:.5 A5:.5 C#6:2 E6:2',
  ],
  drums: [
    'k...s...k.k.s...',
    'k...s...k.k.s..k',
    'k...s...k.k.s...',
    'k...s.k.k...s.s.',
    'k...s...k.k.s...',
    'k...s...k.k.s..k',
    'k...s...k.k.s...',
    'k.k.s.s.t.t.t.t.',
  ],
}
const turboB = {
  chords: ['Bm', 'G', 'D', 'A', 'Bm', 'G', 'Em', 'A'],
  lead: [
    'B5:.5 C#6:.5 D6:.5 F#6:.5 D6:.5 C#6:.5 B5 F#5:2 B5:2',
    'G5:.5 B5:.5 D6:.5 G6:.5 D6 B5 G5:2 B5:2',
    'A5:.5 F#5:.5 D5:.5 F#5:.5 A5 D6 F#6:2 D6:2',
    'E6:2 C#6:.5 B5:.5 A5:.5 G5:.5 E5:2 A5:2',
    'D6 B5 F#5 B5 D6:.5 E6:.5 F#6:.5 E6:.5 D6:2',
    'B5 G5 D5 G5 B5:.5 C#6:.5 D6:.5 B5:.5 G5:2',
    'E5:.5 G5:.5 B5:.5 E6:.5 B5:.5 G5:.5 E5 G5:2 B5:2',
    'C#6:2 A5:2 E6:.5 C#6:.5 A5:.5 E5:.5 A5:2',
  ],
  drums: [
    'k.k.s...k.k.s...',
    'k.k.s...k.k.s.k.',
    'k.k.s...k.k.s...',
    'k.k.s.k.k...s.s.',
    'k.k.s...k.k.s...',
    'k.k.s...k.k.s.k.',
    'k.k.s...k.k.s...',
    'k.s.k.s.t.t.ttt.',
  ],
}
const turboBreak = {
  chords: ['G', 'A', 'F#m', 'Bm', 'G', 'A', 'D', 'D'],
  lead: [
    'B5:3 A5 G5:2 D5:2',
    'C#6:3 B5 A5:2 E5:2',
    'F#5:2 A5:2 C#6:2 F#6:2',
    'D6:4 B5:2 F#5:2',
    'G5:2 B5:2 D6:2 G6:2',
    'E6:2 C#6:2 A5:2 E6:2',
    'F#6:2 E6 D6 A5:2 F#5:2',
    'D6:.5 C#6:.5 B5:.5 A5:.5 G5:.5 F#5:.5 E5:.5 D5:.5 A5:4',
  ],
  drums: [
    'k.......s.......',
    'k.....k.s.......',
    'k.......s.......',
    'k.....k.s...s...',
    'k...s...k...s...',
    'k...s...k...s...',
    'k...s...k.k.s...',
    'k.k.s.s.t.t.t.t.',
  ],
}
const turboEnd = {
  ...turboB,
  chords: [...turboB.chords.slice(0, 7), 'D'],
  lead: [...turboB.lead.slice(0, 7), 'D6:.5 A5:.5 F#5:.5 D5:.5 D6:6'],
  drums: [...turboB.drums.slice(0, 7), 'k.k.s.s.t.t.k...'],
}

// --- Byte King: C minor boss battle --------------------------------------------------
const bossA = {
  chords: ['Cm', 'Cm', 'Ab', 'G', 'Cm', 'Cm', 'Ab', 'G'],
  lead: [
    'C5 C5 Eb5 C5 G5:2 F#5 G5',
    'Ab5:2 G5 F5 Eb5:2 D5:2',
    'C5 Eb5 Ab5 C6 Bb5:2 Ab5:2',
    'G5:2 B4 D5 G5:2 F5 D5',
    'C5 C5 Eb5 C5 Bb5:2 Ab5 Bb5',
    'D6:2 Eb6 D6 G5:2 Eb5:2',
    'F5 Ab5 C6 Eb6 D6:2 C6 B5',
    'G5:4 B5:2 D6:2',
  ],
  drums: [
    'k.k.s...k.k.s...',
    'k.k.s...k.k.s...',
    'k.k.s...k.k.s...',
    'k.k.s...t.t.s...',
    'k.k.s...k.k.s...',
    'k.k.s...k.k.s...',
    'k.k.s...k.k.s...',
    'k...s...t.t.t.s.',
  ],
}
const bossB = {
  chords: ['Fm', 'Cm', 'Bb', 'Eb', 'Ab', 'Fm', 'G', 'G'],
  lead: [
    'F5:.5 G5:.5 Ab5 C6:2 Ab5 F5 C5:2',
    'Eb5:.5 F5:.5 G5 C6:2 G5 Eb5 C5:2',
    'D5 F5 Bb5 D6 C6 Bb5 F5:2',
    'Eb6:3 D6 Bb5:2 G5:2',
    'Ab5 C6 Eb6 G6 F6:2 Eb5:2',
    'F5 Ab5 C6 F6 Eb6:2 C6:2',
    'B5 D6 G6:2 F6 D6 B5 G5',
    'G5:.5 Ab5:.5 G5:.5 F#5:.5 G5:2 D6:2 G6:2',
  ],
  drums: [
    'k...s...k.k.s...',
    'k...s...k.k.s..k',
    'k...s...k.k.s...',
    'k...s.k.k...s...',
    'k...s...k.k.s...',
    'k...s...k.k.s..k',
    'k.k.s.k.k.k.s.k.',
    'k.s.k.s.t.t.t.t.',
  ],
}
const bossC = {
  chords: ['Cm', 'Ab', 'Fm', 'G', 'Cm', 'Ab', 'Fm', 'G'],
  lead: [
    'C6:2 G5:2 Eb5:2 C5:2',
    'Eb6:2 Ab5:2 Eb5:2 C5:2',
    'C6:2 Ab5:2 F5:2 C5:2',
    'B5:2 D6:2 F6:2 D6:2',
    'Eb6 D6 C6 G5 G6 F6 Eb6 D6',
    'Eb6 C6 Ab5 Eb5 G6 Eb6 D6 Bb5',
    'F6 C6 Ab5 F5 Ab5 C6 F6 Ab6',
    'G6:4 r:4',
  ],
  drums: [
    'k..tk..ts..tk.t.',
    'k..tk..ts..tk.t.',
    'k..tk..ts..tk.t.',
    't.t.t.t.s.s.s.s.',
    'k.t.s.t.k.t.s.t.',
    'k.t.s.t.k.t.s.t.',
    'k.t.s.t.k.t.s.t.',
    'k...k...t.t.t.t.',
  ],
}
const bossEnd = {
  ...bossB,
  chords: [...bossB.chords.slice(0, 7), 'Cm'],
  lead: [...bossB.lead.slice(0, 7), 'C6:4 G5 Eb5 C5:2'],
  drums: [...bossB.drums.slice(0, 7), 'k.k.s.s.t.t.k...'],
}

function join(...sections: { chords: string[]; lead: string[]; drums: string[] }[]) {
  return {
    chords: sections.flatMap((s) => s.chords),
    lead: sections.flatMap((s) => s.lead),
    drums: sections.flatMap((s) => s.drums),
  }
}

export const SONGS: Chart[] = [
  compile({
    id: 'sugar-rush',
    title: 'SUGAR RUSH',
    difficulty: 'EASY',
    bpm: 120,
    ...join(sugarA, sugarB, sugarA, sugarB),
    bassStyle: [[0, 2], [7, 2], [12, 2], [7, 2]],
  }),
  compile({
    id: 'pixel-highway',
    title: 'PIXEL HIGHWAY',
    difficulty: 'NORMAL',
    bpm: 128,
    ...join(highwayVerse, highwayChorus, highwayVerse, highwayChorus),
    bassStyle: [[0, 1], [0, 1], [12, 1], [0, 1], [7, 1], [0, 1], [12, 1], [7, 1]],
  }),
  compile({
    id: 'moonlit-arcade',
    title: 'MOONLIT ARCADE',
    difficulty: 'EASY',
    bpm: 100,
    ...join(moonA, moonB, moonEnd),
    bassStyle: [[0, 4], [7, 2], [12, 2]],
  }),
  compile({
    id: 'byte-king',
    title: 'BYTE KING',
    difficulty: 'NORMAL',
    bpm: 132,
    ...join(bossA, bossB, bossC, bossEnd),
    bassStyle: [[0, 1], [0, 1], [12, 1], [0, 1], [0, 1], [12, 1], [10, 1], [7, 1]],
  }),
  compile({
    id: 'turbo-circuit',
    title: 'TURBO CIRCUIT',
    difficulty: 'HARD',
    bpm: 156,
    ...join(turboA, turboB, turboBreak, turboA, turboEnd),
    bassStyle: [[0, 1], [12, 1], [0, 1], [12, 1], [7, 1], [12, 1], [5, 1], [7, 1]],
  }),
]

export const songById = (id: string) => SONGS.find((s) => s.id === id) ?? SONGS[0]

/** Bass-track x position (0..1) at song time t: eases between chord roots with a gentle wobble. */
export function bassTrackX(chart: Chart, t: number): number {
  const path = chart.bassPath
  const i = Math.max(0, Math.min(path.length - 1, Math.floor(t / chart.bar)))
  const cur = path[i].x
  const next = path[Math.min(path.length - 1, i + 1)].x
  // Glide into the next root over the last beat of the bar.
  const intoBar = t - i * chart.bar
  const glide = Math.max(0, (intoBar - (chart.bar - chart.beat)) / chart.beat)
  const eased = (1 - Math.cos(Math.PI * Math.min(1, glide))) / 2
  const wobble = Math.sin((t / chart.beat) * Math.PI) * 0.06
  return Math.max(0.08, Math.min(0.92, cur + (next - cur) * eased + wobble))
}

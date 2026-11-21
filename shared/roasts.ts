import type { ChannelId } from './protocol'

// Friendly trash talk. Keep it about the playing, never the person.

const LIVE: Record<ChannelId | 'any', string[]> = {
  any: [
    'is playing a different song. Possibly a better one.',
    'has entered their experimental jazz era',
    'is reading the notes like they owe them money',
    'just invented a new time signature',
    'is buffering',
    'is on airplane mode',
    'is playing with the lid still on',
    'is doing great (this is a lie)',
  ],
  lead: [
    'is tapping tiles like they\'re popping bubble wrap',
    'is freestyling the melody. Nobody asked.',
    'thinks the tiles are a suggestion',
  ],
  bass: [
    'has the bass so flat it\'s a pancake',
    'is steering like it\'s a shopping trolley',
    'turned the bassline into whale noises',
  ],
  drums: [
    'is keeping time with a sundial',
    'is drumming fashionably late',
    'hit the snare once and called it a day',
  ],
}

const WORST = [
  'Played every note. Just not the ones in the song.',
  'Rhythm is a dancer. You are not.',
  'The band would like to speak to you after class.',
  'Brave of you to play it like that.',
  'Gave 110%. Unfortunately in the wrong direction.',
  'Your cartridge needs blowing on.',
  'Music critics are calling it "a choice".',
]

const BEST = [
  'Carried the band so hard they owe you rent.',
  'Annoyingly good. Please touch grass.',
  'The other two were just your backing track.',
  'Suspiciously good. We\'re checking for cheats.',
  'Actual musician detected. Disgusting.',
]

const MID = [
  'Perfectly, aggressively average.',
  'Present. Technically.',
  'Not the hero, not the villain. The extra.',
  'Did fine. Nobody will write songs about it.',
]

const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]

export function liveRoast(channel: ChannelId): string {
  return pick(Math.random() < 0.5 ? LIVE[channel] : LIVE.any)
}

export function resultRoast(tier: 'best' | 'worst' | 'mid'): string {
  return pick(tier === 'best' ? BEST : tier === 'worst' ? WORST : MID)
}

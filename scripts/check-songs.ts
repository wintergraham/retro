import { SONGS } from '../shared/songs.ts'

for (const s of SONGS) {
  console.log(`${s.title}: ${s.bars} bars, ${s.duration.toFixed(1)}s, lead ${s.lead.length}, drums ${s.drums.length}`)
  console.log('  lanes', [0, 1, 2, 3].map((l) => s.lead.filter((n) => n.lane === l).length).join('/'))
}

'use strict'

// Bot vs bot on a local flying-squid server, with a server-side referee that
// checks every hit the way an anticheat would: reach from the attacker's eye
// to the victim's hitbox, whether the attacker's last sent rotation actually
// points at the hitbox, and the time between attacks.
//
//   node test/botfight.js [seconds] [profileA] [profileB]
//
// flying-squid only speaks up to 1.21.4 and has simplified damage/knockback,
// so this tests the bot's behaviour and legality, not exact vanilla balance.

const mcServer = require('flying-squid')
const { Vec3 } = require('vec3')
const { createMimic } = require('../src/index')
const G = require('../src/combat/geometry')

const SECONDS = Number(process.argv[2] || 60)
const PROFILE_A = process.argv[3] || 'pro'
const PROFILE_B = process.argv[4] || 'good'
const VERSION = process.env.ARENA_VERSION || '1.21.1'
const PORT = 25599

const serv = mcServer.createMCServer({
  port: PORT,
  'online-mode': false,
  motd: 'arena',
  'max-players': 10,
  logging: false,
  gameMode: 0,
  difficulty: 1,
  generation: { name: 'superflat', options: { worldHeight: 80 } },
  kickTimeout: 30000,
  plugins: {},
  modpe: false,
  'view-distance': 4,
  'player-list-text': { header: { text: '' }, footer: { text: '' } },
  'everybody-op': true,
  'max-entities': 100,
  version: VERSION
})

const ref = {} // username -> stats
const look = {} // username -> last rotation sent (degrees, notchian)

serv.on('newPlayer', player => {
  const name = player._client.username
  player.entityType = serv.registry.entitiesByName.player.id // flying-squid leaves this unset (spawns players as type 0)
  ref[name] = { hits: 0, reach: [], offAim: 0, offAimLoose: 0, intervals: [], last: 0, deaths: 0, rotDeltas: [] }
  player._client.on('packet', (data, meta) => {
    if (data.yaw === undefined || !/look|position_look/.test(meta.name)) return
    const prev = look[name]
    look[name] = { yaw: data.yaw, pitch: data.pitch }
    if (prev) ref[name].rotDeltas.push(data.yaw - prev.yaw, data.pitch - prev.pitch)
  })
  player.on('attack', (data) => {
    const { attackedEntity } = data
    // flying-squid's knockback is several times vanilla's; use vanilla's
    // 0.4 blocks/tick horizontal and 0.4 up (it takes blocks per second).
    const d = attackedEntity.position.minus(player.position)
    const n = Math.hypot(d.x, d.z) || 1
    data.velocity = new Vec3(d.x / n * 8, 8, d.z / n * 8)
    const r = ref[name]
    const now = Date.now()
    if (r.last) r.intervals.push(now - r.last)
    r.last = now
    r.hits++
    const eye = player.position.offset(0, 1.62, 0)
    const box = G.hitbox({ width: 0.6, height: 1.8 }, attackedEntity.position)
    r.reach.push(G.pointBoxDistance(eye, box))
    const l = look[name]
    if (l) {
      // notchian -> mineflayer angles
      const yaw = Math.PI - l.yaw * Math.PI / 180
      const pitch = -l.pitch * Math.PI / 180
      const t = G.rayBox(eye, G.lookVector(yaw, pitch), box)
      if (t === null || t > 3.0) r.offAim++
      // Anticheats allow a little slack for the victim's movement between
      // ticks (Grim-style 0.1 expansion); count against that too.
      const loose = { min: box.min.offset(-0.1, -0.1, -0.1), max: box.max.offset(0.1, 0.1, 0.1) }
      const t2 = G.rayBox(eye, G.lookVector(yaw, pitch), loose)
      if (t2 === null || t2 > 3.0) r.offAimLoose++
    }
  })
  player.on('died', () => { ref[name].deaths++ })
})

const A = 'Mimic_' + PROFILE_A
const B = 'Rival_' + PROFILE_B
const bots = []
setTimeout(() => {
  bots.push(createMimic({ profile: PROFILE_A, connection: { host: '127.0.0.1', port: PORT, username: A, version: VERSION }, log: false }))
  setTimeout(() => bots.push(createMimic({ profile: PROFILE_B, connection: { host: '127.0.0.1', port: PORT, username: B, version: VERSION }, log: false })), 1500)
}, 1500)

// Put them 12 blocks apart facing away from each other once both are in, so
// the fight starts with target acquisition and a chase.
setTimeout(() => {
  const ps = serv.players
  if (ps.length < 2) { console.log('bots did not join'); process.exit(1) }
  ps[0].teleport(new Vec3(0.5, ps[0].position.y, 0.5))
  ps[1].teleport(new Vec3(0.5, ps[1].position.y, 12.5))
  // flying-squid only shows players to each other after they move; nudge it.
  setTimeout(() => ps.forEach(p => p.updateAndSpawn()), 500)
  if (process.env.ARENA_KIT !== 'hand') {
    const Item = require('prismarine-item')(serv.registry)
    const give = (p, slot, name, n = 1) => p.inventory.updateSlot(slot, new Item(serv.registry.itemsByName[name].id, n))
    for (const p of ps) {
      give(p, 36, 'diamond_sword')
      give(p, 5, 'diamond_helmet')
      give(p, 6, 'diamond_chestplate')
      give(p, 7, 'diamond_leggings')
      give(p, 8, 'diamond_boots')
    }
  }
}, 6000)

function pct (arr, p) {
  if (!arr.length) return NaN
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor(p * s.length))]
}

function stepOf (sens) { const f = sens * 0.6 + 0.2; return f * f * f * 8 * 0.15 }

setTimeout(() => {
  console.log(`\n=== ${SECONDS}s arena: ${A} vs ${B} (MC ${VERSION}) ===`)
  for (const { bot, brain, cfg } of bots) {
    const r = ref[bot.username] || {}
    const step = stepOf(cfg.aim.sensitivity)
    const off = (r.rotDeltas || []).filter(d => d !== 0 && Math.abs(d / step - Math.round(d / step)) > 1e-3).length
    console.log(`\n${bot.username}`)
    console.log(`  bot's view:     ${brain.statLine()}`)
    console.log(`  server saw:     ${r.hits} hits, deaths ${r.deaths}`)
    console.log(`  reach (blocks): median ${pct(r.reach, 0.5)?.toFixed(2)}  p95 ${pct(r.reach, 0.95)?.toFixed(2)}  max ${Math.max(...(r.reach.length ? r.reach : [NaN])).toFixed(2)}  (limit 3.00)`)
    console.log(`  hits where last sent rotation missed the hitbox: ${r.offAim} exact, ${r.offAimLoose} with 0.1 slack`)
    console.log(`  ms between attacks: min ${pct(r.intervals, 0)}  median ${pct(r.intervals, 0.5)}`)
    console.log(`  rotation packets off the mouse grid: ${off} of ${(r.rotDeltas || []).length}`)
  }
  process.exit(0)
}, (SECONDS + 7) * 1000)

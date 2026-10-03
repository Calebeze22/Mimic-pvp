#!/usr/bin/env node
'use strict'

// Starts the arena server (set up by arena/setup.js), builds the arena, and
// runs the bot next to it. Then join localhost from your Minecraft client
// and type in chat:
//   !duel [casual|good|pro]   fresh diamond kits, 3-2-1, fight
//   !stop                     end the round
//   !score                    rounds won so far
//
//   node arena/run.js --owner <your Minecraft name> [--profile pro] [--bot Mimic] [--memory 2G]
//
// Real-client mode: the bot plays a real Minecraft window, on this computer
// or another one, and is started separately (see README). The arena then
// talks to it through its spectator connection, MimicEyes.
//   node arena/run.js --owner <name> --client [bot's Minecraft name]

const fs = require('fs')
const path = require('path')
const readline = require('readline')
const { spawn } = require('child_process')
const { Rcon } = require('./rcon')
const { chatLine, deathLine, grimLine, strip } = require('./logparse')
const { createMimic } = require('../src/index')

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean))
const OWNER = args.owner
// Real-client mode. With no name given, the bot is whoever else joins first.
const CLIENT = !!args.client
let BOT = CLIENT ? (typeof args.client === 'string' ? args.client : null) : (args.bot || 'Mimic')
const EYES = 'MimicEyes'
const DIR = path.join(__dirname, 'server')
if (!OWNER) { console.error('usage: node arena/run.js --owner <your Minecraft name>'); process.exit(1) }
if (!fs.existsSync(path.join(DIR, 'arena.json')) || !fs.existsSync(path.join(DIR, 'paper.jar'))) {
  console.error('Run "npm run arena:setup" first.')
  process.exit(1)
}
const cfg = JSON.parse(fs.readFileSync(path.join(DIR, 'arena.json'), 'utf8'))

const OWNER_SPOT = '-6.5 -60 0.5 -90 0' // facing east
const BOT_SPOT = '6.5 -60 0.5 90 0' // facing west
const KIT = [
  ['armor.head', 'diamond_helmet'], ['armor.chest', 'diamond_chestplate'],
  ['armor.legs', 'diamond_leggings'], ['armor.feet', 'diamond_boots'], ['hotbar.0', 'diamond_sword']
]

let rcon = null
let mimic = null // the in-process bot (not used in real-client mode)
let eyesOnline = false
let profile = args.profile || 'pro'
let round = null
const score = {}
const pts = name => score[name] || 0
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))
const say = (text, color = 'gray') => rcon && rcon.send(`tellraw @a ${JSON.stringify({ text, color })}`).catch(() => {})
// Orders to a real-client bot, as system messages only its eyes receive.
const tell = cmd => rcon && rcon.send(`tellraw ${EYES} ${JSON.stringify({ text: 'mimic:' + cmd })}`).catch(() => {})

// ---------------------------------------------------------------- server

const server = spawn('java', [`-Xms1G`, `-Xmx${args.memory || '2G'}`, '-jar', 'paper.jar', '--nogui'], { cwd: DIR })
server.on('exit', code => { console.log(`server exited (${code})`); process.exit(code || 0) })
server.on('error', e => { console.error(`could not start java: ${e.message}`); process.exit(1) })
server.stderr.pipe(process.stderr)
readline.createInterface({ input: server.stdout }).on('line', line => {
  console.log(line)
  onServerLine(line).catch(e => console.error('[arena]', e.message))
})
readline.createInterface({ input: process.stdin }).on('line', l => server.stdin.write(l + '\n'))
process.on('SIGINT', () => { console.log('stopping server...'); server.stdin.write('stop\n') })

async function onServerLine (line) {
  if (!rcon && /Done \([\d.]+s\)!/.test(strip(line))) return onReady()

  const g = grimLine(line)
  if (g && round) (round.flags[g.player] ||= []).push(`${g.check} x${g.vl}`)

  if (CLIENT && rcon) await clientPresence(strip(line))

  const d = BOT && deathLine(line, [OWNER, BOT])
  if (d && round) return endRound(d.victim === BOT ? OWNER : BOT, d.text)

  const c = chatLine(line)
  if (!c || c.user !== OWNER) return
  const [cmd, arg] = c.msg.split(/\s+/)
  if (cmd === '!duel') return startRound(arg)
  if (cmd === '!stop') return endRound(null, 'stopped')
  if (cmd === '!score') return say(`${OWNER} ${pts(OWNER)} - ${pts(BOT)} ${BOT || 'bot'}`, 'gold')
}

// Real-client mode: notice the eyes and the bot's window coming and going.
async function clientPresence (line) {
  const j = /: (\w{3,16}) joined the game/.exec(line)
  const l = /: (\w{3,16}) left the game/.exec(line)
  if (j && j[1] === EYES) {
    eyesOnline = true
    await wait(1000)
    // The eyes watch from above the arena, invisible to players.
    await rcon.send(`gamemode spectator ${EYES}`).catch(() => {})
    await rcon.send(`tp ${EYES} 0 -50 0 0 90`).catch(() => {})
    if (BOT) await tell(`you ${BOT}`)
    console.log(`[arena] the bot's eyes are connected${BOT ? '' : `; waiting for the bot's Minecraft window to join`}`)
  } else if (j && j[1] !== OWNER && !BOT) {
    BOT = j[1]
    await tell(`you ${BOT}`)
    console.log(`[arena] ${BOT} is the bot's window. Click into it and press F8.`)
  }
  if (l && l[1] === EYES) {
    eyesOnline = false
    if (round) endRound(null, 'the bot disconnected')
  }
  if (l && l[1] === BOT && round) endRound(null, `${BOT} left`)
}

async function onReady () {
  rcon = await new Rcon('127.0.0.1', cfg.rconPort, cfg.rconPassword).connect()
  const cmds = [
    'forceload add -32 -32 32 32',
    // Gamerule names changed across versions; the ones that don't exist just error.
    'gamerule doMobSpawning false', 'gamerule spawn_mobs false',
    'gamerule doDaylightCycle false', 'gamerule advance_time false',
    'gamerule doWeatherCycle false', 'gamerule advance_weather false',
    'gamerule doImmediateRespawn true', 'gamerule immediate_respawn true',
    'gamerule announceAdvancements false', 'gamerule show_advancement_messages false',
    'gamerule pvp true',
    'time set day', 'weather clear',
    'setworldspawn 0 -60 0', 'spawnpoint @a 0 -60 0',
    `op ${OWNER}`
  ]
  if (!cfg.built) {
    cmds.push(
      'fill -17 -61 -17 17 -55 17 minecraft:glass hollow',
      'fill -16 -55 -16 16 -55 16 minecraft:air',
      'fill -16 -61 -16 16 -61 16 minecraft:smooth_stone',
      'fill -16 -60 -16 16 -56 16 minecraft:air',
      'fill 0 -61 -16 0 -61 16 minecraft:red_concrete' // centre line
    )
  }
  for (const c of cmds) await rcon.send(c).catch(() => {})
  if (!cfg.built) { cfg.built = true; fs.writeFileSync(path.join(DIR, 'arena.json'), JSON.stringify(cfg, null, 2)) }
  if (CLIENT) {
    console.log(`\n[arena] Ready (real-client mode). Start the bot on the computer that runs its Minecraft window:` +
      `\n[arena]   node src/index.js --client --host <this computer's address> --owner ${OWNER}` +
      `\n[arena] join this server from that window${BOT ? ' as ' + BOT : ' with your second account'}, click into it and press F8.` +
      `\n[arena] Then join as ${OWNER} and type !duel in chat.\n`)
  } else {
    await startBot(profile)
    console.log(`\n[arena] Ready. Join localhost:${cfg.port} as ${OWNER} and type !duel in chat.\n`)
  }
}

// ---------------------------------------------------------------- bot

function startBot (p) {
  return new Promise(resolve => {
    if (mimic) mimic.bot.quit()
    profile = p
    mimic = createMimic({
      profile,
      connection: { host: '127.0.0.1', port: cfg.port, username: BOT, version: cfg.mc || '26.1' },
      targeting: { auto: false, owner: OWNER }
    })
    mimic.bot.once('spawn', () => setTimeout(resolve, 1000))
    mimic.bot.on('end', () => { if (round) endRound(null, 'bot disconnected') })
  })
}

// ---------------------------------------------------------------- rounds

async function startRound (p) {
  if (round) return say('A round is already running. !stop ends it.')
  if (p && !['casual', 'good', 'pro'].includes(p)) return say('Profiles: casual, good, pro')
  if (CLIENT) {
    if (p) await say('In real-client mode the profile is set when starting the bot (--profile).')
    if (!eyesOnline) return say('The bot isn\'t running. Start it on its computer: node src/index.js --client --host <this computer\'s address>', 'red')
    if (!BOT) return say('The bot\'s Minecraft window hasn\'t joined yet.', 'red')
  } else if (p && p !== profile) { await say(`Switching ${BOT} to ${p}...`); await startBot(p) }
  round = { id: Date.now(), flags: {}, started: false }
  const r = round
  for (const who of [OWNER, BOT]) {
    for (const c of ['clear', 'effect clear']) await rcon.send(`${c} ${who}`)
    for (const [slot, item] of KIT) await rcon.send(`item replace entity ${who} ${slot} with minecraft:${item}`)
    await rcon.send(`effect give ${who} minecraft:instant_health 1 10 true`)
    await rcon.send(`effect give ${who} minecraft:saturation 1 20 true`)
    await rcon.send(`gamemode survival ${who}`)
  }
  await rcon.send(`tp ${OWNER} ${OWNER_SPOT}`)
  if (CLIENT) {
    // Hands off the mouse while the game applies the teleport, then tell
    // the bot exactly where its camera now faces.
    await tell('hold')
    await wait(300)
    await rcon.send(`tp ${BOT} ${BOT_SPOT}`)
    await wait(400)
    const [, , , yaw, pitch] = BOT_SPOT.split(' ')
    await tell(`release ${yaw} ${pitch}`)
  } else {
    await rcon.send(`tp ${BOT} ${BOT_SPOT}`)
    mimic.brain.resetStats()
  }
  for (const n of ['3', '2', '1']) {
    await rcon.send(`title ${OWNER} title ${JSON.stringify({ text: n, color: 'yellow' })}`)
    await wait(1000)
    if (round !== r) return
  }
  await rcon.send(`title ${OWNER} title ${JSON.stringify({ text: 'Fight!', color: 'red' })}`)
  r.started = true
  if (CLIENT) await tell(`duel ${OWNER}`)
  else mimic.brain.duel(OWNER)
}

async function endRound (winner, why) {
  const r = round
  if (!r) return
  round = null
  if (CLIENT) await tell('end') // the bot posts its own hit stats in chat
  else if (mimic) mimic.brain.endDuel()
  if (winner) score[winner] = pts(winner) + 1
  await say(winner ? `${winner} wins (${why}). ${OWNER} ${pts(OWNER)} - ${pts(BOT)} ${BOT}` : `Round over: ${why}`, 'gold')
  if (mimic) await say(`${BOT} (${profile}): ${mimic.brain.statLine()}`)
  for (const who of [BOT, OWNER]) {
    if (!who) continue
    const f = r.flags[who]
    await say(`Grim flags on ${who}: ${f ? f.join(', ') : 'none'}`, f && who === BOT ? 'red' : 'gray')
  }
  console.log(`[arena] round ${winner ? 'won by ' + winner : why}; grim flags ${JSON.stringify(r.flags)}`)
}

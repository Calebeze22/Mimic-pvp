#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const mineflayer = require('mineflayer')
const { buildConfig } = require('./config')
const { Brain } = require('./combat/brain')

function parseArgs (argv) {
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const [k, v] = a.slice(2).split('=')
    o[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true)
  }
  return o
}

function createMimic (overrides = {}) {
  const cfg = buildConfig(overrides)
  if (!require('minecraft-data')(cfg.connection.version)) {
    throw new Error(`Minecraft ${cfg.connection.version} isn't supported by the installed mineflayer yet. ` +
      'Run "npm update" to pick up newer versions, or connect as 26.1 to a server running ViaBackwards (see README).')
  }
  const bot = mineflayer.createBot({ ...cfg.connection, hideErrors: false })
  const brain = new Brain(bot, cfg)
  bot.once('spawn', () => {
    brain.start()
    brain.log(`spawned (${cfg.profile} profile, MC ${bot.version})`)
  })
  bot.on('kicked', r => brain.log('kicked', typeof r === 'string' ? r : JSON.stringify(r)))
  bot.on('error', e => brain.log('error', e.message))
  bot.on('end', r => brain.log('disconnected', r))
  return { bot, brain, cfg }
}

// Real-client mode: the bot plays in a normal Minecraft window on this
// computer by pressing keys and moving the mouse (Windows input, or uinput on
// Linux). A spectator connection (`eyesName`) watches the server so the bot
// knows where people are; the game itself does all movement, aiming and
// hitting. `name` is the window's Minecraft name; the arena can also say it.
function createBody (overrides = {}, { name, eyesName = 'MimicEyes', mcDir } = {}) {
  const { Body } = require('./body/body')
  const { readOptions } = require('./body/options')
  const { Rand } = require('./util/rand')
  const platform = require('./body/platform')
  const tag = `[${name || 'bot'}]`
  const opts = readOptions(mcDir)
  if (!opts.found) console.log(`${tag} no options.txt at ${opts.file}; assuming default keys and 50% sensitivity`)
  for (const p of opts.problems) console.log(`${tag} Minecraft setting to fix: ${p}`)
  platform.init((...a) => console.log(tag, ...a))

  const cfg = buildConfig(overrides)
  cfg.aim.sensitivity = opts.sensitivity // must match the game, or the mouse maths is off
  cfg.loadout.autoArmor = false // can't see its own inventory
  const eyes = mineflayer.createBot({ ...cfg.connection, username: eyesName, hideErrors: false, physicsEnabled: false })
  const body = new Body(eyes, name, opts, new Rand(cfg.seed))
  const brain = new Brain(body, cfg)
  body.attachAim(brain)
  eyes.once('spawn', () => {
    eyes.physicsEnabled = false
    body.start()
    brain.start()
    console.log(tag, `watching as ${eyesName} (${cfg.profile} profile, sensitivity ${opts.sensitivity}); put the bot's Minecraft window in front and press F8 to hand it the keyboard and mouse (F8 again pauses)`)
  })
  eyes.on('kicked', r => brain.log('eyes kicked', typeof r === 'string' ? r : JSON.stringify(r)))
  eyes.on('error', e => brain.log('eyes error', e.message))
  eyes.on('end', () => body.stop())

  // Orders from the arena arrive as system messages starting "mimic:" (only
  // the server can send those; player chat starts with their name).
  eyes.on('messagestr', (msg, position) => {
    if (position === 'chat' || !msg.startsWith('mimic:')) return
    const [cmd, ...a] = msg.slice(6).trim().split(/\s+/)
    if (cmd === 'you') { body.username = a[0]; brain.log('playing as', a[0]) }
    if (cmd === 'hold') body.hold()
    if (cmd === 'release') body.release(Number(a[0]), Number(a[1]))
    if (cmd === 'duel') { brain.resetStats(); brain.duel(a[0]) }
    if (cmd === 'end') {
      const line = brain.statLine()
      brain.endDuel()
      eyes.chat(`[${body.username}] ${line}`)
    }
  })
  return { bot: eyes, body, brain, cfg }
}

if (require.main === module) {
  const args = parseArgs(process.argv.slice(2))
  let overrides = {}
  const file = args.config || (fs.existsSync('config.json') ? 'config.json' : null)
  if (file) overrides = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
  overrides.connection = { ...(overrides.connection || {}) }
  for (const k of ['host', 'username', 'auth', 'version']) if (args[k]) overrides.connection[k] = args[k]
  if (args.port) overrides.connection.port = Number(args.port)
  if (args.profile) overrides.profile = args.profile
  if (args.owner) overrides.targeting = { ...(overrides.targeting || {}), owner: args.owner }
  if (args.target) overrides.targeting = { ...(overrides.targeting || {}), auto: false }
  const { brain } = args.client
    ? createBody({ ...overrides, targeting: { auto: false, ...(overrides.targeting || {}) } }, { name: typeof args.client === 'string' ? args.client : null, eyesName: typeof args.eyes === 'string' ? args.eyes : undefined, mcDir: args['mc-dir'] })
    : createMimic(overrides)
  if (args.target) brain.manualTarget = args.target
}

module.exports = { createMimic, createBody }

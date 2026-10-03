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
    o[k] = v ?? argv[++i]
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
  const { brain } = createMimic(overrides)
  if (args.target) brain.manualTarget = args.target
}

module.exports = { createMimic }

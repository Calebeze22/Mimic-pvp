#!/usr/bin/env node
'use strict'

// One-time arena setup on your own computer:
//   node arena/setup.js [--mc 26.1.2] [--lan]
// Downloads Paper and the Grim anticheat, writes server.properties with RCON
// enabled, and asks you to accept the Minecraft EULA.

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const readline = require('readline')
const { execSync } = require('child_process')

const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : null).filter(Boolean))
const MC = String(args.mc || '26.1.2') // Paper has no plain "26.1" build
const DIR = path.join(__dirname, 'server')
const UA = { 'User-Agent': 'mimic-pvp-arena/0.1 (https://github.com/Calebeze22/mimic-pvp)' }

async function json (url) {
  const r = await fetch(url, { headers: UA })
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`)
  return r.json()
}

async function download (url, dest) {
  const r = await fetch(url, { headers: UA })
  if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`)
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()))
}

async function getPaper () {
  const dest = path.join(DIR, 'paper.jar')
  if (fs.existsSync(dest)) return console.log('paper.jar already there, skipping')
  // Paper's v3 download API. Picks the newest build for the version.
  const build = await json(`https://fill.papermc.io/v3/projects/paper/versions/${MC}/builds/latest`)
  const dl = build.downloads && build.downloads['server:default']
  if (!dl) throw new Error(`no Paper build listed for ${MC}`)
  console.log(`downloading Paper ${MC} build ${build.id} (${build.channel})...`)
  await download(dl.url, dest)
  const sha = crypto.createHash('sha256').update(fs.readFileSync(dest)).digest('hex')
  if (dl.checksums && dl.checksums.sha256 && dl.checksums.sha256 !== sha) throw new Error('Paper download checksum mismatch')
}

async function getGrim () {
  const dir = path.join(DIR, 'plugins')
  fs.mkdirSync(dir, { recursive: true })
  if (fs.readdirSync(dir).some(f => /^grim/i.test(f))) return console.log('Grim already there, skipping')
  const q = (o) => `https://api.modrinth.com/v2/project/grimac/version?loaders=${encodeURIComponent('["paper"]')}${o}`
  let versions = await json(q(`&game_versions=${encodeURIComponent(JSON.stringify([MC]))}`))
  if (!versions.length) {
    versions = await json(q(''))
    console.log(`note: Grim has no build tagged for ${MC} yet; using its newest Paper build (${versions[0] && versions[0].version_number}).`)
  }
  const file = versions[0] && (versions[0].files.find(f => f.primary) || versions[0].files[0])
  if (!file) throw new Error('could not find a Grim download')
  console.log(`downloading Grim ${versions[0].version_number}...`)
  await download(file.url, path.join(dir, file.filename))
}

function writeProperties () {
  const cfgPath = path.join(DIR, 'arena.json')
  const cfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : {}
  cfg.rconPassword = cfg.rconPassword || crypto.randomBytes(12).toString('hex')
  cfg.port = cfg.port || 25565
  cfg.rconPort = cfg.rconPort || 25575
  cfg.mc = MC
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))
  const props = {
    motd: 'Mimic PvP arena',
    'server-port': cfg.port,
    // Localhost only unless --lan: the arena runs in offline mode so the bot
    // can join without a Microsoft account, which is not safe to expose.
    'server-ip': args.lan ? '' : '127.0.0.1',
    'online-mode': 'false',
    'enforce-secure-profile': 'false',
    'enable-rcon': 'true',
    'rcon.port': cfg.rconPort,
    'rcon.password': cfg.rconPassword,
    'level-type': 'minecraft\\:flat',
    'generate-structures': 'false',
    'spawn-monsters': 'false',
    'spawn-protection': '0',
    pvp: 'true',
    difficulty: 'normal',
    gamemode: 'survival',
    'view-distance': '6',
    'simulation-distance': '6',
    'max-players': '4'
  }
  fs.writeFileSync(path.join(DIR, 'server.properties'), Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
}

async function eula () {
  const p = path.join(DIR, 'eula.txt')
  if (fs.existsSync(p) && /eula=true/.test(fs.readFileSync(p, 'utf8'))) return
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  const a = await new Promise(resolve => rl.question('Running a Minecraft server requires accepting the Minecraft EULA (https://aka.ms/MinecraftEULA).\nType "yes" to accept: ', resolve))
  rl.close()
  if (a.trim().toLowerCase() !== 'yes') throw new Error('EULA not accepted; the server will not start without it')
  fs.writeFileSync(p, 'eula=true\n')
}

function checkJava () {
  try {
    const v = execSync('java -version 2>&1').toString().split('\n')[0]
    console.log(`java: ${v}`)
  } catch (_) {
    console.log('Java was not found. Install a recent Java (21 or newer; Paper will say if it needs a newer one) and run this again.')
  }
}

async function main () {
  fs.mkdirSync(DIR, { recursive: true })
  checkJava()
  await getPaper().catch(e => console.log(`Could not download Paper automatically (${e.message}).\nDownload Paper ${MC} from https://papermc.io/downloads/paper and save it as ${path.join(DIR, 'paper.jar')}`))
  await getGrim().catch(e => console.log(`Could not download Grim automatically (${e.message}).\nDownload it from https://modrinth.com/plugin/grimac and put the jar in ${path.join(DIR, 'plugins')}`))
  writeProperties()
  await eula()
  console.log('\nArena is set up. Start it with: npm run arena:play -- --owner <your Minecraft name>')
}

main().catch(e => { console.error(e.message); process.exit(1) })

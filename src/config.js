'use strict'

// Profiles trade skill against how "perfect" the bot looks. Every number is
// in a range measured for real players; "pro" sits near the top of human
// performance, it never goes past it.
const base = {
  connection: { host: 'localhost', port: 25565, username: 'Mimic', auth: 'offline', version: '26.1' },
  targeting: {
    auto: true, // fight any player in range; false = only on "!fight <name>"
    owner: null, // username allowed to give chat commands
    allies: [], // never attack these
    range: 24, // how far it notices players (blocks)
    fov: 140 // degrees; players outside it are only noticed when they hit us
  },
  loadout: { autoArmor: true },
  seed: null,
  log: true
}

const profiles = {
  casual: {
    aim: { sensitivity: 0.42, freq: 9, damping: 0.62, pitchFreqScale: 0.75, maxSpeedDeg: 600, maxAccelDeg: 5000, tremorDeg: 2.2, trackGain: 0.55, lazyFloor: 0.25 },
    perception: { reactionMs: 260, reactionSdMs: 60, prediction: 0.75, aimHeight: 0.7, aimPointWander: 0.18 },
    keys: { keyDelayMs: 90, keyDelaySdMs: 35 },
    combat: { clickDelayMs: 140, clickDelaySdMs: 70, earlyClickChance: 0.18, critRate: 0.35, wtapChance: 0.2, strafe: 0.5, strafeSwitchMs: 1100, spacing: 0.3, reach: 2.85, lowHealth: 6, aimDiscipline: 0.4, closeGap: 1.6 }
  },
  good: {
    aim: { sensitivity: 0.48, freq: 13, damping: 0.68, pitchFreqScale: 0.8, maxSpeedDeg: 900, maxAccelDeg: 8000, tremorDeg: 1.5, trackGain: 0.75, lazyFloor: 0.2 },
    perception: { reactionMs: 210, reactionSdMs: 45, prediction: 0.9, aimHeight: 0.72, aimPointWander: 0.14 },
    keys: { keyDelayMs: 70, keyDelaySdMs: 25 },
    combat: { clickDelayMs: 85, clickDelaySdMs: 40, earlyClickChance: 0.08, critRate: 0.6, wtapChance: 0.45, strafe: 0.8, strafeSwitchMs: 800, spacing: 0.6, reach: 2.95, lowHealth: 6, aimDiscipline: 0.75, closeGap: 2.0 }
  },
  pro: {
    aim: { sensitivity: 0.52, freq: 17, damping: 0.72, pitchFreqScale: 0.85, maxSpeedDeg: 1200, maxAccelDeg: 12000, tremorDeg: 1.0, trackGain: 0.88, lazyFloor: 0.15 },
    perception: { reactionMs: 175, reactionSdMs: 35, prediction: 0.97, aimHeight: 0.74, aimPointWander: 0.1 },
    keys: { keyDelayMs: 55, keyDelaySdMs: 20 },
    combat: { clickDelayMs: 55, clickDelaySdMs: 25, earlyClickChance: 0.03, critRate: 0.8, wtapChance: 0.6, strafe: 0.95, strafeSwitchMs: 650, spacing: 0.85, reach: 3.0, lowHealth: 6, aimDiscipline: 0.92, closeGap: 2.3 }
  }
}

function merge (a, b) {
  if (b == null) return a
  if (typeof a !== 'object' || Array.isArray(a) || a === null) return b
  const out = { ...a }
  for (const k of Object.keys(b)) out[k] = merge(a[k], b[k])
  return out
}

function buildConfig (overrides = {}) {
  const profileName = overrides.profile || 'pro'
  const profile = profiles[profileName]
  if (!profile) throw new Error(`unknown profile "${profileName}" (casual, good, pro)`)
  const cfg = merge(merge(base, profile), overrides)
  cfg.profile = profileName
  return cfg
}

module.exports = { buildConfig, profiles }

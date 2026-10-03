'use strict'

// Offline check of the aim model: no server needed. Simulates a target
// strafing around the bot and a 120 degree flick, then prints the numbers an
// anticheat or a spectator would look at.
const { Vec3 } = require('vec3')
const { Rand } = require('../src/util/rand')
const { Aim, rotationStep, DEG } = require('../src/human/aim')
const { Perception } = require('../src/human/perception')
const G = require('../src/combat/geometry')
const { buildConfig } = require('../src/config')

function run (profile) {
  const cfg = buildConfig({ profile, seed: 7 })
  const rand = new Rand(7)
  const aim = new Aim(cfg.aim, rand)
  const perc = new Perception(cfg.perception, rand)
  const me = { position: new Vec3(0, 64, 0), eyeHeight: 1.62 }
  const target = { id: 1, position: new Vec3(0, 64, -3), width: 0.6, height: 1.8 }
  const eye = G.eyePos(me)
  aim.reset(0, 0)
  perc.refreshReaction()

  let t = 0
  let onTicks = 0
  let ticks = 0
  const speeds = []
  const deltas = []
  let prev = { yaw: 0, pitch: 0 }
  let dir = 1
  let nextFlip = 15
  for (let i = 0; i < 1200; i++) { // 60 s
    t += 50
    // Target circles at ~3 blocks, flipping direction at random (an A-D strafe).
    if (i >= nextFlip) { dir = -dir; nextFlip = i + 6 + Math.floor(rand.uniform(0, 18)) }
    const ang = Math.atan2(target.position.x, -target.position.z) + dir * 4.3 * 0.05 / 3
    target.position = new Vec3(Math.sin(ang) * 3, 64, -Math.cos(ang) * 3)
    perc.record([target], t)
    const { pos, vel } = perc.perceive(target, t)
    const ap = perc.aimPoint(target, pos, 0.05)
    const desired = G.anglesTo(eye, ap.point)
    const ahead = G.anglesTo(eye, ap.point.plus(vel.scaled(0.05)))
    const rate = { yaw: G.wrapAngle(ahead.yaw - desired.yaw) / 0.05, pitch: (ahead.pitch - desired.pitch) / 0.05 }
    const out = aim.tick(0.05, desired, rate, Math.atan2(0.3, 3) * 0.8)
    const ray = G.rayBox(eye, G.lookVector(out.yaw, out.pitch), G.hitbox(target))
    if (i > 20) { ticks++; if (ray !== null && ray <= 3) onTicks++ }
    const dy = out.yaw - prev.yaw
    speeds.push(Math.abs(dy) / 0.05 / DEG)
    deltas.push(dy, out.pitch - prev.pitch)
    prev = out
  }

  const step = rotationStep(cfg.aim.sensitivity)
  const offGrid = deltas.filter(d => Math.abs(d / step - Math.round(d / step)) > 1e-6).length
  speeds.sort((a, b) => a - b)

  // Flick: target appears 120 degrees to the side.
  aim.reset(0, 0)
  const flickTarget = G.anglesTo(eye, eye.plus(G.lookVector(120 * DEG, 0)))
  let peak = 0
  let settle = -1
  let maxOver = 0
  let last = 0
  for (let i = 0; i < 40; i++) {
    const out = aim.tick(0.05, flickTarget, { yaw: 0, pitch: 0 }, 2 * DEG)
    peak = Math.max(peak, Math.abs(G.wrapAngle(out.yaw - last)) / 0.05 / DEG)
    last = out.yaw
    const err = G.wrapAngle(out.yaw - flickTarget.yaw) / DEG
    maxOver = Math.max(maxOver, err)
    if (settle < 0 && Math.abs(err) < 3) settle = (i + 1) * 50
  }

  console.log(`\n== ${profile} ==`)
  console.log(`crosshair on target while strafing: ${(100 * onTicks / ticks).toFixed(1)}%`)
  console.log(`yaw speed deg/s  median ${speeds[600].toFixed(0)}  p95 ${speeds[1140].toFixed(0)}  max ${speeds[1199].toFixed(0)}`)
  console.log(`rotation deltas off the mouse grid: ${offGrid} of ${deltas.length} (step ${(step / DEG).toFixed(4)} deg)`)
  console.log(`120 deg flick: peak ${peak.toFixed(0)} deg/s, overshoot ${maxOver.toFixed(1)} deg, within 3 deg after ${settle} ms`)
  return { on: onTicks / ticks, offGrid }
}

let ok = true
for (const p of ['casual', 'good', 'pro']) {
  const r = run(p)
  if (r.offGrid > 0) ok = false
}
process.exit(ok ? 0 : 1)

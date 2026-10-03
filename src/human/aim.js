'use strict'

const { OU, clamp } = require('../util/rand')
const { wrapAngle } = require('../combat/geometry')

const DEG = Math.PI / 180

// Vanilla mouse -> rotation: degrees = pixels * (s*0.6+0.2)^3 * 8 * 0.15.
// Every rotation change a real client sends is a whole number of these
// steps, and anticheats check for it (the "GCD" / sensitivity check).
function rotationStep (sensitivity) {
  const f = sensitivity * 0.6 + 0.2
  return f * f * f * 8 * 0.15 * DEG
}

// Second-order "hand" model. The crosshair is pulled toward the desired angle
// by a spring with damping below critical, so big flicks overshoot a little
// and settle, like a wrist. Speed and acceleration are capped at human
// limits, OU noise adds tremor, and the spring goes lazy once the crosshair
// is already on the hitbox (people stop correcting when they're "on").
class Aim {
  constructor (cfg, rand) {
    this.cfg = cfg
    this.rand = rand
    this.step = rotationStep(cfg.sensitivity)
    this.tremorYaw = new OU(rand, 8, cfg.tremorDeg * DEG)
    this.tremorPitch = new OU(rand, 8, cfg.tremorDeg * 0.7 * DEG)
    this.reset(0, 0)
  }

  reset (yaw, pitch) {
    this.baseYaw = yaw
    this.basePitch = pitch
    this.yaw = yaw
    this.pitch = pitch
    this.vYaw = 0
    this.vPitch = 0
    this.out = { yaw, pitch }
  }

  // desired: {yaw, pitch}; rate: target's angular velocity (rad/s) the hand
  // partly matches when tracking; onTargetRadius: angular half-size of the
  // hitbox, used for the lazy zone. Returns quantized {yaw, pitch}.
  tick (dt, desired, rate = { yaw: 0, pitch: 0 }, onTargetRadius = 0) {
    const c = this.cfg
    const sub = 5
    const h = dt / sub
    const maxV = c.maxSpeedDeg * DEG
    const maxA = c.maxAccelDeg * DEG
    for (let i = 0; i < sub; i++) {
      this.vYaw = this._axis(h, wrapAngle(desired.yaw - this.yaw), this.vYaw, rate.yaw, c.freq, onTargetRadius, maxA, maxV)
      this.vPitch = this._axis(h, desired.pitch - this.pitch, this.vPitch, rate.pitch, c.freq * c.pitchFreqScale, onTargetRadius, maxA, maxV)
      this.yaw += this.vYaw * h
      this.pitch += this.vPitch * h
    }
    this.yaw += this.tremorYaw.step(dt) * dt
    this.pitch += this.tremorPitch.step(dt) * dt
    this.pitch = clamp(this.pitch, -Math.PI / 2, Math.PI / 2)

    const qy = this.baseYaw + Math.round((this.yaw - this.baseYaw) / this.step) * this.step
    // Stay on the mouse grid even at the +-90 degree pitch limit.
    let n = Math.round((this.pitch - this.basePitch) / this.step)
    while (this.basePitch + n * this.step > Math.PI / 2) n--
    while (this.basePitch + n * this.step < -Math.PI / 2) n++
    this.out = { yaw: qy, pitch: this.basePitch + n * this.step }
    return this.out
  }

  _axis (h, err, v, ff, freq, lazyR, maxA, maxV) {
    let k = freq * freq
    if (lazyR > 0) {
      const x = clamp(Math.abs(err) / lazyR, 0, 1)
      k *= this.cfg.lazyFloor + (1 - this.cfg.lazyFloor) * x * x
    }
    const vTarget = ff * this.cfg.trackGain
    let a = k * err + 2 * this.cfg.damping * freq * (vTarget - v)
    a = clamp(a, -maxA, maxA)
    return clamp(v + a * h, -maxV, maxV)
  }
}

module.exports = { Aim, rotationStep, DEG }

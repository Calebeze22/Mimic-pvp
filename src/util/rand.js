'use strict'

// Small seeded RNG plus the distributions the human model needs.
// Seeded so a run can be replayed when tuning; unseeded by default.

function mulberry32 (seed) {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

class Rand {
  constructor (seed) {
    this.next = seed == null ? Math.random : mulberry32(seed)
    this._spare = null
  }

  uniform (a = 0, b = 1) { return a + (b - a) * this.next() }

  chance (p) { return this.next() < p }

  gaussian (mean = 0, sd = 1) {
    if (this._spare != null) {
      const s = this._spare
      this._spare = null
      return mean + sd * s
    }
    let u, v, s
    do {
      u = this.next() * 2 - 1
      v = this.next() * 2 - 1
      s = u * u + v * v
    } while (s >= 1 || s === 0)
    const m = Math.sqrt(-2 * Math.log(s) / s)
    this._spare = v * m
    return mean + sd * u * m
  }

  // Log-normal parameterised by its real mean and sd (what you'd measure).
  // Reaction and motor times are right-skewed, never symmetric.
  lognormal (mean, sd) {
    const v = sd * sd
    const mu = Math.log(mean * mean / Math.sqrt(v + mean * mean))
    const sigma = Math.sqrt(Math.log(1 + v / (mean * mean)))
    return Math.exp(this.gaussian(mu, sigma))
  }

  pick (arr) { return arr[Math.floor(this.next() * arr.length)] }

  weighted (entries) {
    let total = 0
    for (const [, w] of entries) total += w
    let r = this.next() * total
    for (const [k, w] of entries) {
      r -= w
      if (r <= 0) return k
    }
    return entries[entries.length - 1][0]
  }
}

// Ornstein-Uhlenbeck process: smooth, mean-reverting noise. Used for aim
// drift and tremor so errors are correlated over time like a real hand.
class OU {
  constructor (rand, theta, sigma) {
    this.rand = rand
    this.theta = theta
    this.sigma = sigma
    this.x = 0
  }

  step (dt) {
    this.x += -this.theta * this.x * dt + this.sigma * Math.sqrt(dt) * this.rand.gaussian()
    return this.x
  }
}

const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v

module.exports = { Rand, OU, clamp }

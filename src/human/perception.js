'use strict'

const { Vec3 } = require('vec3')
const { OU, clamp } = require('../util/rand')

// What a human "sees": the target where it was one reaction time ago,
// pushed forward by an imperfect guess of its motion. The point on the body
// they aim at wanders slowly instead of locking onto one pixel.
class Perception {
  constructor (cfg, rand) {
    this.cfg = cfg
    this.rand = rand
    this.history = new Map() // entityId -> [{t, pos}]
    this.offY = new OU(rand, 1.5, cfg.aimPointWander)
    this.offX = new OU(rand, 1.5, cfg.aimPointWander)
    this.reaction = cfg.reactionMs
  }

  record (entities, t) {
    for (const e of entities) {
      let h = this.history.get(e.id)
      if (!h) this.history.set(e.id, (h = []))
      h.push({ t, pos: e.position.clone() })
      while (h.length > 40) h.shift()
    }
    if (this.history.size > 64) {
      const live = new Set(entities.map(e => e.id))
      for (const id of this.history.keys()) if (!live.has(id)) this.history.delete(id)
    }
  }

  // A fresh reaction time is drawn each time attention moves to something
  // new (a new target, the target changing direction).
  refreshReaction () {
    const r = this.cfg
    this.reaction = clamp(this.rand.lognormal(r.reactionMs, r.reactionSdMs), r.reactionMs * 0.6, r.reactionMs * 2.5)
  }

  _at (h, t) {
    if (!h || h.length === 0) return null
    if (t <= h[0].t) return h[0].pos
    for (let i = h.length - 1; i > 0; i--) {
      const a = h[i - 1]
      const b = h[i]
      if (a.t <= t && t <= b.t) {
        const f = (t - a.t) / Math.max(1, b.t - a.t)
        return a.pos.plus(b.pos.minus(a.pos).scaled(f))
      }
    }
    return h[h.length - 1].pos
  }

  velocity (id, t, windowMs = 150) {
    const h = this.history.get(id)
    const a = this._at(h, t - windowMs)
    const b = this._at(h, t)
    if (!a || !b) return new Vec3(0, 0, 0)
    return b.minus(a).scaled(1000 / windowMs) // blocks/s
  }

  // Perceived feet position of the entity, plus its perceived velocity.
  perceive (entity, t) {
    const h = this.history.get(entity.id)
    const seenAt = t - this.reaction
    const pos = this._at(h, seenAt) || entity.position
    const vel = this.velocity(entity.id, seenAt)
    // Humans extrapolate, but only partly and with error.
    const lead = (this.reaction / 1000) * this.cfg.prediction
    const guess = pos.plus(new Vec3(vel.x, 0, vel.z).scaled(lead))
    return { pos: guess, vel }
  }

  aimPoint (entity, feetPos, dt) {
    const hgt = entity.height ?? 1.8
    const w = (entity.width ?? 0.6) / 2
    const y = clamp(this.cfg.aimHeight + this.offY.step(dt), 0.15, 0.95) * hgt
    const side = clamp(this.offX.step(dt), -0.8, 0.8) * w
    return { y, side, point: feetPos.offset(0, y, 0) }
  }
}

module.exports = { Perception }

'use strict'

const { Vec3 } = require('vec3')
const { Rand, clamp } = require('../util/rand')
const { Aim, DEG } = require('../human/aim')
const { Perception } = require('../human/perception')
const { Keys } = require('../human/keys')
const G = require('./geometry')
const Items = require('./items')

const SERVER_REACH = 3.0 // survival entity_interaction_range; never exceeded

class Brain {
  constructor (bot, cfg) {
    this.bot = bot
    this.cfg = cfg
    this.c = cfg.combat
    this.rand = new Rand(cfg.seed)
    this.aim = new Aim(cfg.aim, this.rand)
    this.perc = new Perception(cfg.perception, this.rand)
    this.keys = null
    this.tick = 0
    this.lastSwingTick = -1000
    this.target = null
    this.manualTarget = null
    this.autoTarget = cfg.targeting.auto
    this.attackers = new Map() // entity id -> tick they last hurt us
    this.swings = new Map() // entity id -> tick of their last swing
    this.mode = 'crit'
    this.click = null
    this.jumpRelease = 0
    this.critJumpTick = -1000
    this.wtapUntil = 0
    this.strafeDir = 1
    this.nextStrafeSwitch = 0
    this.retreatUntil = 0
    this.spacingCheckAt = 0
    this.duelTarget = null
    this.lastHitTick = -1000
    this.busy = false
    this.reactUntil = 0
    this.idleLook = null
    this.stats = { hits: 0, crits: 0, sprintHits: 0, misses: 0, earlyHits: 0 }
  }

  start () {
    const bot = this.bot
    this.keys = new Keys(bot, this.cfg.keys, this.rand)
    // We send every rotation ourselves, already quantised; stop mineflayer
    // from re-stepping it.
    bot.physics.yawSpeed = 1e9
    bot.physics.pitchSpeed = 1e9
    this.aim.reset(bot.entity.yaw, bot.entity.pitch)

    bot.on('physicsTick', () => {
      try { this.update() } catch (e) { console.error(`[${bot.username}] tick error`, e.stack) }
    })
    bot.on('forcedMove', () => this.aim.reset(bot.entity.yaw, bot.entity.pitch))
    bot.on('respawn', () => this._resetFight())
    bot.on('death', () => { this._resetFight(); this.log('died', this.statLine()) })
    bot.on('entitySwingArm', e => this.swings.set(e.id, this.tick))
    bot.on('entityHurt', (e, source) => {
      if (e !== bot.entity) return
      let who = source
      if (!who || who.type !== 'player') {
        // Older servers don't say who hit us: blame whoever swung just now.
        let best = null
        for (const [id, t] of this.swings) {
          const p = bot.entities[id]
          if (p && p.type === 'player' && this.tick - t <= 3 && p.position.distanceTo(bot.entity.position) < 6) best = p
        }
        who = best
      }
      if (who) this.attackers.set(who.id, this.tick)
    })
    bot.on('chat', (user, msg) => this._command(user, msg))
    setInterval(() => { if (this.cfg.log && this.stats.hits + this.stats.misses > 0) this.log(this.statLine()) }, 15000).unref()
  }

  log (...a) { if (this.cfg.log) console.log(`[${this.bot.username}]`, ...a) }

  statLine () {
    const s = this.stats
    const swings = s.hits + s.misses
    return `hits ${s.hits} (crit ${s.crits}, sprint ${s.sprintHits}, early ${s.earlyHits}) misses ${s.misses} acc ${swings ? Math.round(100 * s.hits / swings) : 0}%`
  }

  _resetFight () {
    this.target = null
    this.click = null
    if (this.keys) this.keys.releaseAll()
    this.aim.reset(this.bot.entity.yaw, this.bot.entity.pitch)
  }

  _command (user, msg) {
    if (!this.cfg.targeting.owner || user !== this.cfg.targeting.owner) return
    const [cmd, arg] = msg.trim().split(/\s+/)
    if (cmd === '!fight' && arg) { this.manualTarget = arg; this.bot.chat(`ok`) }
    if (cmd === '!stop') { this.manualTarget = null; this.autoTarget = false; this._resetFight() }
    if (cmd === '!auto') this.autoTarget = arg !== 'off'
    if (cmd === '!stats') this.bot.chat(this.statLine())
  }

  // A duel lets the bot fight a named player even if they're the owner or
  // an ally. Used by the arena.
  duel (name) {
    this._resetFight()
    this.duelTarget = name
    this.manualTarget = name
  }

  endDuel () {
    this.duelTarget = null
    this.manualTarget = null
    this._resetFight()
  }

  resetStats () {
    for (const k of Object.keys(this.stats)) this.stats[k] = 0
  }

  // ---------------------------------------------------------------- tick

  update () {
    const bot = this.bot
    if (!bot.entity || bot.health <= 0) return
    this.tick++
    const now = Date.now()
    const players = Object.values(bot.entities).filter(e => e.type === 'player' && e !== bot.entity && e.position)
    this.perc.record(players, now)

    const target = this._selectTarget(players)
    if (target !== this.target) {
      this.target = target
      this.click = null
      this.perc.refreshReaction()
      this.reactUntil = this.tick + Math.round(this.perc.reaction / 50)
      if (target) this._pickMode(target)
    }

    if (target) this._fight(target, now)
    else this._idle()
    this.keys.update()
  }

  // ---------------------------------------------------------------- targeting

  _selectTarget (players) {
    const bot = this.bot
    const t = this.cfg.targeting
    const me = bot.entity
    const allies = new Set([...(t.allies || []), t.owner].filter(Boolean))
    let best = null
    let bestScore = -Infinity
    for (const p of players) {
      if (p.username && allies.has(p.username) && p.username !== this.duelTarget) continue
      if (this.duelTarget && p.username !== this.duelTarget) continue
      if (this.manualTarget ? p.username !== this.manualTarget : !this.autoTarget) {
        if (!this.attackers.has(p.id) || this.tick - this.attackers.get(p.id) > 200) continue
      }
      const d = p.position.distanceTo(me.position)
      const keep = p === this.target ? 6 : 0
      if (d > t.range + keep) continue
      const hurtUs = this.attackers.has(p.id) && this.tick - this.attackers.get(p.id) < 100
      const ang = Math.abs(G.wrapAngle(G.anglesTo(G.eyePos(me), p.position.offset(0, 1.4, 0)).yaw - me.yaw))
      const seen = ang <= (t.fov / 2) * DEG || d < 4 || p === this.target
      if (!seen && !hurtUs) continue
      if (p !== this.target && !hurtUs && !this._los(p)) continue
      let score = -d
      if (hurtUs) score += 12
      if (p === this.target) score += 5
      if (p.username === this.manualTarget) score += 50
      if (score > bestScore) { best = p; bestScore = score }
    }
    return best
  }

  _los (p) {
    try {
      const eye = G.eyePos(this.bot.entity)
      const to = p.position.offset(0, 1.4, 0)
      const dir = to.minus(eye)
      const len = dir.norm()
      const hit = this.bot.world.raycast(eye, dir.normalize(), len)
      return !hit
    } catch (_) { return true }
  }

  // ---------------------------------------------------------------- fight

  _pickMode (target) {
    // Open with a sprint hit (knockback starts the combo), crit while they
    // stand and trade, sprint-hit again when they run or we're low and need
    // them pushed away.
    const opening = this.tick - this.lastHitTick > 40
    const fleeing = this._relativeSpeed(target) > 3
    const lowHp = this.bot.health <= this.c.lowHealth
    this.mode = (!opening && !fleeing && !lowHp && this.rand.chance(this.c.critRate)) ? 'crit' : 'sprint'
  }

  _relativeSpeed (target) {
    const v = this.perc.velocity(target.id, Date.now())
    const away = target.position.minus(this.bot.entity.position)
    away.y = 0
    const n = away.norm()
    return n > 0 ? (v.x * away.x + v.z * away.z) / n : 0
  }

  _strength () {
    const period = Items.cooldownTicks(this.bot.heldItem)
    return { s: clamp((this.tick - this.lastSwingTick + 0.5) / period, 0, 1), period, ticksToFull: Math.max(0, Math.ceil(period * 0.93 - (this.tick - this.lastSwingTick))) }
  }

  _oppStrength (t) {
    const last = this.swings.has(t.id) ? this.swings.get(t.id) : -1000
    return clamp((this.tick - last) / Items.cooldownTicks(t.heldItem), 0, 1)
  }

  _fight (t, now) {
    const bot = this.bot
    const me = bot.entity
    const dt = 0.05
    const eye = G.eyePos(me)

    // ---- aim
    const { pos: seen, vel } = this.perc.perceive(t, now)
    const ap = this.perc.aimPoint(t, seen, dt)
    const flat = new Vec3(seen.x - me.position.x, 0, seen.z - me.position.z)
    const flatDist = flat.norm()
    const perp = flatDist > 1e-3 ? new Vec3(-flat.z / flatDist, 0, flat.x / flatDist) : new Vec3(0, 0, 0)
    const aimPt = ap.point.plus(perp.scaled(ap.side))
    let desired = G.anglesTo(eye, aimPt)
    const ahead = G.anglesTo(eye.plus(me.velocity), aimPt.plus(vel.scaled(dt)))
    let rate = { yaw: G.wrapAngle(ahead.yaw - desired.yaw) / dt, pitch: (ahead.pitch - desired.pitch) / dt }
    if (this.tick < this.reactUntil) { // haven't reacted to this target yet
      desired = { yaw: this.aim.yaw, pitch: this.aim.pitch }
      rate = { yaw: 0, pitch: 0 }
    }
    const lazyR = Math.atan2((t.width ?? 0.6) / 2, Math.max(0.5, eye.distanceTo(aimPt))) * 0.8
    const sent = { yaw: me.yaw, pitch: me.pitch } // what the server has from last tick
    const look = this.aim.tick(dt, desired, rate, lazyR)
    me.yaw = look.yaw
    me.pitch = look.pitch

    // ---- facts about this tick, using where the target really is
    const box = G.hitbox(t)
    const reach = G.pointBoxDistance(eye, box)
    const ray = G.rayBox(eye, G.lookVector(look.yaw, look.pitch), box)
    // The attack packet goes out before this tick's rotation (same as
    // vanilla), so only count it as on target if the rotation the server
    // already has agrees. Keeps every hit consistent for rotation checks.
    const raySent = G.rayBox(eye, G.lookVector(sent.yaw, sent.pitch), box)
    const onTarget = ray !== null && ray <= SERVER_REACH && raySent !== null && raySent <= SERVER_REACH && this._clearTo(eye, look, ray)
    const dist = G.horizontalDist(me.position, t.position)
    if (this.tick % 20 === 0) this.perc.refreshReaction()
    const { s, ticksToFull } = this._strength()
    const opp = this._oppStrength(t)
    this._holdSword()

    // ---- movement
    this._move(t, dist, ticksToFull, opp)

    // ---- attack
    this._attack(t, s, reach, onTarget)
  }

  _clearTo (eye, look, len) {
    try { return !this.bot.world.raycast(eye, G.lookVector(look.yaw, look.pitch), len) } catch (_) { return true }
  }

  _move (t, dist, ticksToFull, opp) {
    const bot = this.bot
    const me = bot.entity
    const k = this.keys
    let fwd = false
    let back = false
    let sprint = false
    let jump = false

    if (dist > 3.4) {
      fwd = true
      sprint = true
      if (dist > 7 && me.onGround && this.rand.chance(0.06)) jump = true // sprint-jumping is faster
    } else {
      // Spacing: if we're still on cooldown and they're ready, step back out
      // of their reach instead of trading a weak hit for a full one.
      if (this.tick >= this.spacingCheckAt) {
        this.spacingCheckAt = this.tick + 4 + Math.floor(this.rand.uniform(0, 4))
        if (ticksToFull > 4 && opp > 0.8 && dist < 3.1 && this.rand.chance(this.c.spacing)) {
          this.retreatUntil = this.tick + Math.min(ticksToFull - 2, 6)
        }
      }
      if (this.tick < this.retreatUntil) back = true
      else if (dist < this.c.closeGap) back = dist < this.c.closeGap * 0.6 // don't walk into them, circle instead
      else { fwd = true; sprint = this.mode === 'sprint' || dist > 3.0 }

      // Crit: jump so the hit lands on the way down, unsprinted.
      if (this.mode === 'crit' && me.onGround && ticksToFull <= 6 && dist < 3.6 && this.tick - this.critJumpTick > 12) {
        jump = true
        this.critJumpTick = this.tick
      }
      if (this.mode === 'crit' && this.tick - this.critJumpTick < 14) sprint = false
    }

    if (this.tick < this.wtapUntil) { fwd = false; sprint = false }

    // Strafe around them, switching direction at irregular times.
    let left = false
    let right = false
    if (dist < 5) {
      if (this.tick >= this.nextStrafeSwitch) {
        if (this.rand.chance(0.7)) this.strafeDir = -this.strafeDir
        this.strafing = this.rand.chance(this.c.strafe)
        this.nextStrafeSwitch = this.tick + Math.max(4, Math.round(this.rand.lognormal(this.c.strafeSwitchMs, this.c.strafeSwitchMs * 0.45) / 50))
      }
      if (this.strafing) {
        if (this.strafeDir > 0) right = true
        else left = true
      }
    }

    if (me.isCollidedHorizontally && me.onGround && fwd) jump = true
    // Don't walk off edges or into lava.
    if (left || right) {
      const side = this._sideVec(me.yaw).scaled(right ? 1 : -1)
      if (!this._safe(side)) { this.strafeDir = -this.strafeDir; left = right = false }
    }
    if (back && !this._safe(G.lookVector(me.yaw, 0).scaled(-1))) back = false
    if (fwd && !this._safe(G.lookVector(me.yaw, 0)) && dist > 2) fwd = false

    k.want('forward', fwd)
    k.want('back', back)
    k.want('left', left)
    k.want('right', right)
    k.want('sprint', sprint)
    if (jump) { k.want('jump', true); this.jumpRelease = this.tick + 2 }
    else if (this.tick >= this.jumpRelease) k.want('jump', false)
  }

  _sideVec (yaw) { return new Vec3(Math.cos(yaw), 0, -Math.sin(yaw)) }

  _safe (dir) {
    try {
      const p = this.bot.entity.position.plus(dir.scaled(1.2))
      for (let dy = 0; dy >= -1; dy--) {
        const b = this.bot.blockAt(p.offset(0, dy, 0))
        if (b && (b.name === 'lava' || b.name === 'fire' || b.name === 'cactus')) return false
      }
      for (let dy = -1; dy >= -4; dy--) {
        const b = this.bot.blockAt(p.offset(0, dy, 0))
        if (!b) return true // unloaded: assume fine
        if (b.boundingBox === 'block' || b.name === 'water') return true
      }
      return false
    } catch (_) { return true }
  }

  _attack (t, s, reach, onTarget) {
    const bot = this.bot
    const me = bot.entity
    if (this.tick < this.reactUntil) { this.click = null; return }

    if (!this.click) {
      const falling = !me.onGround && me.velocity.y < -0.03
      const sprinting = bot.getControlState('sprint')
      const perceivedReach = reach + this.rand.gaussian(0, 0.12)
      const inRange = perceivedReach <= Math.min(this.c.reach, SERVER_REACH)
      let want = false
      let early = false
      if (inRange && s >= 0.92) {
        if (this.mode === 'crit') {
          const stuckOnGround = me.onGround && this.tick - this.critJumpTick > 14
          want = (falling && !sprinting) || stuckOnGround
        } else {
          want = true
        }
      } else if (inRange && s >= 0.6 && s < 0.9 && this.rand.chance(this.c.earlyClickChance / 6)) {
        want = true // impatient click
        early = true
      }
      // Better players wait the extra moment until the crosshair is on them.
      if (want && !onTarget && this.rand.chance(this.c.aimDiscipline)) want = false
      if (want) {
        const delay = Math.round(this.rand.lognormal(this.c.clickDelayMs, this.c.clickDelaySdMs) / 50)
        this.click = { at: this.tick + delay, early }
      }
    }

    if (!this.click || this.tick < this.click.at) return
    const click = this.click
    this.click = null

    if (reach > 3.8) return // they were clearly gone; a human wouldn't click
    if (!onTarget && (click.waited || 0) < 3 && this.rand.chance(this.c.aimDiscipline)) {
      // Hold the click a tick for the crosshair to get there.
      this.click = { ...click, at: this.tick + 1, waited: (click.waited || 0) + 1 }
      return
    }
    if (!onTarget) {
      bot.swingArm()
      this.lastSwingTick = this.tick // vanilla resets the cooldown on a whiff too
      this.stats.misses++
      return
    }

    const crit = !me.onGround && me.velocity.y < 0 && !bot.getControlState('sprint') && this._strength().s > 0.9
    const sprintHit = bot.getControlState('sprint') && this._strength().s > 0.9
    bot.attack(t)
    this.lastSwingTick = this.tick
    this.lastHitTick = this.tick
    this.stats.hits++
    if (crit) this.stats.crits++
    if (click.early) this.stats.earlyHits++
    if (sprintHit) {
      // What the vanilla client does after a knockback hit.
      this.stats.sprintHits++
      me.velocity.x *= 0.6
      me.velocity.z *= 0.6
      this.keys.force('sprint', false)
      this.keys.blockSprint(1)
      if (this.rand.chance(this.c.wtapChance)) this.wtapUntil = this.tick + 1 + Math.floor(this.rand.uniform(0, 3))
    }
    this._pickMode(t)
  }

  _motorTicks (mean = 180, sd = 60) {
    return Math.max(1, Math.round(this.rand.lognormal(mean, sd) / 50))
  }

  // ---------------------------------------------------------------- items

  _bestWeaponSlot () {
    let best = -1
    let bestScore = -1
    const inv = this.bot.inventory
    for (let i = 0; i < 9; i++) {
      const it = inv.slots[inv.hotbarStart + i]
      const sc = it ? Items.weaponScore(it) : 0
      if (sc > bestScore) { best = i; bestScore = sc }
    }
    return best
  }

  _select (slot) {
    if (slot < 0 || this.bot.quickBarSlot === slot) return
    this.bot.setQuickBarSlot(slot)
    this.lastSwingTick = this.tick // switching items resets the attack charge
  }

  // If the sword isn't in hand (just respawned, kit changed), pick it up
  // after a human pause rather than on the same tick.
  _holdSword () {
    const best = this._bestWeaponSlot()
    if (best < 0 || best === this.bot.quickBarSlot) { this.swapAt = null; return }
    if (this.swapAt == null) this.swapAt = this.tick + this._motorTicks(250, 80)
    if (this.tick >= this.swapAt) { this._select(best); this.swapAt = null }
  }

  // ---------------------------------------------------------------- idle

  _idle () {
    const bot = this.bot
    const me = bot.entity
    for (const key of ['forward', 'back', 'left', 'right', 'sprint', 'jump']) this.keys.want(key, false)
    // Glance around now and then, the way a waiting player moves the mouse.
    if (!this.idleLook || this.tick >= this.idleLook.until) {
      this.idleLook = {
        yaw: this.aim.yaw + this.rand.gaussian(0, 35) * DEG,
        pitch: clamp(this.rand.gaussian(-0.05, 0.15), -0.6, 0.5),
        until: this.tick + Math.round(this.rand.lognormal(2500, 1200) / 50)
      }
    }
    const look = this.aim.tick(0.05, this.idleLook, { yaw: 0, pitch: 0 }, 0)
    me.yaw = look.yaw
    me.pitch = look.pitch
    if (!this.busy && this.tick % 40 === 0) this._prepare().catch(e => console.error(`[${bot.username}] loadout`, e.message))
  }

  async _prepare () {
    const bot = this.bot
    const L = this.cfg.loadout
    const wait = ms => new Promise(r => setTimeout(r, ms))
    const human = () => wait(this.rand.lognormal(450, 150))
    this.busy = true
    try {
      if (L.autoArmor) {
        for (const item of bot.inventory.items()) {
          const info = Items.armorInfo(item)
          if (!info) continue
          const slot = bot.getEquipmentDestSlot(info.dest)
          const cur = Items.armorInfo(bot.inventory.slots[slot])
          if (!cur || info.rank < cur.rank) {
            await human()
            // Only touch the inventory standing still, like a player would.
            if (this.target || bot.entity.velocity.x ** 2 + bot.entity.velocity.z ** 2 > 1e-4) return
            await bot.equip(item, info.dest)
          }
        }
      }
      const best = this._bestWeaponSlot()
      if (best >= 0 && best !== bot.quickBarSlot) { await human(); this._select(best) }
    } finally {
      this.busy = false
    }
  }
}

module.exports = { Brain }

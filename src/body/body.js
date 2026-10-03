'use strict'

const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { wrapAngle } = require('../combat/geometry')
const { DEG, rotationStep } = require('../human/aim')
const { Hands } = require('./hands')
const { readOptions } = require('./options')
const win = require('./win32')

const TICK_MS = 50
const MOUSE_MS = 8 // ~125 Hz, a normal mouse polling rate

// Minecraft degrees -> the radians convention the brain uses.
function fromMc (yawDeg, pitchDeg) {
  return { yaw: wrapAngle(Math.PI - yawDeg * DEG), pitch: -pitchDeg * DEG }
}

// The brain's aim, rerouted to the real mouse. The brain sets a goal once a
// tick; the hand model then runs at mouse rate and every step it takes goes
// out as whole mouse counts, so the game turns the camera itself.
class MouseAim {
  constructor (aim) {
    this.real = aim
    this.goal = null
  }

  get yaw () { return this.real.yaw }
  get pitch () { return this.real.pitch }
  get out () { return this.real.out }
  get step () { return this.real.step }

  tick (dt, desired, rate = { yaw: 0, pitch: 0 }, lazyR = 0) {
    this.goal = { desired, rate, lazyR, at: Date.now() }
    return this.real.out
  }

  // The brain calls this after deaths and teleports with what it thinks the
  // rotation is. Only stop the hand; the camera didn't move.
  reset () {
    this.real.vYaw = 0
    this.real.vPitch = 0
    this.goal = null
  }

  // We know the camera's exact rotation (the arena just set it).
  sync (yaw, pitch) {
    this.real.reset(yaw, pitch)
    this.goal = null
  }

  // Move our idea of the camera without moving the camera.
  shift (dYaw, dPitch) {
    const a = this.real
    a.yaw += dYaw; a.baseYaw += dYaw; a.out.yaw += dYaw
    a.pitch += dPitch; a.basePitch += dPitch; a.out.pitch += dPitch
  }

  // One mouse-rate step: returns the mouse counts to send.
  move (dt) {
    const g = this.goal
    if (!g) return { dx: 0, dy: 0 }
    const age = Math.min(0.1, (Date.now() - g.at) / 1000)
    const desired = { yaw: g.desired.yaw + g.rate.yaw * age, pitch: g.desired.pitch + g.rate.pitch * age }
    const before = this.real.out
    const after = this.real.tick(dt, desired, g.rate, g.lazyR)
    const cy = Math.round(wrapAngle(after.yaw - before.yaw) / this.real.step)
    const cp = Math.round((after.pitch - before.pitch) / this.real.step)
    // Mouse right turns the camera right (brain yaw goes down); mouse down
    // looks down (brain pitch goes down).
    return { dx: -cy, dy: -cp }
  }
}

// Stands in for a mineflayer bot so the brain can play through a real
// Minecraft window. Everything it knows about the world comes from "eyes",
// a spectator connection watching the arena; everything it does goes
// through the keyboard and mouse.
class Body extends EventEmitter {
  constructor (eyes, name, opts, rand) {
    super()
    this.eyes = eyes
    this.username = name
    this.opts = opts
    this.rand = rand
    this.log = (...a) => console.log(`[${this.username || 'bot'}]`, ...a)
    this.hands = new Hands(opts, rand, this.log, w => this._pinned(w))
    this.physics = {}
    this.food = 20
    this.quickBarSlot = 0
    this.real = null // the bot player's entity as eyes sees it
    this.entity = { type: 'player', username: name, position: new Vec3(0, 0, 0), velocity: new Vec3(0, 0, 0), yaw: 0, pitch: 0, onGround: true, isCollidedHorizontally: false, eyeHeight: 1.62, width: 0.6, height: 1.8 }
    this.mouseAim = null
    this._last = null
    this._fwdTicks = 0
    this._lastHealth = 20
    this._timers = []
    this.world = eyes.world
    const healthIdx = eyes.registry.entitiesByName.player?.metadataKeys?.indexOf('health') ?? -1
    this._healthIdx = healthIdx >= 0 ? healthIdx : 9
  }

  // ---- what the brain reads

  get entities () {
    const out = {}
    for (const [id, e] of Object.entries(this.eyes.entities)) {
      if (e === this.eyes.entity || e === this.real) continue
      out[id] = e
    }
    return out
  }

  get health () {
    const h = this.real?.metadata?.[this._healthIdx]
    return typeof h === 'number' ? h : 20
  }

  get heldItem () { return this.real?.heldItem ?? null }

  get inventory () {
    const slots = new Array(46).fill(null)
    slots[36 + this.quickBarSlot] = this.heldItem
    return { hotbarStart: 36, slots, items: () => [] }
  }

  blockAt (p) { return this.eyes.blockAt(p) }
  supportFeature () { return false }
  getControlState (k) { return this.hands.get(k) }

  // ---- what the brain does

  setControlState (k, v) { this.hands.set(k, v) }
  attack () { this.hands.click() }
  swingArm () { this.hands.click() }
  setQuickBarSlot (i) { if (this.hands.tap(`hotbar.${i + 1}`)) this.quickBarSlot = i }
  chat (msg) { console.log(`[${this.username}] (would say) ${msg}`) }
  async equip () {}
  getEquipmentDestSlot () { return -1 }

  // The bot's window was picked: use the keys and sensitivity of the game
  // running in it (its own --gameDir), not whatever we read at startup.
  _pinned (w) {
    const dir = win.gameDirOf(w.pid)
    if (!dir) return this.log(`couldn't see that game's folder; using ${this.opts.file}`)
    try {
      const o = readOptions(dir)
      if (!o.found) return this.log(`no options.txt in ${dir}; using ${this.opts.file}`)
      this.opts = o
      this.hands.keys = o.keys
      if (this.mouseAim) this.mouseAim.real.step = rotationStep(o.sensitivity)
      this.log(`using ${o.file} (sensitivity ${o.sensitivity})`)
      for (const p of o.problems) this.log(`Minecraft setting to fix: ${p}`)
    } catch (e) {
      this.log(`can't use that game's settings: ${e.message}`)
      this.hands.pinned = null
    }
  }

  // ---- loops

  attachAim (brain) {
    this.mouseAim = new MouseAim(brain.aim)
    brain.aim = this.mouseAim
  }

  start () {
    const eyes = this.eyes
    const isMe = e => e && e === this.real
    eyes.on('entitySwingArm', e => { if (!isMe(e)) this.emit('entitySwingArm', e) })
    eyes.on('entityHurt', (e, src) => this.emit('entityHurt', isMe(e) ? this.entity : e, isMe(src) ? this.entity : src))
    eyes.on('chat', (u, m) => this.emit('chat', u, m))
    for (const p of ['rel_entity_move', 'entity_move_look', 'entity_teleport', 'sync_entity_position']) {
      eyes._client.on(p, pk => { if (this.real && pk.entityId === this.real.id && typeof pk.onGround === 'boolean') this.entity.onGround = pk.onGround })
    }
    eyes.on('entityMoved', e => { if (isMe(e)) this._observe() })

    let lastMouse = performance.now()
    this._timers.push(setInterval(() => {
      const now = performance.now()
      const dt = Math.min(0.05, (now - lastMouse) / 1000)
      lastMouse = now
      if (!this.hands.update() || !this.mouseAim || !this.real) return
      const { dx, dy } = this.mouseAim.move(dt)
      this.hands.move(dx, dy)
      const o = this.mouseAim.out
      this.entity.yaw = o.yaw
      this.entity.pitch = o.pitch
    }, MOUSE_MS))

    this._timers.push(setInterval(() => this._tick(), TICK_MS))
    this._timers.push(setInterval(() => this._checkDrift(), 500))
  }

  stop () {
    for (const t of this._timers) clearInterval(t)
    this._timers = []
    this.hands.releaseAll()
  }

  _findMe () {
    if (!this.username) return null
    const p = this.eyes.players[this.username]
    const e = p && p.entity
    if (e !== this.real) {
      const first = !this.real
      this.real = e || null
      if (e) {
        this.entity.id = e.id
        this.entity.position = e.position.clone()
        this._last = null
        if (first && this.mouseAim) {
          // Best guess until the arena sets our exact rotation.
          this.mouseAim.sync(e.yaw, e.pitch)
          this.entity.yaw = e.yaw
          this.entity.pitch = e.pitch
          console.log(`[${this.username}] found in the world; watching through ${this.eyes.username}`)
        }
      }
    }
    return this.real
  }

  _observe () {
    const e = this.real
    const now = performance.now()
    if (this._last) {
      const ticks = Math.max(0.5, (now - this._last.t) / TICK_MS)
      const d = e.position.minus(this._last.pos).scaled(1 / ticks)
      // Teleports aren't velocity.
      if (d.norm() < 4) this.entity.velocity = d
    }
    this._last = { t: now, pos: e.position.clone() }
    this.entity.position = e.position.clone()
  }

  _tick () {
    if (!this._findMe()) return
    if (this._last && performance.now() - this._last.t > 120) this.entity.velocity = new Vec3(0, 0, 0)
    const v = this.entity.velocity
    const flat = Math.hypot(v.x, v.z)
    this._fwdTicks = this.hands.get('forward') ? this._fwdTicks + 1 : 0
    this.entity.isCollidedHorizontally = this._fwdTicks > 5 && flat < 0.03

    const h = this.health
    if (h <= 0 && this._lastHealth > 0) this.emit('death')
    if (h > 0 && this._lastHealth <= 0) this.emit('respawn')
    this._lastHealth = h

    if (this.hands.held) return
    this.emit('physicsTick')
  }

  // Our rotation is counted from the mouse moves we send. If the game ate
  // some (a menu was open, the window lost focus) the server's view of our
  // head drifts away from the count; snap back to it when the hand is still.
  _checkDrift () {
    const e = this.real
    const a = this.mouseAim
    if (!e || !a || this.hands.held) return
    if (Math.abs(a.real.vYaw) > 0.35 || Math.abs(a.real.vPitch) > 0.35) return
    const dy = wrapAngle(e.yaw - a.out.yaw)
    const dp = e.pitch - a.out.pitch
    if (Math.abs(dy) > 4 * DEG || Math.abs(dp) > 4 * DEG) {
      a.shift(dy, dp)
      console.log(`[${this.username}] aim count was off by ${(dy / DEG).toFixed(1)}/${(dp / DEG).toFixed(1)} deg; re-synced from the server`)
    }
  }

  // Arena teleports: hands off, then take the exact rotation it set.
  hold () { this.hands.held = true; this.hands.releaseAll(); if (this.mouseAim) this.mouseAim.reset() }
  release (yawDeg, pitchDeg) {
    if (yawDeg != null && this.mouseAim) {
      const r = fromMc(yawDeg, pitchDeg)
      this.mouseAim.sync(r.yaw, r.pitch)
      this.entity.yaw = r.yaw
      this.entity.pitch = r.pitch
    }
    this.hands.held = false
    this.emit('forcedMove')
  }
}

module.exports = { Body, MouseAim, fromMc, focused: win.minecraftFocused }

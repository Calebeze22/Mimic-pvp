'use strict'

const KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

// Keyboard layer. The brain says what it wants held; this layer applies it a
// motor delay later, keeps the sprint rules a vanilla client enforces, and
// sends the player_input packet a real 1.21.2+ client sends (anticheats like
// Grim replay movement from it).
class Keys {
  constructor (bot, cfg, rand) {
    this.bot = bot
    this.cfg = cfg
    this.rand = rand
    this.tick = 0
    this.wanted = Object.fromEntries(KEYS.map(k => [k, false]))
    this.pending = new Map() // key -> {state, at}
    this.sprintBlockedUntil = 0
    this._lastInput = ''
  }

  want (key, state) {
    if (this.wanted[key] === state && !this.pending.has(key)) return
    const p = this.pending.get(key)
    if (p && p.state === state) return
    if (!p && this.bot.getControlState(key) === state) {
      this.wanted[key] = state
      return
    }
    const delay = Math.max(0, Math.round(this.rand.lognormal(this.cfg.keyDelayMs, this.cfg.keyDelaySdMs) / 50))
    this.pending.set(key, { state, at: this.tick + delay })
    this.wanted[key] = state
  }

  // Immediate change, for things the vanilla client itself does on its own
  // (dropping sprint after a knockback hit).
  force (key, state) {
    this.pending.delete(key)
    this.wanted[key] = state
    this.bot.setControlState(key, state)
  }

  blockSprint (ticks) { this.sprintBlockedUntil = Math.max(this.sprintBlockedUntil, this.tick + ticks) }

  update () {
    this.tick++
    for (const [key, p] of this.pending) {
      if (p.at <= this.tick) {
        this.bot.setControlState(key, p.state)
        this.pending.delete(key)
      }
    }
    const b = this.bot
    const canSprint = b.getControlState('forward') && !b.getControlState('back') && !b.getControlState('sneak') &&
      (b.food ?? 20) > 6 && this.tick >= this.sprintBlockedUntil
    const sprint = this.wanted.sprint && canSprint
    if (b.getControlState('sprint') !== sprint) b.setControlState('sprint', sprint)
    this._sendInput()
  }

  _sendInput () {
    const b = this.bot
    const s = k => !!b.getControlState(k)
    // The sprint bit is the sprint key, not whether we're sprinting right now.
    const inputs = { forward: s('forward'), backward: s('back'), left: s('left'), right: s('right'), jump: s('jump'), shift: s('sneak'), sprint: !!this.wanted.sprint }
    const sig = JSON.stringify(inputs)
    if (sig === this._lastInput) return
    this._lastInput = sig
    if (!b.supportFeature || !b.supportFeature('newPlayerInputPacket')) return
    try { b._client.write('player_input', { inputs }) } catch (_) {}
  }

  releaseAll () {
    this.pending.clear()
    for (const k of KEYS) {
      this.wanted[k] = false
      this.bot.setControlState(k, false)
    }
  }
}

module.exports = { Keys }

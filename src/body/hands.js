'use strict'

const win = require('./win32')

const VK_F8 = 0x77
const MOVE_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

// Keyboard and mouse on the bot's Minecraft window. It never guesses which
// window that is: nothing is sent until you put the bot's window in front
// and press F8, and from then on only while that exact window is in front.
// Switch to anything else (or press F8 again) and every key is let go and
// the mouse is yours.
class Hands {
  constructor (opts, rand, log, onPin) {
    this.keys = opts.keys
    this.rand = rand
    this.log = log
    this.onPin = onPin
    this.wanted = Object.fromEntries(MOVE_KEYS.map(k => [k, false]))
    this.down = new Set() // scancodes we're physically holding
    this.pinned = null // {hwnd, pid, title} of the bot's window
    this.paused = false
    this.held = false // arena teleports: hands off until re-synced
    this._f8 = false
    this._wasActive = null
  }

  get active () { return !!this.pinned && !this.paused && !this.held && win.foregroundHwnd() === this.pinned.hwnd }

  // Called often (every few ms) from the body loop.
  update () {
    const f8 = win.keyHeld(VK_F8)
    if (f8 && !this._f8) this._onF8()
    this._f8 = f8
    const active = this.active
    if (active !== this._wasActive) {
      if (this._wasActive !== null) this.log(active ? 'bot window in front: playing' : `hands off (${!this.pinned ? 'no window picked' : this.paused ? 'paused' : this.held ? 'teleporting' : 'bot window not in front'})`)
      this._wasActive = active
    }
    for (const k of MOVE_KEYS) {
      const code = this.keys[k]
      const want = active && this.wanted[k]
      if (want && !this.down.has(code)) { win.key(code, true); this.down.add(code) } else if (!want && this.down.has(code)) { win.key(code, false); this.down.delete(code) }
    }
    return active
  }

  _onF8 () {
    if (!this.pinned) {
      const w = win.foregroundMinecraft()
      if (!w) return this.log('F8: put the bot\'s Minecraft window in front first, then press F8')
      this.pinned = w
      this.paused = false
      this.log(`playing in "${w.title}" (process ${w.pid}). F8 pauses.`)
      if (this.onPin) this.onPin(w)
      return
    }
    this.paused = !this.paused
    this.log(this.paused ? 'paused (F8 again to resume)' : 'resumed')
  }

  set (key, state) { if (key in this.wanted) this.wanted[key] = !!state }
  get (key) { return !!this.wanted[key] }

  // One left click: press, hold like a finger does, release.
  click () {
    if (!this.active) return false
    win.leftDown()
    const hold = Math.min(160, Math.max(35, this.rand.lognormal(75, 25)))
    setTimeout(() => win.leftUp(), hold)
    return true
  }

  tap (key) {
    const code = this.keys[key]
    if (code == null || typeof code === 'object' || !this.active) return false
    win.key(code, true)
    setTimeout(() => win.key(code, false), Math.min(140, Math.max(40, this.rand.lognormal(70, 20))))
    return true
  }

  move (dx, dy) { if ((dx || dy) && this.active) win.moveMouse(dx, dy) }

  releaseAll () {
    for (const k of MOVE_KEYS) this.wanted[k] = false
    for (const code of this.down) win.key(code, false)
    this.down.clear()
  }
}

module.exports = { Hands, MOVE_KEYS }

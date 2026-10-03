'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')

// Reads the Minecraft client's own options.txt so the bot presses the keys
// that client is bound to and turns at its real mouse sensitivity.

const LETTERS = 'qwertyuiop|asdfghjkl|zxcvbnm'
const ROW_START = [0x10, 0x1E, 0x2C]
const NAMED = {
  space: 0x39, 'left.shift': 0x2A, 'right.shift': 0x36, 'left.control': 0x1D, 'right.control': 0x11D,
  'left.alt': 0x38, 'right.alt': 0x138, tab: 0x0F, 'caps.lock': 0x3A, 'grave.accent': 0x29,
  0: 0x0B
}
LETTERS.split('|').forEach((row, r) => [...row].forEach((ch, i) => { NAMED[ch] = ROW_START[r] + i }))
for (let d = 1; d <= 9; d++) NAMED[d] = 0x01 + d

const DEFAULT_KEYS = {
  forward: 'key.keyboard.w', back: 'key.keyboard.s', left: 'key.keyboard.a', right: 'key.keyboard.d',
  jump: 'key.keyboard.space', sneak: 'key.keyboard.left.shift', sprint: 'key.keyboard.left.control',
  attack: 'key.mouse.left'
}
for (let i = 1; i <= 9; i++) DEFAULT_KEYS[`hotbar.${i}`] = `key.keyboard.${i}`

// Accepts both formats: "key.keyboard.w" (1.13+) and the old LWJGL 2 numbers
// (those are keyboard scancodes already; negative numbers are mouse buttons).
function scancode (value) {
  if (/^-?\d+$/.test(value)) {
    const n = Number(value)
    return n >= 0 ? n : { mouse: n + 100 }
  }
  const m = /^key\.(keyboard|mouse)\.(.+)$/.exec(value)
  if (!m) return null
  if (m[1] === 'mouse') return { mouse: { left: 0, right: 1, middle: 2 }[m[2]] ?? Number(m[2]) }
  return NAMED[m[2]] ?? null
}

function defaultDir () {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft')
  return path.join(os.homedir(), '.minecraft')
}

function readOptions (dir = defaultDir()) {
  const file = path.join(dir, 'options.txt')
  const raw = {}
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const i = line.indexOf(':')
      if (i > 0) raw[line.slice(0, i)] = line.slice(i + 1)
    }
  }
  const keys = {}
  for (const [name, def] of Object.entries(DEFAULT_KEYS)) {
    const code = scancode(raw[`key_key.${name}`] ?? def)
    if (code === null) throw new Error(`can't press the "${name}" key: options.txt binds it to ${raw[`key_key.${name}`]}`)
    keys[name] = code
  }
  if (typeof keys.attack !== 'object' || keys.attack.mouse !== 0) {
    throw new Error('attack must be bound to the left mouse button in Minecraft (Controls > Key Binds > Attack/Destroy)')
  }
  const problems = []
  if (raw.rawMouseInput === 'false') problems.push('Raw Input is off (Mouse Settings): turn it on so Windows mouse acceleration doesn\'t change how far the bot turns')
  if (raw.invertYMouse === 'true') problems.push('Invert Mouse is on: turn it off')
  if (raw.toggleSprint === 'true') problems.push('Sprint is set to Toggle: set it to Hold')
  if (raw.toggleCrouch === 'true') problems.push('Sneak is set to Toggle: set it to Hold')
  if (raw.pauseOnLostFocus !== 'false') problems.push('Pause on Lost Focus is on (press F3+P in game to turn it off)')
  return {
    file,
    found: fs.existsSync(file),
    sensitivity: raw.mouseSensitivity !== undefined ? Number(raw.mouseSensitivity) : 0.5,
    keys,
    problems
  }
}

module.exports = { readOptions, scancode, defaultDir }

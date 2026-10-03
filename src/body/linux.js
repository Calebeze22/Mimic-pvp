'use strict'

// Linux input for real-client mode: a small Python helper drives a virtual
// keyboard and mouse through uinput (works on Wayland and X11). Which window
// is in front is asked from the compositor where it can tell us (Hyprland,
// Sway); elsewhere the bot relies on F8 alone.

const fs = require('fs')
const path = require('path')
const { spawn, execFile } = require('child_process')

// Our key codes are PC scancodes; Linux key codes are the same numbers
// except for the extended keys.
const EXTENDED = { 0x11D: 97, 0x138: 100 }
const linuxKey = code => EXTENDED[code] ?? code

let helper = null
let f8Presses = 0
let active = null // what the compositor says is in front: {id, pid, title}
let compositor = null
let ready = false

function init (log = console.log) {
  helper = spawn('python3', [path.join(__dirname, 'uinput_helper.py')], { stdio: ['pipe', 'pipe', 'inherit'] })
  helper.on('error', e => log(`can't start the input helper (python3): ${e.message}`))
  helper.on('exit', code => { ready = false; log(`input helper stopped (${code}); the bot can't press anything`) })
  require('readline').createInterface({ input: helper.stdout }).on('line', line => {
    if (line === 'f8') f8Presses++
    else if (line.startsWith('ready')) {
      ready = true
      const n = Number(line.split(' ')[1])
      log(n ? `virtual keyboard and mouse ready; watching ${n} keyboard(s) for F8` : 'virtual keyboard and mouse ready, but no keyboard is readable for F8 (add yourself to the "input" group)')
    } else if (line.startsWith('error')) log(line.slice(6))
  })

  if (process.env.HYPRLAND_INSTANCE_SIGNATURE) compositor = 'hyprland'
  else if (process.env.SWAYSOCK) compositor = 'sway'
  if (compositor) {
    const poll = () => activeWindow().then(w => { active = w }).catch(() => { active = null })
    poll()
    setInterval(poll, 150).unref()
  } else {
    log('can\'t ask this desktop which window is in front, so only F8 decides when the bot plays. Press F8 before you switch away from the game.')
  }
}

function run (cmd, args) {
  return new Promise((resolve, reject) => execFile(cmd, args, { timeout: 1000 }, (err, out) => err ? reject(err) : resolve(out)))
}

async function activeWindow () {
  if (compositor === 'hyprland') {
    const w = JSON.parse(await run('hyprctl', ['activewindow', '-j']))
    return w && w.address ? { id: w.address, pid: w.pid, title: w.title || '', cls: w.class || '' } : null
  }
  const tree = JSON.parse(await run('swaymsg', ['-t', 'get_tree']))
  const find = n => n.focused ? n : [...(n.nodes || []), ...(n.floating_nodes || [])].map(find).find(Boolean)
  const w = find(tree)
  return w ? { id: String(w.id), pid: w.pid, title: w.name || '', cls: w.app_id || (w.window_properties && w.window_properties.class) || '' } : null
}

const isMinecraft = w => w && (/^Minecraft/i.test(w.title) || /minecraft/i.test(w.cls))

function send (s) { if (ready && helper && helper.stdin.writable) helper.stdin.write(s + '\n') }

function minecraftPids () {
  const out = []
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue
    try {
      const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8')
      if (/java/.test(cmd) && /net\.minecraft|--gameDir|minecraft/i.test(cmd)) out.push(Number(d))
    } catch (_) {}
  }
  return out
}

module.exports = {
  init,
  get ready () { return ready },
  moveMouse: (dx, dy) => send(`m ${dx} ${dy}`),
  leftDown: () => send('b 1'),
  leftUp: () => send('b 0'),
  key: (code, down) => send(`k ${linuxKey(code)} ${down ? 1 : 0}`),

  // The window to hand to the bot (called on F8).
  pickWindow () {
    if (compositor) return isMinecraft(active) ? active : null
    const pids = minecraftPids()
    return { id: 'any', pid: pids.length === 1 ? pids[0] : null, title: 'Minecraft (focus not checked on this desktop)' }
  },
  focusedId () { return compositor ? (active && active.id) : 'any' },
  takeF8 () {
    const n = f8Presses
    f8Presses = 0
    return n > 0
  },
  gameDirOf (pid) {
    if (!pid) return null
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      const i = args.indexOf('--gameDir')
      return i >= 0 ? args[i + 1] : null
    } catch (_) { return null }
  },
  defaultMcDir: () => path.join(require('os').homedir(), '.minecraft'),
  stop () { if (helper) helper.kill() }
}

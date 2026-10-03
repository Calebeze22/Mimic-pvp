'use strict'

// The few Windows calls the real-client mode needs: SendInput for keys and
// the mouse (the same path a physical keyboard and mouse take), and the
// foreground window, so input only ever goes to the Minecraft window.

if (process.platform !== 'win32') throw new Error('Real-client mode drives a Minecraft window with Windows input, so it only runs on Windows.')

const koffi = require('koffi')
const user32 = koffi.load('user32.dll')
const winmm = koffi.load('winmm.dll')

const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, void *pInputs, int cbSize)')
const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hWnd, _Out_ uint16_t *lpString, int nMaxCount)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(void *hWnd, _Out_ uint16_t *lpClassName, int nMaxCount)')
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *lpdwProcessId)')
const GetAsyncKeyState =user32.func('int16_t __stdcall GetAsyncKeyState(int vKey)')
const timeBeginPeriod = winmm.func('uint32 __stdcall timeBeginPeriod(uint32 uPeriod)')

// INPUT is 40 bytes on 64-bit Windows: a DWORD type, padding, then the union.
const INPUT_SIZE = 40
const INPUT_MOUSE = 0
const INPUT_KEYBOARD = 1
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const KEYEVENTF_EXTENDEDKEY = 0x0001
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_SCANCODE = 0x0008

function send (buf) {
  return SendInput(1, buf, INPUT_SIZE)
}

function mouse (dx, dy, flags) {
  const b = Buffer.alloc(INPUT_SIZE)
  b.writeUInt32LE(INPUT_MOUSE, 0)
  b.writeInt32LE(dx, 8)
  b.writeInt32LE(dy, 12)
  b.writeUInt32LE(flags, 20)
  return send(b)
}

// Scancodes, not virtual keys: GLFW (Minecraft's window layer) maps keys by
// scancode. Codes above 0xFF are extended keys (0xE0 prefix).
function key (scancode, down) {
  const b = Buffer.alloc(INPUT_SIZE)
  b.writeUInt32LE(INPUT_KEYBOARD, 0)
  b.writeUInt16LE(scancode & 0xFF, 10)
  b.writeUInt32LE(KEYEVENTF_SCANCODE | (down ? 0 : KEYEVENTF_KEYUP) | (scancode > 0xFF ? KEYEVENTF_EXTENDEDKEY : 0), 12)
  return send(b)
}

function text (fn, hwnd) {
  const buf = new Uint16Array(256)
  const n = fn(hwnd, buf, 256)
  return String.fromCharCode(...buf.subarray(0, Math.max(0, n)))
}

// The window in front, if it's a Minecraft window (GLFW class, title
// starting "Minecraft"): its handle as a number, and its process id.
function foregroundMinecraft () {
  const h = GetForegroundWindow()
  if (!h) return null
  if (!text(GetClassNameW, h).startsWith('GLFW') || !/^Minecraft/i.test(text(GetWindowTextW, h))) return null
  const pid = [0]
  GetWindowThreadProcessId(h, pid)
  return { hwnd: Number(koffi.address(h)), pid: pid[0], title: text(GetWindowTextW, h) }
}

function foregroundHwnd () {
  const h = GetForegroundWindow()
  return h ? Number(koffi.address(h)) : 0
}

function minecraftFocused () { return foregroundMinecraft() !== null }

// The --gameDir a Minecraft process was started with, if any.
function gameDirOf (pid) {
  try {
    const cmd = require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', timeout: 15000 })
    const m = /--gameDir\s+(?:"([^"]+)"|(\S+))/.exec(cmd)
    return m ? (m[1] || m[2]) : null
  } catch (_) { return null }
}

function foregroundTitle () {
  const h = GetForegroundWindow()
  return h ? text(GetWindowTextW, h) : ''
}

function keyHeld (vk) { return (GetAsyncKeyState(vk) & 0x8000) !== 0 }

const VK_F8 = 0x77
let f8Down = false

module.exports = {
  init: () => timeBeginPeriod(1), // 1 ms timers, so mouse steps go out evenly
  ready: true,
  pickWindow () {
    const w = foregroundMinecraft()
    return w && { id: w.hwnd, pid: w.pid, title: w.title }
  },
  focusedId: foregroundHwnd,
  takeF8 () {
    const down = keyHeld(VK_F8)
    const pressed = down && !f8Down
    f8Down = down
    return pressed
  },
  defaultMcDir: () => require('path').join(process.env.APPDATA || '', '.minecraft'),
  stop () {},
  moveMouse: (dx, dy) => mouse(dx, dy, MOUSEEVENTF_MOVE),
  leftDown: () => mouse(0, 0, MOUSEEVENTF_LEFTDOWN),
  leftUp: () => mouse(0, 0, MOUSEEVENTF_LEFTUP),
  key,
  minecraftFocused,
  foregroundMinecraft,
  foregroundHwnd,
  gameDirOf,
  foregroundTitle,
  keyHeld,
  timeBeginPeriod
}

'use strict'

const net = require('net')

// Minimal Source RCON client (what Minecraft servers speak on rcon.port).
// Packet: int32 length | int32 id | int32 type | body \0 | \0, little endian.
const AUTH = 3
const COMMAND = 2

function encode (id, type, body) {
  const b = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(14 + b.length)
  buf.writeInt32LE(10 + b.length, 0)
  buf.writeInt32LE(id, 4)
  buf.writeInt32LE(type, 8)
  b.copy(buf, 12)
  return buf
}

// Pulls whole packets out of a byte stream; returns [packets, leftover].
function decode (buf) {
  const out = []
  while (buf.length >= 4) {
    const len = buf.readInt32LE(0)
    if (buf.length < 4 + len) break
    out.push({ id: buf.readInt32LE(4), type: buf.readInt32LE(8), body: buf.toString('utf8', 12, 4 + len - 2) })
    buf = buf.subarray(4 + len)
  }
  return [out, buf]
}

class Rcon {
  constructor (host, port, password) {
    Object.assign(this, { host, port, password })
    this.nextId = 1
    this.pending = new Map()
    this.buf = Buffer.alloc(0)
  }

  connect () {
    return new Promise((resolve, reject) => {
      this.sock = net.connect(this.port, this.host)
      this.sock.on('error', e => { for (const p of this.pending.values()) p.reject(e); this.pending.clear(); reject(e) })
      this.sock.on('data', d => {
        let packets
        ;[packets, this.buf] = decode(Buffer.concat([this.buf, d]))
        for (const p of packets) {
          if (p.id === -1) { // auth failure
            for (const q of this.pending.values()) q.reject(new Error('RCON password rejected'))
            this.pending.clear()
            continue
          }
          const q = this.pending.get(p.id)
          if (q && (p.type === 0 || q.auth)) { this.pending.delete(p.id); q.resolve(p.body) }
        }
      })
      this.sock.on('connect', () => this._send(AUTH, this.password, true).then(() => resolve(this), reject))
    })
  }

  _send (type, body, auth = false) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, auth })
      this.sock.write(encode(id, type, body))
    })
  }

  send (command) { return this._send(COMMAND, command) }

  close () { if (this.sock) this.sock.end() }
}

module.exports = { Rcon, encode, decode }

'use strict'

// Checks the arena's RCON client against a fake RCON server and its log
// parsing against real-format Paper console lines. No Minecraft needed.
const assert = require('assert')
const net = require('net')
const { Rcon, encode, decode } = require('../arena/rcon')
const { chatLine, deathLine, grimLine } = require('../arena/logparse')

async function rconTest () {
  const seen = []
  const srv = net.createServer(sock => {
    let buf = Buffer.alloc(0)
    sock.on('data', d => {
      let packets
      ;[packets, buf] = decode(Buffer.concat([buf, d]))
      for (const p of packets) {
        if (p.type === 3) sock.write(encode(p.body === 'secret' ? p.id : -1, 2, ''))
        else { seen.push(p.body); sock.write(encode(p.id, 0, `ran ${p.body}`)) }
      }
    })
  })
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve))
  const port = srv.address().port

  const r = await new Rcon('127.0.0.1', port, 'secret').connect()
  const out = await Promise.all([r.send('time set day'), r.send('op Caleb')])
  assert.deepStrictEqual(out, ['ran time set day', 'ran op Caleb'])
  assert.deepStrictEqual(seen, ['time set day', 'op Caleb'])
  r.close()

  const bad = new Rcon('127.0.0.1', port, 'wrong')
  await assert.rejects(bad.connect(), /password rejected/)
  bad.close()
  srv.close()
}

function parseTest () {
  assert.deepStrictEqual(chatLine('[21:01:02 INFO]: <Caleb> !duel good'), { user: 'Caleb', msg: '!duel good' })
  assert.deepStrictEqual(chatLine('[21:01:02 INFO]: [Not Secure] <Caleb> !duel'), { user: 'Caleb', msg: '!duel' })
  assert.strictEqual(chatLine('[21:01:02 INFO]: Caleb joined the game'), null)

  const names = ['Caleb', 'Mimic']
  assert.strictEqual(deathLine('[21:01:02 INFO]: Caleb was slain by Mimic', names).victim, 'Caleb')
  assert.strictEqual(deathLine('[21:01:02 INFO]: Mimic was slain by Caleb using [Diamond Sword]', names).victim, 'Mimic')
  assert.strictEqual(deathLine('[21:01:02 INFO]: Mimic fell from a high place', names).victim, 'Mimic')
  assert.strictEqual(deathLine('[21:01:02 INFO]: Caleb joined the game', names), null)
  assert.strictEqual(deathLine('[21:01:02 INFO]: Caleb lost connection: Disconnected', names), null)
  assert.strictEqual(deathLine('[21:01:02 INFO]: <Caleb> Mimic was slain lol', names), null)
  assert.strictEqual(deathLine('[21:01:02 INFO]: Caleb issued server command: /kill Mimic', names), null)

  const g = grimLine('[21:01:02 INFO]: \x1b[0;37mGrimAC \x1b[0;31m» Mimic failed Reach (x2) 3.04 blocks')
  assert.deepStrictEqual(g, { player: 'Mimic', check: 'Reach', vl: 2, detail: '3.04 blocks' })
  assert.strictEqual(grimLine('§bGrim §f» §fMimic §bfailed §fAimModulo360 §f(x§c1§f)').check, 'AimModulo360')
  assert.strictEqual(grimLine('[21:01:02 INFO]: <Caleb> hello'), null)
}

;(async () => {
  parseTest()
  await rconTest()
  console.log('arena unit tests passed')
})().catch(e => { console.error(e); process.exit(1) })

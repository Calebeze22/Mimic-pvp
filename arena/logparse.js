'use strict'

// Reads Paper server console lines. Kept separate from run.js so it can be
// unit tested without a server.

const strip = s => s.replace(/\x1b\[[0-9;]*m/g, '').replace(/§[0-9a-fk-orx]/gi, '')

// "[12:00:00 INFO]: <Caleb> !duel good" -> { user, msg }
function chatLine (line) {
  const m = strip(line).match(/\]: (?:\[Not Secure\] )?<([A-Za-z0-9_]{1,16})> (.*)$/)
  return m ? { user: m[1], msg: m[2].trim() } : null
}

// Vanilla death messages always start with the victim's name followed by one
// of these words ("Caleb was slain by Mimic", "Mimic fell from a high place").
const DEATH_VERBS = /^(was|died|fell|drowned|burned|blew|hit|walked|went|tried|froze|starved|suffocated|experienced|withered|discovered|didn't|left the confines|was squashed|was poked|was impaled|was skewered)\b/

function deathLine (line, names) {
  const text = strip(line).split(']: ').slice(1).join(']: ')
  if (!text || text.startsWith('<')) return null
  for (const name of names) {
    if (!text.startsWith(name + ' ')) continue
    const rest = text.slice(name.length + 1)
    if (/^(joined|left the game|lost connection|issued server command|logged in|moved)/.test(rest)) return null
    if (DEATH_VERBS.test(rest)) return { victim: name, text }
  }
  return null
}

// Grim alert, e.g. "GrimAC » Mimic failed Reach (x2) 3.12 blocks"
function grimLine (line) {
  const m = strip(line).match(/([A-Za-z0-9_]{1,16}) failed ([A-Za-z0-9_ ]+?) \(x(\d+)\)\s*(.*)$/)
  return m ? { player: m[1], check: m[2].trim(), vl: Number(m[3]), detail: m[4] } : null
}

module.exports = { strip, chatLine, deathLine, grimLine }

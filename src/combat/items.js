'use strict'

// Vanilla attack speed (attacks/s at full charge) and base damage by item.
// Cooldown period in ticks is 20 / speed.
const TIERS = ['netherite', 'diamond', 'iron', 'stone', 'golden', 'wooden', 'copper']
const SWORD_DMG = { netherite: 8, diamond: 7, iron: 6, copper: 5, stone: 5, golden: 4, wooden: 4 }
const AXE_DMG = { netherite: 10, diamond: 9, iron: 9, copper: 9, stone: 9, golden: 7, wooden: 7 }
const AXE_SPEED = { netherite: 1.0, diamond: 1.0, iron: 0.9, copper: 0.8, stone: 0.8, golden: 1.0, wooden: 0.8 }

function tierOf (name) {
  return TIERS.find(t => name.startsWith(t + '_')) || 'wooden'
}

function weaponStats (item) {
  if (!item) return { kind: 'hand', speed: 4, damage: 1 }
  const n = item.name
  if (n.endsWith('_sword')) return { kind: 'sword', speed: 1.6, damage: SWORD_DMG[tierOf(n)] ?? 4 }
  if (n.endsWith('_axe')) { const t = tierOf(n); return { kind: 'axe', speed: AXE_SPEED[t], damage: AXE_DMG[t] } }
  if (n === 'trident') return { kind: 'trident', speed: 1.1, damage: 9 }
  if (n === 'mace') return { kind: 'mace', speed: 0.6, damage: 6 }
  if (n.endsWith('_pickaxe')) return { kind: 'tool', speed: 1.2, damage: 3 }
  if (n.endsWith('_shovel')) return { kind: 'tool', speed: 1.0, damage: 3 }
  return { kind: 'hand', speed: 4, damage: 1 }
}

function cooldownTicks (item) { return 20 / weaponStats(item).speed }

// Rough "how good is this as a main weapon" for picking the hotbar slot:
// damage per full-charge hit times hits per second, with crits counted.
function weaponScore (item) {
  const s = weaponStats(item)
  if (s.kind === 'hand' || s.kind === 'tool') return s.damage * 0.5
  const ench = enchantLevel(item, 'sharpness')
  const dmg = s.damage + (ench > 0 ? 0.5 * ench + 0.5 : 0)
  return dmg * 1.5 * Math.min(s.speed, 1.6)
}

function enchantLevel (item, name) {
  try {
    const list = item.enchants || []
    const e = list.find(x => x.name === name || x.name === 'minecraft:' + name)
    return e ? e.lvl : 0
  } catch (_) { return 0 }
}

const ARMOR_ORDER = ['netherite', 'diamond', 'iron', 'chainmail', 'copper', 'golden', 'leather', 'turtle']
const ARMOR_SLOTS = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' }

function armorInfo (item) {
  if (!item) return null
  for (const [piece, dest] of Object.entries(ARMOR_SLOTS)) {
    if (item.name.endsWith('_' + piece) || (piece === 'helmet' && item.name === 'turtle_helmet')) {
      const mat = item.name.split('_')[0]
      const rank = ARMOR_ORDER.indexOf(mat)
      return { dest, rank: rank < 0 ? 99 : rank }
    }
  }
  return null
}

module.exports = { weaponStats, cooldownTicks, weaponScore, armorInfo, enchantLevel }

'use strict'

const { Vec3 } = require('vec3')

// Mineflayer angle convention (radians): yaw 0 faces -Z, pitch > 0 looks up.
const TAU = Math.PI * 2

function wrapAngle (a) {
  a = (a + Math.PI) % TAU
  if (a < 0) a += TAU
  return a - Math.PI
}

function anglesTo (from, to) {
  const d = to.minus(from)
  const yaw = Math.atan2(-d.x, -d.z)
  const pitch = Math.atan2(d.y, Math.sqrt(d.x * d.x + d.z * d.z))
  return { yaw, pitch }
}

function lookVector (yaw, pitch) {
  const c = Math.cos(pitch)
  return new Vec3(-Math.sin(yaw) * c, Math.sin(pitch), -Math.cos(yaw) * c)
}

function eyePos (entity) {
  return entity.position.offset(0, entity.eyeHeight ?? 1.62, 0)
}

function hitbox (entity, pos = entity.position) {
  const w = (entity.width ?? 0.6) / 2
  const h = entity.height ?? 1.8
  return { min: new Vec3(pos.x - w, pos.y, pos.z - w), max: new Vec3(pos.x + w, pos.y + h, pos.z + w) }
}

// Slab test. Returns distance along the ray to the box, or null.
function rayBox (origin, dir, box) {
  let tmin = -Infinity
  let tmax = Infinity
  for (const ax of ['x', 'y', 'z']) {
    if (Math.abs(dir[ax]) < 1e-9) {
      if (origin[ax] < box.min[ax] || origin[ax] > box.max[ax]) return null
      continue
    }
    let t1 = (box.min[ax] - origin[ax]) / dir[ax]
    let t2 = (box.max[ax] - origin[ax]) / dir[ax]
    if (t1 > t2) [t1, t2] = [t2, t1]
    tmin = Math.max(tmin, t1)
    tmax = Math.min(tmax, t2)
    if (tmin > tmax) return null
  }
  if (tmax < 0) return null
  return Math.max(tmin, 0)
}

// Shortest distance from a point to a box (what the server's reach check uses).
function pointBoxDistance (p, box) {
  const dx = Math.max(box.min.x - p.x, 0, p.x - box.max.x)
  const dy = Math.max(box.min.y - p.y, 0, p.y - box.max.y)
  const dz = Math.max(box.min.z - p.z, 0, p.z - box.max.z)
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

function horizontalDist (a, b) {
  const dx = a.x - b.x
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dz * dz)
}

module.exports = { wrapAngle, anglesTo, lookVector, eyePos, hitbox, rayBox, pointBoxDistance, horizontalDist, TAU }

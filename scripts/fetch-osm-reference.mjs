#!/usr/bin/env node
/**
 * Fetch the two reference layers the road generator needs:
 *
 *   .cache/osm/states.json  — India's state/UT polygons (admin_level=4)
 *   .cache/osm/places.json  — city / town / village place nodes
 *
 * Both are cached per state and per band, so an interrupted run resumes where
 * it stopped and re-running is free. --force refetches; --assemble rebuilds the
 * two combined files from whatever shards are already on disk, offline.
 * Data © OpenStreetMap contributors, ODbL.
 */
import { existsSync, readdirSync } from 'node:fs'
import {
  cachePath, haversineKm, overpass, readCache, round5, simplify, sleep, writeCache,
} from './lib/overpass.mjs'

const FORCE = process.argv.includes('--force')
const ASSEMBLE = process.argv.includes('--assemble')
const VILLAGES = process.argv.includes('--villages')

if (ASSEMBLE) {
  const states = (existsSync(cachePath('states')) ? readdirSync(cachePath('states')) : [])
    .map((f) => readCache('states', f))
    .filter(Boolean)
  const places = (existsSync(cachePath('places')) ? readdirSync(cachePath('places')) : [])
    .flatMap((f) => readCache('places', f) ?? [])
  if (states.length) writeCache(states, 'states.json')
  if (places.length) writeCache(places, 'places.json')
  console.log(`✓ assembled from cache: ${states.length} states/UTs, ${places.length} places`)
  process.exit(0)
}

// ── states ───────────────────────────────────────────────────────────

/** Stitch unordered way geometries into closed rings. */
function buildRings(ways) {
  const segs = ways.map((w) => w.map((g) => [g.lon, g.lat])).filter((s) => s.length > 1)
  const rings = []
  while (segs.length) {
    let ring = segs.shift()
    let guard = segs.length * 2 + 10
    while (guard-- > 0) {
      const head = ring[0]
      const tail = ring[ring.length - 1]
      if (haversineKm(head, tail) < 0.001 && ring.length > 3) break // closed
      let best = { d: Infinity, i: -1, rev: false }
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i]
        const a = haversineKm(tail, s[0])
        const b = haversineKm(tail, s[s.length - 1])
        if (a < best.d) best = { d: a, i, rev: false }
        if (b < best.d) best = { d: b, i, rev: true }
      }
      if (best.i === -1 || best.d > 1) break // give up on this ring
      const seg = segs.splice(best.i, 1)[0]
      ring = ring.concat((best.rev ? [...seg].reverse() : seg).slice(1))
    }
    if (ring.length > 3) rings.push(ring)
  }
  return rings
}

// The combined files are outputs, never a reason to skip work — resuming has
// to be driven by the per-state and per-band shards, or a run that died with
// seven states missing would look complete forever.
async function fetchStates() {
  console.log('states: listing admin_level=4 relations in India…')
  const list = await overpass(`
    relation["boundary"="administrative"]["admin_level"="4"]["ISO3166-2"~"^IN-"];
    out tags;
  `)
  const rels = (list.elements ?? []).filter((e) => e.tags?.name)
  console.log(`states: ${rels.length} state/UT relations`)

  const states = []
  for (const rel of rels) {
    const name = rel.tags['name:en'] ?? rel.tags.name
    // cached per state so a slow or failed state never costs the whole run
    const hit = FORCE ? null : readCache('states', `${rel.id}.json`)
    if (hit) {
      states.push(hit)
      console.log(`  · ${name}: cached`)
      continue
    }
    let json = null
    try {
      json = await overpass(`relation(${rel.id});out geom;`, { timeout: 240, retries: 2 })
    } catch (e) {
      console.log(`  ! ${name}: ${e.message} — skipped`)
      continue
    }
    const r = (json.elements ?? []).find((e) => e.type === 'relation')
    const outer = (r?.members ?? []).filter(
      (m) => m.type === 'way' && Array.isArray(m.geometry) && (!m.role || m.role === 'outer'),
    )
    const rings = buildRings(outer.map((m) => m.geometry))
      .map((ring) => simplify(ring, 0.4).map(([x, y]) => [round5(x), round5(y)]))
      .filter((ring) => ring.length > 3)
    if (!rings.length) {
      console.log(`  ! ${name}: no usable rings — skipped`)
      continue
    }
    const flat = rings.flat()
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of flat) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    const entry = { name, iso: rel.tags['ISO3166-2'] ?? '', bbox: [minX, minY, maxX, maxY], rings }
    writeCache(entry, 'states', `${rel.id}.json`)
    states.push(entry)
    console.log(`  ✓ ${name}: ${rings.length} ring(s), ${flat.length} pts`)
    await sleep(900)
  }
  writeCache(states, 'states.json')
  return states
}

// ── places ───────────────────────────────────────────────────────────

async function fetchPlaces() {
  const out = []
  // Towns and suburbs name every road well enough on their own. Villages
  // outnumber them ~50:1 and cost an hour of Overpass time for a marginally
  // better waypoint here and there, so they are opt-in (--villages). Either
  // way each latitude band is cached, so a band that fails costs only itself.
  const tiers = [
    { kinds: 'city|town|suburb', bands: 2 },
    ...(VILLAGES ? [{ kinds: 'village', bands: 10 }] : []),
  ]
  for (const tier of tiers) {
    for (let b = 0; b < tier.bands; b++) {
      const tag = `${tier.kinds.replace(/\W/g, '')}-${b}`
      const hit = FORCE ? null : readCache('places', `${tag}.json`)
      if (hit) {
        out.push(...hit)
        console.log(`places: ${tag} cached (${hit.length})`)
        continue
      }
      const south = 6.0 + ((37.5 - 6.0) / tier.bands) * b
      const north = 6.0 + ((37.5 - 6.0) / tier.bands) * (b + 1)
      const box = `(${south.toFixed(2)},67.5,${north.toFixed(2)},97.6)`
      process.stdout.write(`places: fetching ${tier.kinds} band ${b + 1}/${tier.bands}… `)
      let json = null
      try {
        json = await overpass(`node["place"~"^(${tier.kinds})$"]["name"]${box};out;`, { timeout: 300, retries: 2 })
      } catch (e) {
        console.log(`failed (${e.message}) — continuing without this band`)
        continue
      }
      const band = []
      for (const n of json.elements ?? []) {
        if (typeof n.lat !== 'number' || typeof n.lon !== 'number') continue
        const name = n.tags?.['name:en'] ?? n.tags?.name
        if (!name || !/[A-Za-z]/.test(name)) continue
        band.push({
          n: name,
          k: n.tags.place,
          p: Number.parseInt(String(n.tags.population ?? '').replace(/\D/g, ''), 10) || 0,
          c: [round5(n.lon), round5(n.lat)],
        })
      }
      writeCache(band, 'places', `${tag}.json`)
      out.push(...band)
      console.log(`${band.length}`)
      await sleep(1200)
    }
  }
  console.log(`places: ${out.length} total`)
  writeCache(out, 'places.json')
  return out
}

const states = await fetchStates()
const places = await fetchPlaces()
console.log(`\n✓ reference layers ready — ${states.length} states/UTs, ${places.length} places`)

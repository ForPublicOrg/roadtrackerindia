import type {
  Helpline,
  OrgProfile,
  OrgRef,
  OrgRole,
  OrgSummary,
  RoadDetail,
  TollRates,
  VehicleClass,
} from './types'
import { esc, STATUS_LABEL } from './ui'
import { formatKm } from './geo'
import { loadOrg, loadOrgIndex } from './data'
import { state } from './state'

/**
 * Numbers that are correct everywhere in India, so every road page shows them
 * whatever is (or isn't) on file for that road. Never sourced from the corpus —
 * a data mistake must not be able to take these away.
 */
const NATIONAL: Helpline[] = [
  {
    kind: 'emergency',
    label: 'Emergency — police, fire, ambulance',
    number: '112',
    note: 'One number for any emergency, anywhere in India',
  },
  { kind: 'emergency', label: 'Ambulance', number: '108', note: 'Free ambulance in most states' },
  { kind: 'emergency', label: 'Road accident helpline', number: '1073' },
]

/** NHAI's 1033 covers every national highway, whoever maintains the stretch. */
const NATIONAL_HIGHWAY: Helpline[] = [
  {
    kind: 'emergency',
    label: 'Highway emergency — ambulance, crane, road blocked',
    number: '1033',
    note: 'NHAI, 24×7, free from any phone',
    via: 'NHAI',
  },
  {
    kind: 'complaint',
    label: 'Toll, FASTag and road condition complaints',
    number: '1033',
    note: 'The same number takes complaints',
    via: 'NHAI',
  },
]

let orgIndex: Map<string, OrgSummary> | null = null

/** Warm the org index so `orgName()` can label chips without another fetch. */
export async function initOrgs(): Promise<void> {
  try {
    const idx = await loadOrgIndex()
    orgIndex = new Map(idx.orgs.map((o) => [o.id, o]))
  } catch {
    orgIndex = new Map() // no profiles on file — chips fall back to plain names
  }
}

export const orgSummary = (id: string): OrgSummary | undefined => orgIndex?.get(id)
export const orgKnown = (id: string | undefined): boolean => !!id && !!orgIndex?.has(id)

/**
 * Every number worth showing on a road page, best-first: the road's own, then
 * its authority's, then the ones that are true everywhere. Deduplicated by
 * number and kind, because a road repeating its authority's helpline is noise.
 */
export function helplinesFor(d: RoadDetail, authority: OrgProfile | null): Helpline[] {
  const national = d.category === 'nh' ? [...NATIONAL_HIGHWAY, ...NATIONAL] : NATIONAL
  const fromOrg = (authority?.helplines ?? []).map((h) => ({
    ...h,
    via: authority?.shortName ?? authority?.name,
  }))
  const seen = new Set<string>()
  return [...(d.helplines ?? []), ...fromOrg, ...national].filter((h) => {
    const key = `${h.kind}:${h.number}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ── rendering ──────────────────────────────────────────────────────

const CLASS_LABEL: Record<VehicleClass, string> = {
  car: 'Car, jeep, van',
  lcv: 'Light goods vehicle, mini-bus',
  bus: 'Bus or truck',
  axle3: '3-axle truck',
  hcm: 'Heavy machinery, 4–6 axle',
  oversized: 'Oversized (7+ axle)',
}
const CLASS_ORDER: VehicleClass[] = ['car', 'lcv', 'bus', 'axle3', 'hcm', 'oversized']

const rupee = (n: number) => `₹${n.toLocaleString('en-IN')}`

/** A date the reader can judge for themselves — toll rates change every April. */
function asOfLabel(iso: string): string {
  const d = new Date(`${iso}T00:00:00`)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
}

/** A tappable chip for an organisation, or plain text when we have no profile. */
function orgChip(ref: OrgRef): string {
  const summary = ref.org ? orgSummary(ref.org) : undefined
  const label = summary ? (summary.shortName ?? summary.name) : (ref.name ?? ref.org ?? '')
  if (!label) return ''
  const note = ref.note ? `<span class="og-note">${esc(ref.note)}</span>` : ''
  if (!summary) return `<span class="og-chip is-plain">${esc(label)}${note}</span>`
  return `<button class="og-chip" data-org="${esc(summary.id)}" title="${esc(summary.name)}">
    <span class="og-name">${esc(label)}</span>${note}</button>`
}

function orgChipRow(title: string, refs: OrgRef[] | undefined): string {
  if (!refs?.length) return ''
  const chips = refs.map(orgChip).filter(Boolean).join('')
  if (!chips) return ''
  return `<div class="og-row"><span class="og-label">${esc(title)}</span><div class="og-chips">${chips}</div></div>`
}

/** "Who's behind this road" — authority, builders and operator, all linkable. */
export function behindHtml(d: RoadDetail): string {
  const rows = [
    orgChipRow('Looked after by', d.authority ? [{ org: d.authority }] : undefined),
    orgChipRow('Built by', d.builtBy),
    orgChipRow('Run today by', d.operatedBy),
  ]
    .filter(Boolean)
    .join('')
  if (!rows) return ''
  return `<div class="rd-section"><h3>Who's behind this road</h3>${rows}</div>`
}

function ratesTable(rates: TollRates): string {
  const rows = CLASS_ORDER.filter((c) => typeof rates[c] === 'number')
    .map((c) => `<tr><th scope="row">${CLASS_LABEL[c]}</th><td>${rupee(rates[c]!)}</td></tr>`)
    .join('')
  return rows ? `<table class="toll-table"><tbody>${rows}</tbody></table>` : ''
}

/** Toll charges: what it costs, when that was true, and where the figure came from. */
export function tollHtml(d: RoadDetail): string {
  const info = d.tollInfo
  const plazas = d.tolls ?? []
  const withRates = plazas.filter((p) => p.rates && Object.keys(p.rates).length)

  if (info?.tolled === false) {
    return `<div class="rd-section"><h3>Toll</h3>
      <p class="toll-free"><b>Free to use.</b>${info.note ? ` ${esc(info.note)}` : ''}</p></div>`
  }
  if (!plazas.length && !info?.endToEnd) return ''

  const endToEnd = info?.endToEnd
    ? `<div class="toll-block"><h4>Whole road, one way</h4>${ratesTable(info.endToEnd)}</div>`
    : ''
  const perPlaza = withRates.length
    ? withRates
        .map(
          (p) => `<div class="toll-block"><h4>${esc(p.name)}</h4>${
            p.note ? `<p class="toll-note">${esc(p.note)}</p>` : ''
          }${ratesTable(p.rates!)}</div>`,
        )
        .join('')
    : ''

  // no rates on file yet — still worth naming the plazas people will stop at
  const plazaList =
    !endToEnd && !perPlaza
      ? `<ul class="rd-list">${plazas
          .map(
            (p) =>
              `<li>${esc(p.name)}${p.note ? ` <span style="color:var(--ink-2)">— ${esc(p.note)}</span>` : ''}</li>`,
          )
          .join('')}</ul>
         <p class="rating-note">We don't have the rate card for this road yet — the toll plaza displays current rates, and NHAI's 1033 helpline can confirm them.</p>`
      : ''

  const meta: string[] = []
  if (info?.asOf) meta.push(`Rates as they stood on ${asOfLabel(info.asOf)}`)
  meta.push('Indian toll rates are revised every year on 1 April')
  const passes = info?.passes?.length
    ? `<ul class="rd-list toll-passes">${info.passes.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>`
    : ''
  const source = info?.source
    ? ` · <a href="${esc(info.source.url)}" target="_blank" rel="noopener noreferrer">${esc(info.source.title)}</a>`
    : ''

  return `<div class="rd-section"><h3>Toll charges</h3>
    ${endToEnd}${perPlaza}${plazaList}
    ${info?.note ? `<p class="toll-note">${esc(info.note)}</p>` : ''}
    ${passes}
    ${endToEnd || perPlaza ? `<p class="rating-note">${meta.join(' · ')}${source}</p>` : ''}
  </div>`
}

/** Emergency and complaint numbers, tappable on a phone. */
export function contactsHtml(list: Helpline[], grievance: OrgProfile['grievance']): string {
  if (!list.length) return ''
  const row = (h: Helpline) => `
    <a class="hl-row hl-${esc(h.kind)}" href="tel:${esc(h.number.replace(/[^+\d]/g, ''))}">
      <span class="hl-main">
        <span class="hl-label">${esc(h.label)}</span>
        ${h.note || h.via ? `<span class="hl-note">${esc([h.note, h.via && `via ${h.via}`].filter(Boolean).join(' · '))}</span>` : ''}
      </span>
      <span class="hl-number">${esc(h.number)}</span>
    </a>`

  const emergency = list.filter((h) => h.kind === 'emergency' || h.kind === 'control-room')
  const complaint = list.filter((h) => h.kind === 'complaint' || h.kind === 'info')
  const written = grievance?.url
    ? `<p class="rating-note">Complain in writing: <a href="${esc(grievance.url)}" target="_blank" rel="noopener noreferrer">${esc(
        grievance.app ? `${grievance.app} — ${new URL(grievance.url).host}` : new URL(grievance.url).host,
      )}</a>${grievance.note ? ` — ${esc(grievance.note)}` : ''}</p>`
    : ''

  return `<div class="rd-section rd-contacts">
    <h3>If something goes wrong</h3>
    ${emergency.length ? `<div class="hl-group">${emergency.map(row).join('')}</div>` : ''}
    ${complaint.length ? `<h4 class="hl-head">To complain</h4><div class="hl-group">${complaint.map(row).join('')}</div>` : ''}
    ${written}
  </div>`
}

// ── company profile ────────────────────────────────────────────────

const TYPE_LABEL: Record<string, string> = {
  authority: 'Government authority',
  pwd: 'State public works department',
  psu: 'Government company',
  developer: 'Road developer',
  contractor: 'Construction company',
  operator: 'Road operator',
}

/** Roads an org touched, grouped by what it did — built, runs, or looks after. */
function roadGroup(title: string, ids: { id: string; note?: string }[]): string {
  if (!ids.length) return ''
  const rows = ids
    .map(({ id, note }) => {
      const s = state.byId.get(id)
      if (!s) return ''
      return `<li><button class="br-row" data-id="${esc(id)}">
        <span class="sr-badge cat-${esc(s.category)}">${esc(s.ref.length <= 9 ? s.ref : s.ref.split(/[\s–—]/)[0])}</span>
        <span class="sr-main">
          <span class="sr-title">${esc(s.name)}</span>
          <span class="sr-sub">${esc(s.start.split(',')[0])} → ${esc(s.end.split(',')[0])} · ${
            STATUS_LABEL[s.status]
          }${note ? ` · ${esc(note)}` : ''}</span>
        </span>
        <span class="br-len">${formatKm(s.lengthKm)}</span>
      </button></li>`
    })
    .filter(Boolean)
    .join('')
  if (!rows) return ''
  return `<div class="rd-section"><h3>${esc(title)}</h3><ul class="br-list">${rows}</ul></div>`
}

function statTile(value: string, label: string): string {
  return `<div class="og-stat"><b>${esc(value)}</b><span>${esc(label)}</span></div>`
}

export function renderOrgProfile(org: OrgProfile): string {
  const s = org.stats
  const known = org.roads.filter((r) => state.byId.has(r.id))
  const tiles = [
    known.length ? statTile(String(known.length), known.length === 1 ? 'road on file' : 'roads on file') : '',
    s.lengthKm ? statTile(formatKm(s.lengthKm), 'of road') : '',
    s.builtCount ? statTile(String(s.builtCount), s.builtCount === 1 ? 'road built' : 'roads built') : '',
    s.underConstruction ? statTile(String(s.underConstruction), 'being built now') : '',
  ]
    .filter(Boolean)
    .join('')

  // The cost sum only means something next to how many roads it covers — say both.
  const spend = s.costCrore
    ? `<p class="og-spend"><b>₹${s.costCrore.toLocaleString('en-IN')} crore</b> — the combined published cost of ${
        s.costedRoads
      } of these ${known.length} roads. Project costs, not this organisation's earnings.</p>`
    : ''

  const kv: string[] = []
  if (org.founded) kv.push(`<dt>Started</dt><dd>${esc(org.founded)}</dd>`)
  if (org.headquarters) kv.push(`<dt>Based in</dt><dd>${esc(org.headquarters)}</dd>`)
  if (org.ownership) kv.push(`<dt>Owned by</dt><dd>${esc(org.ownership)}</dd>`)
  if (s.states.length)
    kv.push(
      `<dt>Works in</dt><dd>${
        s.states.length > 4 ? `${s.states.length} states and UTs` : esc(s.states.join(', '))
      }</dd>`,
    )
  if (org.website)
    kv.push(
      `<dt>Website</dt><dd><a href="${esc(org.website)}" target="_blank" rel="noopener noreferrer">${esc(
        new URL(org.website).host,
      )}</a></dd>`,
    )

  const byRole = (role: OrgRole) =>
    known.filter((r) => r.roles.includes(role)).map((r) => ({ id: r.id, note: r.notes?.[role] }))

  return `
    <div class="rd-head">
      <span class="rd-ref og-type">${esc(TYPE_LABEL[org.type] ?? org.type)}</span>
      <h2 class="rd-name" tabindex="-1">${esc(org.name)}</h2>
      <button class="rd-close" id="rd-close" aria-label="Close">
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>
        </svg>
      </button>
    </div>
    ${org.aka?.length ? `<p class="rd-aka">Also known as: ${org.aka.map(esc).join(' · ')}</p>` : ''}
    <p class="og-summary">${esc(org.summary)}</p>
    ${tiles ? `<div class="og-stats">${tiles}</div>` : ''}
    ${spend}
    ${kv.length ? `<div class="rd-section"><dl class="kv">${kv.join('')}</dl></div>` : ''}
    ${org.about ? `<div class="rd-section"><h3>About</h3><p class="rd-history">${esc(org.about)}</p></div>` : ''}
    ${
      org.facts?.length
        ? `<div class="rd-section"><h3>Good to know</h3><ul class="rd-list">${org.facts
            .map((f) => `<li>${esc(f)}</li>`)
            .join('')}</ul></div>`
        : ''
    }
    ${contactsHtml(org.helplines ?? [], org.grievance)}
    ${roadGroup('Roads it built', byRole('built'))}
    ${roadGroup('Roads it runs today', byRole('operates'))}
    ${roadGroup('Roads it looks after', byRole('authority'))}
    ${
      known.length === 0
        ? `<div class="rd-section"><div class="rd-sparse">We haven't linked any roads to this organisation yet.</div></div>`
        : ''
    }
    <div class="rd-section"><h3>Sources</h3><div class="rd-sources">${org.sources
      .map(
        (src) => `<a href="${esc(src.url)}" target="_blank" rel="noopener noreferrer">
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2h6v6M10 2L2 10" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>${esc(
          src.title,
        )}</a>`,
      )
      .join('')}</div></div>`
}

export { loadOrg }

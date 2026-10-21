import type { LngLat, NetworkFC } from './types'
import { state } from './state'
import { nearestRoads } from './geo'
import { flyToPoint, setUserMarker } from './map'
import { toast } from './ui'

let selectRoad: (id: string, opts?: { skipFly?: boolean; at?: LngLat }) => void = () => {}
let loadDetailTier: () => Promise<NetworkFC> = () => Promise.reject(new Error('not wired'))

export function initLocate(select: typeof selectRoad, detail: typeof loadDetailTier): void {
  selectRoad = select
  loadDetailTier = detail
  const btn = document.getElementById('btn-locate')!
  btn.addEventListener('click', locate)
}

/**
 * The road under someone's feet is far more often a state or district road
 * than a highway, and those live in the detail tier — so wait for it rather
 * than snapping to an NH twenty kilometres off. If it will not load, the trunk
 * network on its own is still a better answer than none.
 */
async function nearestAnywhere(here: [number, number], trunk: NetworkFC, n: number) {
  let detail = state.networkDetail
  if (!detail) detail = await loadDetailTier().catch(() => null)
  const near = nearestRoads(here, trunk, n)
  if (detail) near.push(...nearestRoads(here, detail, n))
  return near.sort((a, b) => a.distKm - b.distKm).slice(0, n)
}

function locate(): void {
  const btn = document.getElementById('btn-locate')!
  if (!('geolocation' in navigator)) {
    toast("Your browser doesn't support location — try searching for a road instead.")
    return
  }
  if (!window.isSecureContext) {
    toast('Location needs a secure (https) connection — try searching instead.')
    return
  }
  btn.classList.add('is-busy')
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const here: [number, number] = [pos.coords.longitude, pos.coords.latitude]
      setUserMarker(here)
      if (!state.network) {
        btn.classList.remove('is-busy')
        flyToPoint(here)
        return
      }
      const near = await nearestAnywhere(here, state.network, 3)
      btn.classList.remove('is-busy')
      const best = near[0]
      if (!best) {
        flyToPoint(here)
        toast("We couldn't find a catalogued road near you yet.")
        return
      }
      if (best.distKm <= 2.5) {
        toast(`You're on or right next to ${best.ref} — ${best.name}`)
        // close enough that the stretch you're on is the one you'd review
        selectRoad(best.id, { skipFly: true, at: here })
        flyToPoint(here, 12)
      } else if (best.distKm <= 25) {
        toast(`Nearest catalogued road: ${best.ref}, about ${Math.round(best.distKm)} km away`)
        selectRoad(best.id, { skipFly: true })
        flyToPoint(here, 10)
      } else {
        flyToPoint(here, 9)
        const names = near.map((n) => n.ref).join(', ')
        toast(`No catalogued road close by. Nearest: ${names}`, {
          action: { label: `Open ${best.ref}`, cb: () => selectRoad(best.id) },
          duration: 7000,
        })
      }
    },
    (err) => {
      btn.classList.remove('is-busy')
      if (err.code === err.PERMISSION_DENIED) {
        toast('Location permission was declined — search for your road instead.', {
          action: {
            label: 'Search',
            cb: () => (document.getElementById('search-input') as HTMLInputElement)?.focus(),
          },
        })
      } else {
        toast("Couldn't get a location fix — try again in the open, or search instead.")
      }
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 },
  )
}

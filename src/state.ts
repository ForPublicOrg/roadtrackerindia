import type { NetworkFC, RoadSummary } from './types'

export const state = {
  roads: [] as RoadSummary[],
  byId: new Map<string, RoadSummary>(),
  network: null as NetworkFC | null,
  /** The state/district tier, once the map has zoomed in far enough to want it. */
  networkDetail: null as NetworkFC | null,
  selectedId: null as string | null,
  reportMode: false,
}

type Events = {
  select: string | null
  theme: 'light' | 'dark'
  dataready: void
}

const listeners = new Map<keyof Events, Set<(payload: never) => void>>()

export function on<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): void {
  if (!listeners.has(event)) listeners.set(event, new Set())
  listeners.get(event)!.add(cb as (payload: never) => void)
}

export function emit<K extends keyof Events>(event: K, payload: Events[K]): void {
  listeners.get(event)?.forEach((cb) => (cb as (p: Events[K]) => void)(payload))
}

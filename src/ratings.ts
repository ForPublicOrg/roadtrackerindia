import { getStore } from './storage'
import type { RatingSummary } from './types'
import { toast } from './ui'

const STAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.58L12 17.57l-5.9 3.11 1.13-6.58L2.45 9.44l6.6-.96Z" fill="currentColor"/></svg>'

const errCode = (e: unknown): string => (e as Error)?.message ?? String(e)

function summaryLine(sum: RatingSummary): string {
  return `Community: ${sum.mean.toFixed(1)} ★ from ${sum.votes} rating${sum.votes > 1 ? 's' : ''}`
}

/** The distribution is the part a bare average hides: five people split 1★/5★
 *  and five people all saying 3★ produce the same mean but mean opposite things. */
function breakdown(sum: RatingSummary): string {
  const rows = [5, 4, 3, 2, 1]
    .map((n) => {
      const c = sum.distribution[n] ?? 0
      const pct = sum.votes ? Math.round((c / sum.votes) * 100) : 0
      return `<div class="rb-row">
        <span class="rb-star">${n}★</span>
        <span class="rb-bar"><span style="width:${pct}%"></span></span>
        <span class="rb-count">${c}</span>
      </div>`
    })
    .join('')
  return `<div class="rating-breakdown" aria-label="Rating breakdown">${rows}</div>`
}

export async function renderRatingRow(el: HTMLElement, roadId: string): Promise<void> {
  const store = await getStore()
  // Your own stars come from this browser, not the server — there is no account
  // and nothing server-side ties a rating back to you.
  let mine = store.getMyRating(roadId)

  el.innerHTML = `
    <h3>Rate this road</h3>
    <div class="rating-row">
      <div class="stars" role="group" aria-label="Rate this road from 1 to 5 stars">
        ${[1, 2, 3, 4, 5]
          .map(
            (n) =>
              `<button type="button" aria-pressed="${mine === n}" data-stars="${n}" aria-label="${n} star${n > 1 ? 's' : ''}" class="${mine !== null && n <= mine ? 'is-on' : ''}">${STAR}</button>`,
          )
          .join('')}
      </div>
      <span class="rating-note" id="rating-note"></span>
    </div>
    <div id="rating-breakdown"></div>`

  const note = el.querySelector('#rating-note')!
  const chart = el.querySelector('#rating-breakdown')!

  const paint = (val: number | null) => {
    el.querySelectorAll<HTMLButtonElement>('[data-stars]').forEach((b) => {
      const n = Number(b.dataset.stars)
      b.classList.toggle('is-on', val !== null && n <= val)
      b.setAttribute('aria-pressed', String(val === n))
    })
  }

  const show = (sum: RatingSummary | null) => {
    note.textContent = sum
      ? summaryLine(sum)
      : mine !== null
        ? 'Thanks for rating!'
        : 'Be the first to rate this road'
    chart.innerHTML = sum && sum.votes > 0 ? breakdown(sum) : ''
  }

  const loadSummary = async () => {
    try {
      show(await store.getRatingSummary(roadId))
    } catch (e) {
      // never claim "be the first" for a road we merely failed to read
      const code = errCode(e)
      console.warn('[ratings] summary unavailable —', code)
      note.textContent =
        code === 'no-api'
          ? 'Ratings need the site API — not available on this deployment.'
          : "Community ratings can't be loaded right now."
      chart.innerHTML = ''
    }
  }
  void loadSummary()

  el.querySelectorAll<HTMLButtonElement>('[data-stars]').forEach((b) =>
    b.addEventListener('click', async () => {
      const stars = Number(b.dataset.stars)
      const prev = mine
      mine = stars
      paint(stars)
      try {
        // The POST returns the recomputed summary, so the numbers update from
        // the write itself rather than a follow-up read that the edge cache
        // could answer with a pre-rating value.
        const sum = await store.setRating(roadId, stars)
        toast(`You rated this road ${stars} star${stars > 1 ? 's' : ''}.`)
        show(sum)
      } catch (e) {
        // the optimistic paint above must not survive a failed write, or a
        // rejected rating looks saved until the next reload
        mine = prev
        paint(prev)
        const code = errCode(e)
        console.warn('[ratings] save failed —', code)
        toast(
          code === 'rate-limited'
            ? "You've rated a lot of roads just now — try again a little later."
            : code === 'captcha'
              ? "Couldn't verify this browser — reload the page and try again."
              : code === 'unavailable'
                ? 'Ratings are unavailable right now — please try again later.'
                : "Couldn't save your rating — try again.",
        )
      }
    }),
  )
}

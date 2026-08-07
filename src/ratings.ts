import { getStore } from './storage'
import { toast } from './ui'

const STAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.58L12 17.57l-5.9 3.11 1.13-6.58L2.45 9.44l6.6-.96Z" fill="currentColor"/></svg>'

export async function renderRatingRow(el: HTMLElement, roadId: string): Promise<void> {
  let store
  try {
    store = await getStore()
  } catch {
    el.innerHTML = `<h3>Rate this road</h3><p class="rating-note">Ratings are unavailable right now — please try again later.</p>`
    return
  }
  let mine: number | null = null
  try {
    mine = await store.getMyRating(roadId)
  } catch {
    /* ignore */
  }

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
    </div>`

  const note = el.querySelector('#rating-note')!
  const paint = (val: number | null) => {
    el.querySelectorAll<HTMLButtonElement>('[data-stars]').forEach((b) => {
      const n = Number(b.dataset.stars)
      b.classList.toggle('is-on', val !== null && n <= val)
      b.setAttribute('aria-pressed', String(val === n))
    })
  }

  const setSummaryText = async () => {
    const sum = await store.getRatingSummary(roadId).catch(() => null)
    note.textContent = sum
      ? `Community: ${sum.avg.toFixed(1)} ★ from ${sum.count} rating${sum.count > 1 ? 's' : ''}`
      : mine !== null
        ? 'Thanks for rating!'
        : 'Be the first to rate this road'
  }
  void setSummaryText()

  el.querySelectorAll<HTMLButtonElement>('[data-stars]').forEach((b) =>
    b.addEventListener('click', async () => {
      const stars = Number(b.dataset.stars)
      mine = stars
      paint(stars)
      try {
        await store.setRating(roadId, stars)
        toast(`You rated this road ${stars} star${stars > 1 ? 's' : ''}.`)
        void setSummaryText()
      } catch {
        toast("Couldn't save your rating — try again.")
      }
    }),
  )
}

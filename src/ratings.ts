/**
 * The community verdict on a road: stars (top of the panel, next to the chips)
 * and reviews (further down, with the other community content). One summary
 * read serves both — reviews ride inside it — so the second section costs no
 * extra request.
 *
 * The reviews section is deliberately quiet: the three most-liked reviews, each
 * clamped to a few lines, one button for the rest, and the composer stays folded
 * until asked for. On a phone the whole thing is a bottom sheet, so every
 * control is a 40px+ target and the textarea is 16px so iOS doesn't zoom.
 */
import { prefersReducedMotion } from './animate'
import { getStore } from './storage'
import type { RatingSummary, ReviewItem } from './types'
import { esc, relTime, toast } from './ui'

const STAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.95 5.98 6.6.96-4.78 4.66 1.13 6.58L12 17.57l-5.9 3.11 1.13-6.58L2.45 9.44l6.6-.96Z" fill="currentColor"/></svg>'
const THUMB =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 7h3v7H2zM5 7l3-5.5c1.2 0 2 .9 1.8 2.1L9.3 7H13a1.5 1.5 0 0 1 1.45 1.9l-1.2 4.2A1.5 1.5 0 0 1 11.8 14H5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'
const PEN =
  '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 12h10M3 9.5 10 2.5l1.5 1.5-7 7H3z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>'

/** How many reviews show before "Show all" — enough to get the gist, not a wall. */
const SHOWN = 3
const REVIEW_MAX = 500

const errCode = (e: unknown): string => (e as Error)?.message ?? String(e)

/** One voice for every failed write, whatever was being saved. */
function failMessage(code: string, what: string): string {
  if (code === 'rate-limited') return "You've done a lot just now — try again a little later."
  if (code === 'captcha') return "Couldn't verify this browser — reload the page and try again."
  if (code === 'unavailable' || code === 'no-api') return `${what} is unavailable right now — please try again later.`
  return `Couldn't save your ${what.toLowerCase()} — try again.`
}

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

function reviewHtml(r: ReviewItem, mine: boolean, liked: boolean): string {
  const stars = r.stars
    ? `<span class="rv-stars" aria-label="${r.stars} star${r.stars > 1 ? 's' : ''}">${'★'.repeat(r.stars)}<span>${'★'.repeat(5 - r.stars)}</span></span>`
    : ''
  const helped = r.likes ? `${r.likes} found this helpful` : ''
  return `<li class="rv-item${mine ? ' is-mine' : ''}" data-id="${esc(r.id)}">
    <div class="rv-head">${stars}<span>${mine ? 'Your review' : 'Traveller'} · ${relTime(Date.parse(r.at))}${r.edited ? ' · edited' : ''}</span></div>
    <p class="rv-text">${esc(r.text)}</p>
    <div class="rv-actions">
      ${
        mine
          ? `<span class="rating-note">${helped}</span>
             <span class="rv-own"><button class="rv-btn" data-act="edit">Edit</button><button class="rv-btn" data-act="delete">Delete</button></span>`
          : `<button class="rv-btn rv-like" data-act="like" aria-pressed="${liked}" aria-label="Helpful${r.likes ? `, ${r.likes}` : ''}">${THUMB}<span>Helpful</span>${r.likes ? `<b>${r.likes}</b>` : ''}</button>`
      }
      <button class="rv-btn rv-read" data-act="read" hidden>Read more</button>
    </div>
  </li>`
}

function composerHtml(text: string): string {
  return `<form class="rv-form" data-act="form">
    <textarea class="rp-note rv-input" name="text" rows="3" maxlength="${REVIEW_MAX}" minlength="3" required aria-label="Your review"
      placeholder="How was the drive? Surface, traffic, tolls, where to stop…">${esc(text)}</textarea>
    <p class="rating-note rv-form-foot">Public and anonymous · one review per person per road · <span data-count>${text.length}</span>/${REVIEW_MAX}</p>
    <div class="rp-actions">
      <button type="button" class="btn btn-ghost" data-act="cancel">Cancel</button>
      <button type="submit" class="btn btn-primary">${text ? 'Save changes' : 'Post review'}</button>
    </div>
  </form>`
}

export async function renderCommunity(
  ratingEl: HTMLElement,
  reviewsEl: HTMLElement,
  roadId: string,
  roadRef: string,
): Promise<void> {
  const store = await getStore()
  // Your own stars come from this browser, not the server — there is no account
  // and nothing server-side ties a rating back to you.
  let mine = store.getMyRating(roadId)
  let summary: RatingSummary | null = null

  // ── stars ────────────────────────────────────────────────────────

  ratingEl.innerHTML = `
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

  const note = ratingEl.querySelector('#rating-note')!
  const chart = ratingEl.querySelector('#rating-breakdown')!

  const paint = (val: number | null) => {
    ratingEl.querySelectorAll<HTMLButtonElement>('[data-stars]').forEach((b) => {
      const n = Number(b.dataset.stars)
      b.classList.toggle('is-on', val !== null && n <= val)
      b.setAttribute('aria-pressed', String(val === n))
    })
  }

  const showRating = () => {
    const rated = summary && summary.votes > 0
    note.textContent = rated
      ? summaryLine(summary!)
      : mine !== null
        ? 'Thanks for rating!'
        : 'Be the first to rate this road'
    chart.innerHTML = rated ? breakdown(summary!) : ''
  }

  // ── reviews ──────────────────────────────────────────────────────

  let expanded = false
  let composing = false

  const myReview = (): ReviewItem | undefined => {
    const id = store.getMyReviewId(roadId)
    return id ? summary?.reviews?.find((r) => r.id === id) : undefined
  }

  const renderReviews = () => {
    const list = summary?.reviews ?? []
    const me = myReview()
    // yours first — it is the one you would look for
    const ordered = me ? [me, ...list.filter((r) => r !== me)] : list
    const shown = expanded ? ordered : ordered.slice(0, SHOWN)
    const liked = store.getMyLikes(roadId)

    reviewsEl.innerHTML = `
      <h3>What travellers say${list.length ? ` · ${list.length}` : ''}</h3>
      ${
        list.length
          ? `<ul class="rv-list">${shown.map((r) => reviewHtml(r, r === me, liked.has(r.id))).join('')}</ul>`
          : composing
            ? ''
            : `<p class="rd-meta-line" style="margin-top:0">No reviews of ${esc(roadRef)} yet. Driven it? Say how it was.</p>`
      }
      ${!expanded && ordered.length > SHOWN ? `<button class="rv-more" data-act="more">Show all ${list.length} reviews</button>` : ''}
      ${
        composing
          ? composerHtml(me?.text ?? '')
          : me
            ? ''
            : `<button class="panel-cta" data-act="write">${PEN} Write a review</button>`
      }`

    // only offer "Read more" where the clamp actually hid something
    reviewsEl.querySelectorAll<HTMLElement>('.rv-text').forEach((p) => {
      if (p.scrollHeight > p.clientHeight + 1) {
        p.parentElement?.querySelector('.rv-read')?.removeAttribute('hidden')
      }
    })
  }

  const openComposer = () => {
    composing = true
    renderReviews()
    document.dispatchEvent(new CustomEvent('rti:expand-sheet'))
    const ta = reviewsEl.querySelector<HTMLTextAreaElement>('textarea')
    ta?.focus({ preventScroll: true })
    ta?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
  }

  const like = async (btn: HTMLButtonElement, id: string) => {
    const r = summary?.reviews?.find((x) => x.id === id)
    if (!r) return
    const on = btn.getAttribute('aria-pressed') !== 'true'
    const was = r.likes
    const show = (likes: number, liked: boolean) => {
      r.likes = likes
      btn.setAttribute('aria-pressed', String(liked))
      btn.setAttribute('aria-label', `Helpful${likes ? `, ${likes}` : ''}`)
      btn.querySelector('b')?.remove()
      if (likes) btn.insertAdjacentHTML('beforeend', `<b>${likes}</b>`)
    }
    show(Math.max(0, was + (on ? 1 : -1)), on) // optimistic; the list keeps its order so nothing jumps under your thumb
    try {
      const res = await store.setReviewLike(roadId, id, on)
      show(res.likes, res.liked)
    } catch (e) {
      show(was, !on)
      const code = errCode(e)
      toast(code === 'not-found' ? 'That review is gone.' : failMessage(code, 'Liking'))
    }
  }

  const save = async (form: HTMLFormElement) => {
    const ta = form.querySelector('textarea')!
    const text = ta.value.trim()
    if (text.length < 3) return ta.focus()
    const submit = form.querySelector<HTMLButtonElement>('[type=submit]')!
    const label = submit.textContent
    submit.disabled = true
    submit.textContent = 'Saving…'
    try {
      summary = await store.setReview(roadId, text)
      composing = false
      toast('Thanks! Your review is live for everyone.')
      renderReviews()
    } catch (e) {
      submit.disabled = false
      submit.textContent = label
      toast(failMessage(errCode(e), 'Review'))
    }
  }

  const remove = async () => {
    if (!confirm('Delete your review?')) return
    try {
      summary = await store.removeReview(roadId)
      toast('Your review was removed.')
      renderReviews()
    } catch (e) {
      toast(failMessage(errCode(e), 'Review'))
    }
  }

  reviewsEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-act]')
    if (!btn) return
    const item = btn.closest<HTMLElement>('.rv-item')
    switch (btn.dataset.act) {
      case 'more':
        expanded = true
        return renderReviews()
      case 'write':
      case 'edit':
        return openComposer()
      case 'cancel':
        composing = false
        return renderReviews()
      case 'read':
        item?.classList.add('is-open')
        return btn.remove()
      case 'like':
        return void like(btn, item!.dataset.id!)
      case 'delete':
        return void remove()
    }
  })
  reviewsEl.addEventListener('submit', (e) => {
    e.preventDefault()
    void save(e.target as HTMLFormElement)
  })
  reviewsEl.addEventListener('input', (e) => {
    const ta = e.target as HTMLTextAreaElement
    const count = reviewsEl.querySelector('[data-count]')
    if (ta.tagName === 'TEXTAREA' && count) count.textContent = String(ta.value.length)
  })

  // ── load ─────────────────────────────────────────────────────────

  reviewsEl.innerHTML = `<h3>What travellers say</h3><div class="skel" style="height:44px"></div>`
  try {
    summary = await store.getRatingSummary(roadId)
    showRating()
    renderReviews()
  } catch (e) {
    // never claim "be the first" for a road we merely failed to read
    const code = errCode(e)
    console.warn('[ratings] summary unavailable —', code)
    note.textContent =
      code === 'no-api'
        ? 'Ratings need the site API — not available on this deployment.'
        : "Community ratings can't be loaded right now."
    chart.innerHTML = ''
    reviewsEl.innerHTML = `<h3>What travellers say</h3><p class="rating-note">Reviews can't be loaded right now — please try again later.</p>`
  }

  ratingEl.querySelectorAll<HTMLButtonElement>('[data-stars]').forEach((b) =>
    b.addEventListener('click', async () => {
      const stars = Number(b.dataset.stars)
      const prev = mine
      mine = stars
      paint(stars)
      try {
        // The POST returns the recomputed summary, so the numbers update from
        // the write itself rather than a follow-up read that the edge cache
        // could answer with a pre-rating value.
        summary = await store.setRating(roadId, stars)
        showRating()
        renderReviews() // your review, if any, now shows the new stars
        // the moment someone has an opinion is the moment to ask for the words
        const ask = !myReview() && !composing
        toast(`You rated this road ${stars} star${stars > 1 ? 's' : ''}.`, {
          action: ask ? { label: 'Add a review', cb: openComposer } : undefined,
        })
      } catch (e) {
        // the optimistic paint above must not survive a failed write, or a
        // rejected rating looks saved until the next reload
        mine = prev
        paint(prev)
        const code = errCode(e)
        console.warn('[ratings] save failed —', code)
        toast(failMessage(code, 'Rating'))
      }
    }),
  )
}

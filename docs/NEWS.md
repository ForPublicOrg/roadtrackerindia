# Road news

Every road page has an **In the news** section: up to eight recent headlines
that name that road, newest first. They come from the Google News RSS feed and
are refreshed once a day by a GitHub Action.

```
.github/workflows/news.yml   the daily job — 06:07 IST, or by hand from the Actions tab
scripts/fetch-news.mjs       asks Google News about every road, writes the results
scripts/lib/news-match.mjs   decides which headline belongs to which road
scripts/lib/news-feed.mjs    reads the RSS
public/data/news/<id>.json   { "items": [{ title, url, source, date }] } — only roads with news
public/data/news/_status.json  when the last run finished, and what it did not reach
```

The job commits whatever changed and pushes to `main`; Vercel deploys that push
like any other, which is how the headlines go live. `npm run build` does no
fetching — a build is the same on every machine and never waits on Google.
`npm run data` reads the news folder to mark which roads have headlines in
`index.json` (so the app never asks for a file that does not exist) and to
carry the last run's time into the panel's "updated …" line.

## Which headlines count

Google News matches words anywhere on an article's page and treats numbers
loosely: `"NH 342"` returns Navy Day coverage and a Boston Herald story, `"SH 29"`
returns Texas. The feed gives nothing but the headline, so the headline is what
gets checked. A story is kept only if its **headline** names the road:

| by | e.g. | on its own? |
|---|---|---|
| a new-scheme NH number (above 235) | NH-342, National Highway 342 | yes |
| an NH number up to 235 | NH-8, NH-44 | only with a place on this road |
| an SH, MDR, ODR or NE number | SH-29 | only with a place on this road |
| a distinctive name | Ganga Expressway, Atal Setu | yes |
| a generic name or abbreviation | Outer Ring Road, MC Road, ORR | only with this road's city or state |
| its two ends, joined, then a road word | "Srinagar-Leh highway" | yes, if no other road has the same two ends |

Why the places:

- **SH and district numbers restart in every state.** "SH 29" is a road in
  almost every state (and in Texas).
- **Every NH number up to 235 was in use before the 2010 renumbering**, and the
  press has not let go. Gurugram papers still say "NH-8" for what has been NH 48
  since 2010, while today's NH 8 runs through Assam and Tripura. A place on the
  current road in the headline tells them apart.
- **Generic names repeat.** Six cities have an Outer Ring Road. "Ring Road" inside
  "Outer Ring Road" belongs to the longer name.

A "place" is the road's states, the towns at its ends, its major cities, and its
waypoints; the outlet's own name counts too ("Kashmir Observer", "Telangana
Today"). A headline that names a different road number ("Karode–Kanyakumari NH 66
stretch") is never credited to another road by its ends.

Renamed cities fold together (Bangalore/Bengaluru, Gurgaon/Gurugram, Orissa/Odisha …),
names are matched either way round (Lucknow–Agra Expressway), and aliases marked
"old numbering" or "former" in `aka` are ignored, because those numbers now
belong to other roads.

### The `newsQuery` field

A road file may set `newsQuery` (see [DATA.md](DATA.md)). It is sent to Google as
the road's first query, and it also teaches the matcher: quoted phrases are
names of the road, and words outside the quotes are places that disambiguate
them. `"Atal Setu" Mumbai` means "Atal Setu" counts only with Mumbai in the
headline, or when this query returned the story (Goa has an Atal Setu too).

## How a run behaves

- **Queries.** One per generated road, up to three per hand-written one. A road
  with nothing a headline could name (no number, no name, no distinct ends) is
  skipped.
- **Pacing.** About one request a second from three workers. Google answers a
  feed reader that asks too fast with HTTP 503 and a "Sorry…" page; every time it
  does, the run pauses (1, 2, 4, 8, then 10 minutes) and widens its gap for good.
  After an hour of total waiting, or four hours of running, it stops.
- **Merging.** Each road's list is today's matches plus the headlines it already
  had, re-checked against the current rules, newest first, capped at eight, and
  nothing older than two years. Google's results wobble day to day; merging
  means a story leaves only when newer ones push it out.
- **Writing.** Nothing is written until the run ends. A file is rewritten only
  when its headlines change, and removed when a road has none, so each day's
  commit is the real diff. News for a road that no longer exists is removed.
- **Order.** Roads the last run did not reach go first, then hand-written roads,
  then roads that already have news, then the rest.

The run refuses to write anything, and the job fails, when it looks broken:
more than 10% of roads failed, Google returned nothing at all for most
hand-written roads (a silent block), or most roads that had headlines lost them.
A run that ran out of time or patience commits what it has and warns; if no run
has reached every road in three days, the job fails so somebody looks.

## Running it by hand

```
node scripts/fetch-news.mjs --only nh-44,mc-road --dry-run   # what would it keep?
node scripts/fetch-news.mjs --only nh-44                     # write just these
node scripts/fetch-news.mjs                                  # everything (2+ hours)
npm test                                                     # the matching rules
```

From GitHub: **Actions → Daily road news → Run workflow**, optionally with a
list of road ids.

**If you change the matching rules**, run the full job with **reset** ticked
(`--reset`). It rebuilds every list from today's results instead of merging with
the old ones, and allows a large drop in the number of roads with news, which
would otherwise stop the run.

Running the full job from a home connection is not recommended: a few thousand
queries in a row can get that IP throttled by Google for an hour or more,
Google search included.

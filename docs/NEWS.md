# Road news

Every road page has an **In the news** section: up to eight recent headlines
that name that road, newest first. They come from the Google News RSS feed via a
GitHub Action that runs once a day. Busy roads — every hand-written road, and any
road already in the news — are searched every day; the other ~7,000 take turns,
and each is searched about once a week. Why not all of them daily: see
[How much Google allows](#how-much-google-allows).

```
.github/workflows/news.yml   the daily job — 06:07 IST, or by hand from the Actions tab
scripts/fetch-news.mjs       asks Google News about the day's roads, writes the results
scripts/lib/news-match.mjs   decides which headline belongs to which road
scripts/lib/news-feed.mjs    reads the RSS
public/data/news/<id>.json   { "items": [{ title, url, source, date }] } — only roads with news
public/data/news/_status.json  when the last run finished, and where the rotation carries on
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

## How much Google allows

Google refuses a feed reader that asks too much, with HTTP 503 and a "Sorry…"
page, and the refusal lasts for hours. Measured while building this: one GitHub
runner was refused after 171 queries, another after about 500. A home connection
was refused after a burst and stayed refused for more than six hours. The job
therefore asks at most **140 queries a run**, three seconds apart, and makes each
one count:

- **It searches terms, not roads.** A road contributes its numbers (never a
  district road's number: those never reach a headline), its names, and — only
  if it has neither — its two end towns. A term many roads share ("SH 29" is a
  road in most states) is searched once, and its headlines are offered to all of
  them.
- **Ten terms to a query**, `"NH 342" OR "NH 548C" OR …`, which Google answers
  with the union of their results (measured: 82 of 84 of the separate queries'
  headlines). A batch that fills the feed's 100 results may have lost some, so it
  is split in half and asked again; a term that fills 100 on its own is
  remembered in `_status.json` and asked alone from then on. Two things that do
  **not** work, also measured: mixing OR with other words (`"SH 29" OR "SH 30"
  Kerala` returns nothing), and `intitle:` in an OR.
- **Two lists, each walked from where it stopped.** Hot things (every
  hand-written road's own `newsQuery`, and the terms of roads with news) get up
  to 60% of a run, which on a normal day covers all of them. The rotation gets
  the rest: ~4,400 terms, about 445 queries round, so about a week. Its place is
  saved in `_status.json`, and `cold.lastLap` records when it last came all
  the way round.

Other sources were tried. GDELT's DOC API, which is built for programmatic
access, turns GitHub's runners away on the first request (they share IPs with
too many other users). Spreading the job over many runs a day so that each
lands on a fresh IP would be dodging Google's limit, not living within it, so
the job does not do that.

## How a run behaves

- **Merging.** Each road's list is today's matches plus the headlines it already
  had, re-checked against the current rules: newest first, at most eight,
  nothing older than two years. Google's results wobble from day to day; with the
  merge a story leaves only when newer ones push it out or it ages out.
- **Writing.** Nothing is written until the run ends. Every road with a file is
  re-checked each run, searched or not, so stories age out on time. A file is
  rewritten only when its headlines change and removed when none are left, so
  each day's commit is the real diff. News for a road that no longer exists is
  removed.
- **Refusals.** The first refusal is waited out (three minutes) and retried once;
  a second ends the run. What it has is still committed, and the next run
  carries on from the same places.

Exit codes, which the workflow acts on:

| code | means | workflow |
|---|---|---|
| 0 | done | commits |
| 3 | Google refused before the run's queries were spent | commits, warns |
| 4 | refused two runs in a row, or the rotation has not come round in three weeks | commits, **fails** |
| 1 | looks broken — >10% of queries failed, feeds about roads in the news came back empty (a silent block), or most roads lost their headlines | writes nothing, **fails** |

A failing run emails the repository's owner, as any failed Action does.

## Running it by hand

```
node scripts/fetch-news.mjs --only nh-44,mc-road --dry-run   # what would it keep?
node scripts/fetch-news.mjs --only nh-44                     # write just these
node scripts/fetch-news.mjs                                  # a daily run (~10 min)
npm test                                                     # the matching rules
```

From GitHub: **Actions → Daily road news → Run workflow**, optionally with a
list of road ids.

**If you change the matching rules**, every stored headline is re-checked
against them on the next run. If that is going to empty most roads' lists on
purpose, tick **rules changed** (`--rules-changed`), or the run will refuse to
write.

Don't run the daily job from a home connection: Google refuses an IP that asks
too much for hours, and Google search on that connection with it. A handful of
roads with `--only … --dry-run` is fine.

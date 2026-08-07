# Organisations — authorities, builders and operators

Behind every road there are organisations: the authority that owns it, the
company that physically built it, and whoever collects the toll and answers the
phone when something goes wrong. RoadTracker models them as **their own entity**,
so "who built this?" is a link, not a string — and every organisation gets a
profile page listing every road it has touched.

```
public/data/orgs/<id>.json     ← hand-authored, one per organisation
        ↓  npm run data
public/data/orgs.json          ← derived index with per-org rollups
```

The rollups (how many roads, how many kilometres, how much money) are **derived
from the road files**, never written by hand. Link a road to an organisation and
its profile page updates itself.

## The `id`

kebab-case, stable forever — it becomes the public URL `/company/<id>`.

- Government bodies: the acronym everyone uses — `nhai`, `nhidcl`, `bro`, `msrdc`
- State PWDs: `<state>-pwd`, e.g. `kerala-pwd`, `delhi-pwd`
- Companies: the common name — `larsen-toubro`, `irb-infrastructure`, `pnc-infratech`

## Full field reference

```jsonc
{
  // ── REQUIRED ────────────────────────────────────────────────
  "id": "nhai",
  "name": "National Highways Authority of India",
  "type": "authority",             // see the table below
  "summary": "One or two plain sentences: who they are, what they do.",
  "sources": [                     // 1–4 links, official pages only (same rule as roads)
    { "title": "NHAI", "url": "https://nhai.gov.in/" }
  ],

  // ── OPTIONAL (omit anything you are not confident about) ───
  "shortName": "NHAI",             // the acronym, if the full name is a mouthful
  "aka": ["Bharatmala implementing agency"],
  "founded": "1988",               // year, as a string
  "headquarters": "New Delhi",
  "ownership": "Government of India — Ministry of Road Transport and Highways",
  "website": "https://nhai.gov.in/",
  "about": "One paragraph (3–6 sentences) of background, plain language.",
  "facts": ["4–8 crisp, verifiable facts"],

  // Phone numbers people can actually ring. See the rules below — this is the
  // one field where a mistake is dangerous, so it is validated strictly.
  "helplines": [
    {
      "kind": "emergency",         // "emergency" | "complaint" | "control-room" | "info"
      "label": "Highway emergency — ambulance, crane, police",
      "number": "1033",
      "note": "24×7, free from any phone"
    }
  ],
  // Where to complain in writing
  "grievance": {
    "url": "https://…",
    "app": "Rajmarg Yatra",
    "email": "…@nhai.gov.in",
    "note": "One sentence on what this channel is for."
  }
}
```

## `type`

| value | means | examples |
|---|---|---|
| `authority` | owns and administers the road on the public's behalf | NHAI, NHIDCL, UPEIDA, MMRDA |
| `pwd` | a state or city public works department | Kerala PWD, Delhi PWD |
| `psu` | government-owned company or corporation | BRO, MSRDC, BSRDC |
| `developer` | took the concession — built it and collects the toll | Jaypee Infratech, IRB, Adani Road Transport |
| `contractor` | was paid to build it, does not own it | Larsen & Toubro, Afcons, PNC Infratech |
| `operator` | runs and maintains it day to day | Noida Toll Bridge Company |

A company that both built and now runs a road is a `developer`. Use `contractor`
for pure EPC work.

## Linking roads to organisations

In the road file (see [DATA.md](DATA.md)):

```jsonc
"authority": "nhai",                                   // who owns it
"builtBy":    [{ "org": "larsen-toubro", "note": "packages 3–7" }],
"operatedBy": [{ "org": "irb-infrastructure", "note": "concession to 2042" }]
```

`builtBy` and `operatedBy` entries may instead carry a plain `name` when there is
no organisation to link to — historical builders, joint ventures, and anyone too
obscure to profile:

```jsonc
"builtBy": [{ "name": "Sher Shah Suri's administration", "note": "16th century" }]
```

The free-text `agency` and `contractor` fields still exist and still render. They
are the fallback for the thousands of OpenStreetMap-generated roads that have no
organisation link yet.

## Helpline rules — read these

A wrong emergency number is worse than no emergency number. So:

1. **Never invent a number.** If you are not certain, leave it out. The road page
   falls back to the national numbers, which are always correct.
2. Only these formats validate: a short code (`1033`, `112`, `108`), a landline
   with STD code (`0120-2345678`), or `+91` followed by 10 digits.
3. A number that is *not* one of the well-known national short codes must be
   backed by an entry in that organisation's `sources`.
4. Put the number on the **organisation**, not the road — every road that
   organisation looks after inherits it, and there is one place to fix it when it
   changes.
5. Road-level `helplines` are for numbers specific to that one road (an
   expressway's own control room). They are shown *in addition* to the
   inherited ones.

Every road page shows **112** (the national emergency number, all of India) and
**108** (ambulance, most states) regardless of what is on file, because those are
always right. Those two are built into the app, not the data.

## Validate

```bash
npm run data
```

Bad org ids in road files, malformed phone numbers and unknown keys are all
caught there.

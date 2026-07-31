# mangaplus

publoader extension for [MangaPlus by Shueisha](https://mangaplus.shueisha.co.jp/),
written against **extension API v2** (`publoader_api: ^2.0.0`, `runtime: node`).

`src/index.ts` default-exports a factory `(ctx) => { collect(input) }`. The
factory receives a sandboxed context — `ctx.fetch` is the only network
primitive, and it enforces `allowed_hosts` from `manifest.json`.

## What it does

Four protobuf endpoints on `jumpg-webapi.tokyo-cdn.com/api/`:

| endpoint | calls per run | why |
| --- | --- | --- |
| `title_list/allV2` | 1 | the whole catalogue: series with no MangaDex title yet, and evidence that a tracked series is still published |
| `web/web_homeV4` | 1 | update feed: each title's newest chapter id and when it went up |
| `title_list/updated` | 1 | second update feed, widening that coverage |
| `title_detailV3?title_id=…` | one per series **the listings say has moved** | a series' full chapter lists |

The API dropped `format=json` (it 403s), so responses are protobuf. They are
decoded by a small hand-written decoder in `src/proto.ts` whose schema mirrors
`mangaplus.proto` — that file stays authoritative for field numbers. No runtime
dependencies, so the published bundle is just this code.

## Fetch strategy (why runs are cheap)

`title_detailV3` is one request per series and the tracked catalogue is
hundreds of series, so the Python version spent hundreds of requests every run
to discover that a handful of titles had moved. The listing endpoints already
say which titles moved and when, so a run reads them once and spends its
per-series calls only where something changed. `src/planner.ts` owns that
decision as a pure function (`planFetch`), tested in `src/planner.test.ts`.

A tracked series is **skipped** only when the listing evidence rules out an
update — i.e. when a detail call could not have produced a chapter that
`collect` would keep. Exactly four reasons, logged by name each run:

| reason | claim |
| --- | --- |
| `latest-chapter-posted` | the newest chapter the update feed advertises is already in `input.postedChapterIds` |
| `no-update-signal` | the title is in the catalogue, but no update feed mentions it, so it published nothing recently |
| `outside-update-window` | the newest chapter the feeds know of went up before `now - 3 days`, so `collect`'s own update-window filter would drop it anyway |
| `absent-from-listing` | no listing mentions the title at all: no longer published, hidden, or mistracked |

Everything else is fetched. The ordering matters in one place: when one feed
names a chapter id that is already posted but the other reports a strictly
newer timestamp, the feeds disagree and the series is fetched.

### Correctness guarantees

- **Clean runs skip nothing.** `input.cleanRun` bypasses every predicate and
  fetches every tracked series. This is a correctness requirement, not
  politeness: a clean run's `allChapters` is what the platform diffs to detect
  *removed* chapters, so a series missing from it would read as "all its
  chapters were removed". `allChapters` stays `null` on every other run, where
  absence means "no removal information".
- **Skipping never strands an upload.** `postedChapterIds` lists chapters
  *successfully uploaded*; a chapter that failed to upload is retried from the
  platform's durable `upload_tasks` queue, not by being collected again. So
  skipping a series cannot lose a chapter that is mid-retry.
- **A failed listing widens the run, never narrows it.** If both update feeds
  fail, nothing is skipped and the run fetches every tracked series, exactly as
  the Python version did. If one fails, coverage narrows for that run only and
  the log says so. If the catalogue call fails, untracked-series detection is
  skipped for the run (as it always was) but skipping still works from the
  update feeds.
- **Schema drift can't mute a run.** If MangaPlus renumbers a protobuf field,
  the update feeds would still decode — into nothing — and every series would
  look quiet. So feeds that answer while naming *no* updated title at all are
  treated as no evidence rather than as "nothing to do": the run logs it and
  fetches every tracked series. MangaPlus publishes daily, so a genuinely empty
  update feed is not a thing.
- **`"ex"` numbering keeps its full context.** `normalise.ts` numbers an `"ex"`
  chapter by inspecting its neighbours in the same chapter-list group, so it
  needs the series' whole chapter list. A series is never fetched *partially* —
  a title either gets its complete `title_detailV3` response or no call at all
  — so whenever any of its chapters are new, every neighbour is present.
- **Partitioned runs.** `input.trackedSubset` narrows the candidate set before
  any predicate runs, so a segment only ever fetches series it owns.
  Untracked-series detection still tests membership against the *whole* tracked
  map, so one segment never reports a title another segment owns.

### The absent-from-listing policy

A series in `ctx.mangaIdMap` that no listing mentions is **not** fetched on an
update run, and *is* fetched on the next clean run. A title MangaPlus no longer
lists has no new chapters, so fetching it every run buys nothing; but the same
evidence would appear if publoader tracked a bad id or the catalogue call
returned a partial answer. So it cannot go unnoticed:

- every run logs the count per skip reason plus the first 20 absent ids;
- clean runs fetch them regardless, which is where a series that quietly
  stopped being tracked resurfaces (and, being clean runs, where removal
  detection happens anyway).

An operator wanting a full catalogue re-scan should therefore trigger a
**CLEAN** run — a FORCE run is an update run as far as the extension can tell,
and prunes the same way.

Chapter numbers and titles are normalised in `src/normalise.ts`
(`"#001"` → `"1"`, `"ex"` → `"<previous>.5"`, `"Chapter 12: Foo"` → `"Foo"`),
driven by `override_options.json`. Both JSON data files are read through
`ctx.dataFile` and also seed the platform database.

## Build

The platform CLI bundles the extension with esbuild at publish time and names
the artifact `index.mjs`, matching `manifest.entrypoint`. To reproduce that
locally:

```sh
npx esbuild src/index.ts --bundle --platform=node --format=esm --target=node20 --outfile=index.mjs
```

`npm run build` is the same command. `index.mjs` is a build artifact — it is not
committed.

## Type-check and test

```sh
npm i --no-save typescript @types/node
npm run typecheck   # tsc --noEmit, plus the tests via tsconfig.test.json
npm test            # node --test --experimental-transform-types "src/**/*.test.ts"
```

The tests need no build step and no test framework: Node runs the TypeScript
sources as they are (`--experimental-transform-types`, needed because
`proto.ts` uses constructor parameter properties). Tests are the only files here
allowed to see Node's globals — they are excluded from `tsconfig.json` and
checked by `tsconfig.test.json` — so the extension itself cannot reach for them
by accident.

- `planner.test.ts` covers the skip predicate: posted latest chapter, new
  chapter, clean run, `trackedSubset`, absent titles, feeds unavailable.
- `listing.test.ts` drives `buildListing` from **encoded protobuf bytes** whose
  field numbers are transcribed from `mangaplus.proto`. That is deliberate: if a
  field number or JSON name drifts, the runtime symptom is a run that decodes
  fine, sees no updates, and uploads nothing, so it is worth failing a test
  instead.

`src/api.d.ts` is a hand-copied subset of the platform's extension API types
(source of truth: `platform/src/contracts/extensionApi.ts` in the publoader
repo) so this directory type-checks without a cross-repo import. Keep it in
sync when the contract changes.

## Publishing

The platform CLI reads `manifest.json`, bundles `src/index.ts` to `index.mjs`,
uploads the bundle plus the declared `data_files`, and the worker runs it under
Node's permission model. `manifest.partition` declares that a run may be split
into up to 4 segments of at least 25 tracked series each; `collect` honours
`input.trackedSubset` by fetching only that segment's series.

# mangaplus

publoader extension for [MangaPlus by Shueisha](https://mangaplus.shueisha.co.jp/),
written against **extension API v2** (`publoader_api: ^2.0.0`, `runtime: node`).

`src/index.ts` default-exports a factory `(ctx) => { collect(input) }`. The
factory receives a sandboxed context — `ctx.fetch` is the only network
primitive, and it enforces `allowed_hosts` from `manifest.json`.

## What it does

Two protobuf endpoints on `jumpg-webapi.tokyo-cdn.com/api/`:

| endpoint | why |
| --- | --- |
| `title_list/allV2` | the whole catalogue, to report series that have no MangaDex title yet |
| `title_detailV3?title_id=…` | one call per tracked series, for its chapter lists |

The API dropped `format=json` (it 403s), so responses are protobuf. They are
decoded by a small hand-written decoder in `src/proto.ts` whose schema mirrors
`mangaplus.proto` — that file stays authoritative for field numbers. No runtime
dependencies, so the published bundle is just this code.

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

## Type-check

```sh
npm i --no-save typescript
npx tsc --noEmit
```

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

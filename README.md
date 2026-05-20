# publoader-extensions

Source-of-truth repo for the public publisher extensions consumed by
[publoader](https://github.com/publoader/publoader). The repo is also packaged
as a Docker image (`ardax/publoader-extensions`) that ships every `src/<ext>/`
tree into the main container's `extensions` volume on startup.

## Layout

```
src/
  <extension>/
    <extension>.py        # entrypoint module — must match the directory name
    manifest.json         # metadata + permissions (see below)
    manga_id_map.json     # MangaDex id ↔ publisher id mapping
    override_options.json # optional manual overrides
    requirements.txt      # extension-specific deps
schedule.json             # daily run timings
sync_extensions.py        # used by the Docker sidecar — do not invoke manually
tools/
  validate_manifests.py   # CI: schema-checks every manifest
  smoke_load.py           # CI: imports each entrypoint under publoader.api
.github/workflows/        # CI pipeline
```

## Prerequisites

You should be comfortable with:

- [Python 3.10+](https://www.python.org/)
- HTTP scraping / API consumption for the publisher you're targeting

This guide is updated over time. If something is wrong or unclear, open an
issue or a PR.

## Writing an extension

The fastest start is to copy an existing extension directory (e.g. `mangaplus`)
and rename it. Read through a working extension before starting your own — the
shape of the `Extension` class and how it returns chapters is best learned by
example.

**You are responsible for rate-limiting your own extension.** The runner won't
throttle you on the publisher's behalf.

### Naming

`<extension>` must be lowercase ASCII with no punctuation other than `_`. The
directory name, the entrypoint filename (without `.py`), and the
`manifest.json` `name` field must all match. The runner skips anything that
doesn't satisfy this.

### `manifest.json`

Every extension must ship a `manifest.json` next to its entrypoint. CI
(`tools/validate_manifests.py`) rejects PRs where this file is missing or
malformed. Minimum shape:

```json
{
  "name": "mangaplus",
  "version": "0.2.04",
  "publoader_api": "^1.0.0",
  "entrypoint": "mangaplus.py",
  "class_name": "Extension",
  "mangadex_group_id": "4f1de6a2-f0c5-4ac5-bce5-02c7dbb67deb",
  "languages": ["en", "es"],
  "allowed_hosts": [
    "jumpg-webapi.tokyo-cdn.com",
    "mangaplus.shueisha.co.jp"
  ],
  "permissions": {
    "network": true,
    "filesystem_read": ["manga_id_map.json", "override_options.json"],
    "filesystem_write": [],
    "subprocess": false
  },
  "schedule": {
    "hour": 15,
    "minute": 5,
    "timezone": "UTC"
  },
  "data_files": {
    "manga_id_map": "manga_id_map.json",
    "override_options": "override_options.json"
  },
  "maintainers": ["your-github-handle"],
  "homepage": "https://example.com/"
}
```

| Field | Meaning |
| --- | --- |
| `name` | Must equal the directory and entrypoint stem. |
| `version` | Free-form semver. Bump when you ship behaviour changes. |
| `publoader_api` | Compatible publoader API range. Use `^1.0.0` until you have a reason to pin tighter. |
| `entrypoint` | Module that contains the `Extension` class. |
| `class_name` | Must be `Extension`. |
| `mangadex_group_id` | UUID of the scanlation group the chapters are uploaded under. |
| `languages` | ISO codes the extension produces. |
| `allowed_hosts` | Hostnames your network code talks to. Used for documentation and review — actual egress is not yet enforced. |
| `permissions` | Declares your runtime needs. `subprocess` should be `false` (the AST scanner rejects subprocess use anyway). |
| `schedule` | Optional default schedule. The base repo's `schedule.json` and the per-extension DB override in publoader take precedence in that order. |
| `data_files` | Names of the per-extension data files the runner exposes. |
| `maintainers` | List of GitHub handles responsible for the extension. |
| `homepage` | Public site for the publisher (used in error messages and chapter cards). |

### `manga_id_map.json`

Maps MangaDex manga UUIDs to the publisher's internal identifiers. The schema
varies per publisher — pick whichever fits your data:

```json
// uuid_to_list — one MangaDex id covers many publisher ids
{"333f4d22-7753-4e3b-b0da-0a69b2cdce4f": ["100001", "200008"]}

// uuid_to_string — one-to-one
{"333f4d22-7753-4e3b-b0da-0a69b2cdce4f": "100001"}

// id_to_uuid — publisher id is the primary key
{"100001": "333f4d22-7753-4e3b-b0da-0a69b2cdce4f"}
```

This file is the canonical tracker list — only mappings in here are uploaded.

### `override_options.json`

Optional. Used for manual overrides where the source doesn't conform to
MangaDex's chapter format. Your code only needs to use these keys when the
fields apply to your publisher:

```json
{
  "empty": [],
  "noformat": [],
  "custom": {"series_id": "regex"},
  "same": {"chapter_to_keep_id": ["other_chapter_id"]},
  "custom_language": {},
  "multi_chapters": {"chapter_id": ["chapter_number"]},
  "override_chapter_numbers": {"chapter_id": "overridden_chapter_number"}
}
```

| Key | Purpose |
| --- | --- |
| `empty` | Manga IDs whose chapters never have titles (null titles are OK for these). |
| `noformat` | Titles you don't want your regex to rewrite. |
| `custom` | Per-series custom regex for chapter parsing. |
| `same` | Duplicate-chapter aliasing. Only the keys are uploaded; values are treated as the same chapter. |
| `custom_language` | Language remapping for publishers that use non-standard codes. |
| `multi_chapters` | One source chapter that should appear as multiple chapter numbers on MangaDex. |
| `override_chapter_numbers` | Force a specific chapter number on a chapter ID. |

The runner only reads `same`, `custom_language`, `multi_chapters`, and
`override_chapter_numbers`. Everything else is for the extension's own use.

### Scheduling

Add your extension to `/schedule.json` at the repo root:

```json
{
  "mangaplus": {
    "day": 0,
    "hour": 15,
    "minute": 5
  }
}
```

`day` is optional. When present it is the day-of-week index (Monday=0,
Sunday=6) — `every Tuesday at 15:05` is `{"day": 1, "hour": 15, "minute": 5}`.

Operators can override the daily timing per-extension at runtime from Discord
(`/schedule set <ext> <hour> <minute> [day]`) — the override lives in
publoader's SQLite state DB and survives restarts. The `schedule.json` shipped
here is the fallback, not the final word.

The legacy `run_at` method on the extension class is **ignored** when
`schedule.json` defines a timing for that extension.

### Dependencies

Use whatever modules you need, but list them in your extension's
`requirements.txt`. publoader installs each extension's `requirements.txt`
on startup (skipping anything already satisfied).

## The `Extension` class

The class **must** be named `Extension`. The runner instantiates it once per
run with at least an `extension_dirpath: Path` keyword.

```python
from pathlib import Path

class Extension:
    def __init__(self, extension_dirpath: Path, **kwargs):
        ...
```

### Required attributes

| Field | Type | Description |
| --- | --- | --- |
| `name` | `str` | Logger / database key. Keep this stable — changing it loses chapter history. |
| `mangadex_group_id` | `str` | UUID of the upload group. |
| `override_options` | `dict` | Parsed `override_options.json`. Use `{}` if not applicable. |
| `extension_languages` | `List[str]` | ISO codes the extension can produce. |
| `tracked_mangadex_ids` | `List[str]` | MangaDex manga IDs the extension covers. |
| `disabled` | `bool` | Skip the extension when `True`. Defaults to `True` if missing — be explicit. |

### Required methods

None of these methods take parameters (apart from `self`).

| Method | Returns | Notes |
| --- | --- | --- |
| `get_updated_chapters()` | `List[Chapter]` | New chapters since last run. |
| `get_all_chapters()` | `List[Chapter]` or `None` | Full per-series chapter set. `None` skips removed-chapter detection. `[]` removes everything for the series. **Implement this if you can — it powers the unavailable-chapter flow.** |
| `get_updated_manga()` | `List[Manga]` | New series the publisher has added but you haven't tracked yet. |
| `run_at()` | `datetime.time` or `datetime.datetime` | Default run time. Overridden by `schedule.json` and DB overrides — kept for backwards compatibility. |
| `clean_at()` | `Optional[List[int]]` | Days to run a clean reconcile. `None` disables; `[]` defaults to Wednesday; `[0, 3]` runs on Mondays and Thursdays. |
| `daily_check_run()` | `bool` | If `True`, runs daily at 01:00 to catch missed uploads. |

Wrong return types skip the run.

### Methods that accept parameters

```python
def update_external_data(
    self,
    posted_chapter_ids: List[str],
    fetch_all_chapters: bool,
    **kwargs,
) -> None:
    ...
```

`posted_chapter_ids` is the set of chapters already on MangaDex from previous
runs. `fetch_all_chapters` is `True` during a clean reconcile. **`**kwargs` is
required** — publoader may pass more keyword arguments as the API grows.

### Unavailable chapters (since publoader 1.0)

When a chapter that publoader previously uploaded is no longer in your
`get_all_chapters()` return value, publoader does **not** delete it. It strips
the chapter's `externalUrl` on MangaDex (so the publisher link goes away) and
leaves the in-page info card that was uploaded at first commit. The DB row
moves to the `to_unavailable` collection. Duplicate cleanups still hard-delete.

You don't need to do anything new — just keep returning the current set of
on-source chapters from `get_all_chapters()`. The runner handles the rest.

## `Chapter` and `Manga`

Import from the stable public API surface:

```python
from publoader.api import Chapter, Manga
```

Older imports (`from publoader.models.dataclasses import Chapter, Manga`) still
work but `publoader.api` is the one we'll keep guaranteeing across versions.
`publoader.api.__api_version__` tells you what surface you're getting.

### `Chapter` fields

`Optional[...]` fields can be `None`. The rest are required.

| Field | Type | Meaning |
| --- | --- | --- |
| `chapter_timestamp` | `datetime.datetime` | Publish time. Will be made tz-aware if naive. |
| `chapter_expire` | `Optional[datetime.datetime]` | Expiry time. Tz-aware. |
| `chapter_title` | `Optional[str]` | |
| `chapter_number` | `Optional[str]` | Must match the MangaDex chapter-number regex (see below). |
| `chapter_language` | `str` | ISO-639-2 code. |
| `chapter_volume` | `Optional[str]` | Use this for seasons. |
| `chapter_id` | `str` | Publisher's chapter id. |
| `chapter_url` | `str` | Public chapter link. |
| `manga_id` | `str` | Publisher's series id. |
| `md_manga_id` | `str` | MangaDex manga UUID. |
| `manga_name` | `str` | Series name. |
| `manga_url` | `str` | Series link. |

## Module-level requirements

`__version__` must be defined at module level so the runner can include it in
logs.

The logger must be set up using `setup_extension_logs`:

```python
from publoader.api import setup_extension_logs

setup_extension_logs(
    logger_name="<extension_name>",
    logger_filename="<extension_name>",
)
```

### Helpers provided

```python
from publoader.api import (
    open_manga_id_map,
    open_title_regex,
    find_key_from_list_value,
    chapter_number_regex,
    create_new_event_loop,
    PubloaderWebhook,
)
```

| Symbol | Purpose |
| --- | --- |
| `open_manga_id_map(path)` | Read your `manga_id_map.json`. |
| `open_title_regex(path)` | Read your `override_options.json`. |
| `find_key_from_list_value(d, value)` | Reverse lookup: returns the dict key whose list value contains `value`. |
| `chapter_number_regex` | Pre-compiled MangaDex chapter-number pattern. `chapter_number_regex.match("12.5")`. |
| `create_new_event_loop()` | Convenience for extensions that need a dedicated asyncio loop. |
| `PubloaderWebhook` | Push extension-side notifications through the configured webhooks. |

## AST safety scan

Extensions are loaded with a static AST check that rejects modules using
`eval`, `exec`, `compile`, `__import__`, `subprocess`, `ctypes`, and a few
other footguns. The scan is **not** a sandbox — operators still have to trust
this repo — but it catches obvious mistakes and accidental imports.

If your extension genuinely needs a banned construct, open an issue first.

## Running CI locally

```bash
python tools/validate_manifests.py     # schema-checks every src/*/manifest.json
python tools/smoke_load.py             # imports each entrypoint under publoader.api stubs
```

Both are gated on `.github/workflows/extension-tests.yml`.

## Submitting

Open a PR against `master`. Format with [Black](https://pypi.org/project/black/)
using defaults. Your extension must:

1. Have a valid `manifest.json` (CI enforces this).
2. Smoke-import cleanly (CI enforces this).
3. Run successfully against your publisher before merge (operator-verified).

Erroneous extensions are skipped at runtime, not rejected outright — but please
don't ship anything you haven't run yourself.

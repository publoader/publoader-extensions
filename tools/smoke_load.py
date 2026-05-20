"""Smoke-load every extension under ./src.

For each extension, this:
  - imports `<name>.py` via importlib (no network, no DB)
  - instantiates Extension(extension_dirpath=<dir>)
  - reads the eagerly-required attributes the base loader will fetch
  - calls the no-arg lifecycle methods (run_at, clean_at, daily_check_run)
  - validates manifest.json against the extension's runtime values

Used by CI to catch contract drift before merge.
"""
from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

REQUIRED_ATTRS = (
    "name",
    "mangadex_group_id",
    "override_options",
    "extension_languages",
    "tracked_mangadex_ids",
    "disabled",
)
REQUIRED_METHODS = (
    "get_updated_chapters",
    "get_all_chapters",
    "get_updated_manga",
    "run_at",
    "clean_at",
    "daily_check_run",
)


def smoke_one(ext_dir: Path) -> list:
    """Return a list of failure messages (empty list ⇒ pass)."""
    name = ext_dir.name
    entry = ext_dir / f"{name}.py"
    if not entry.is_file():
        return [f"missing entrypoint {entry}"]

    spec = importlib.util.spec_from_file_location(name, entry)
    mod = importlib.util.module_from_spec(spec)
    failures: list = []
    try:
        spec.loader.exec_module(mod)
    except Exception as e:
        return [f"failed to import {entry.name}: {e!r}"]

    if not hasattr(mod, "Extension"):
        return [f"{entry.name} has no Extension class"]

    try:
        ext = mod.Extension(extension_dirpath=ext_dir)
    except Exception as e:
        return [f"Extension(extension_dirpath=...) raised: {e!r}"]

    for attr in REQUIRED_ATTRS:
        try:
            getattr(ext, attr)
        except Exception as e:
            failures.append(f"missing attribute {attr!r}: {e!r}")

    for meth in REQUIRED_METHODS:
        m = getattr(ext, meth, None)
        if not callable(m):
            failures.append(f"missing or non-callable method {meth!r}")
            continue

    # No-arg lifecycle methods shouldn't hit the network
    for meth in ("run_at", "clean_at", "daily_check_run"):
        m = getattr(ext, meth, None)
        if callable(m):
            try:
                m()
            except Exception as e:
                failures.append(f"{meth}() raised: {e!r}")

    manifest_path = ext_dir / "manifest.json"
    if not manifest_path.is_file():
        failures.append("manifest.json missing")
    else:
        try:
            manifest = json.loads(manifest_path.read_text())
        except (OSError, ValueError) as e:
            failures.append(f"manifest.json unreadable: {e}")
        else:
            if manifest.get("name") != name:
                failures.append(
                    f"manifest.name={manifest.get('name')!r} != dir name {name!r}"
                )
            mid = manifest.get("mangadex_group_id")
            if mid and getattr(ext, "mangadex_group_id", None) != mid:
                failures.append(
                    "manifest.mangadex_group_id doesn't match Extension.mangadex_group_id"
                )

    return failures


def main() -> int:
    if not SRC.is_dir():
        print("no src/ directory; nothing to test", file=sys.stderr)
        return 2

    overall_ok = True
    for ext_dir in sorted(SRC.iterdir()):
        if not ext_dir.is_dir() or ext_dir.name.startswith((".", "__")):
            continue
        failures = smoke_one(ext_dir)
        if failures:
            overall_ok = False
            print(f"FAIL {ext_dir.name}")
            for f in failures:
                print(f"  - {f}")
        else:
            print(f"OK   {ext_dir.name}")

    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())

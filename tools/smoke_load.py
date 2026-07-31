"""Smoke-load every extension under ./src.

Dispatches on the manifest's effective runtime.

Python extensions (publoader_api ^1 / runtime "python"):
  - imports `<name>.py` via importlib (no network, no DB)
  - instantiates Extension(extension_dirpath=<dir>)
  - reads the eagerly-required attributes the base loader will fetch
  - calls the no-arg lifecycle methods (run_at, clean_at, daily_check_run)
  - validates manifest.json against the extension's runtime values

Node extensions (publoader_api ^2 / runtime "node"):
  - checks the entrypoint is present, or that a TypeScript source plus the
    build config it is bundled from is (the platform CLI runs esbuild at
    publish time, so `.mjs` is generated for those)
  - syntax-checks any shipped `.mjs` with `node --check` when node is on PATH
  - checks the module default-exports the factory the runner will call

There is deliberately no execution of node extension code here: `collect()`
only runs against a real sandboxed context supplied by the worker.

Used by CI to catch contract drift before merge.
"""
from __future__ import annotations

import importlib.util
import json
import re
import shutil
import subprocess
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

_DEFAULT_EXPORT = re.compile(r"^\s*export\s+default\b", re.MULTILINE)


def manifest_runtime(data: dict) -> str:
    """Effective runtime: explicit field, else the publoader_api major."""
    runtime = data.get("runtime")
    if runtime in ("node", "python"):
        return runtime
    major = re.sub(r"^[^0-9]*", "", str(data.get("publoader_api", ""))).split(".")[0]
    return "python" if major == "1" else "node"


def check_manifest_identity(ext_dir: Path, manifest: dict, ext=None) -> list:
    """Manifest checks common to both runtimes."""
    failures: list = []
    if manifest.get("name") != ext_dir.name:
        failures.append(
            f"manifest.name={manifest.get('name')!r} != dir name {ext_dir.name!r}"
        )
    mid = manifest.get("mangadex_group_id")
    if ext is not None and mid and getattr(ext, "mangadex_group_id", None) != mid:
        failures.append(
            "manifest.mangadex_group_id doesn't match Extension.mangadex_group_id"
        )
    return failures


def smoke_node(ext_dir: Path, manifest: dict) -> list:
    """Static checks for a TypeScript/ESM extension."""
    failures: list = []
    entrypoint = manifest.get("entrypoint", "")
    if not isinstance(entrypoint, str) or not entrypoint.endswith((".mjs", ".js")):
        return [f"node runtime needs a .mjs/.js entrypoint, got {entrypoint!r}"]

    bundled = ext_dir / entrypoint
    source = ext_dir / "src" / "index.ts"

    if bundled.is_file():
        text = bundled.read_text()
        if not _DEFAULT_EXPORT.search(text):
            failures.append(f"{entrypoint} has no `export default` factory")
        if shutil.which("node"):
            result = subprocess.run(
                ["node", "--check", str(bundled)], capture_output=True, text=True
            )
            if result.returncode != 0:
                failures.append(
                    f"node --check {entrypoint} failed: "
                    f"{result.stderr.strip().splitlines()[0] if result.stderr else ''}"
                )
    elif source.is_file():
        # Built by the platform CLI (esbuild) at publish time.
        for needed in ("package.json", "tsconfig.json"):
            if not (ext_dir / needed).is_file():
                failures.append(f"TypeScript source present but {needed} is missing")
        if not _DEFAULT_EXPORT.search(source.read_text()):
            failures.append("src/index.ts has no `export default` factory")
    else:
        failures.append(f"neither {entrypoint} nor src/index.ts is present")

    failures.extend(check_manifest_identity(ext_dir, manifest))
    return failures


def smoke_python(ext_dir: Path, manifest: dict) -> list:
    """Import-and-poke checks for a legacy class-based extension."""
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

    failures.extend(check_manifest_identity(ext_dir, manifest, ext))
    return failures


def smoke_one(ext_dir: Path) -> list:
    """Return a list of failure messages (empty list ⇒ pass)."""
    manifest_path = ext_dir / "manifest.json"
    if not manifest_path.is_file():
        return ["manifest.json missing"]
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError) as e:
        return [f"manifest.json unreadable: {e}"]

    if manifest_runtime(manifest) == "node":
        return smoke_node(ext_dir, manifest)
    return smoke_python(ext_dir, manifest)


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

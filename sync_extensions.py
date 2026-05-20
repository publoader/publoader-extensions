"""Sync extension source trees into the shared runtime volume.

Only `src/<extension>/` subtrees are copied. The Dockerfile, LICENSE, README,
.github, sync_extensions.py itself, .git, and top-level configs are excluded
so the runtime volume contains exactly what the base loader expects.

Destination layout:
    <TARGET_DIR>/<extension_name>/<extension_name>.py
    <TARGET_DIR>/<extension_name>/manifest.json
    <TARGET_DIR>/<extension_name>/manga_id_map.json
    <TARGET_DIR>/<extension_name>/...
    <TARGET_DIR>/schedule.json   (copied from repo root)
"""
from __future__ import annotations

import json
import logging
import os
import shutil
import sys
import tempfile
from pathlib import Path

SOURCE_ROOT = Path(os.environ.get("PUBLOADER_SOURCE", "/extensions"))
SOURCE_SRC = SOURCE_ROOT / "src"
TARGET_DIR = Path(
    os.environ.get("PUBLOADER_TARGET", "/shared/publoader/extensions")
)
SCHEDULE_FILE = SOURCE_ROOT / "schedule.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s sync_extensions: %(message)s",
)
log = logging.getLogger("sync_extensions")


def _is_valid_extension_name(name: str) -> bool:
    return bool(name) and all(c.islower() or c.isdigit() or c == "_" for c in name)


def _atomic_replace_tree(src: Path, dst: Path) -> None:
    """Replace `dst` with `src` atomically via rename (same filesystem)."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f".{dst.name}.", dir=dst.parent))
    try:
        shutil.copytree(src, staging / dst.name, dirs_exist_ok=False)
        backup = None
        if dst.exists():
            backup = dst.with_suffix(dst.suffix + ".old")
            if backup.exists():
                shutil.rmtree(backup)
            dst.rename(backup)
        (staging / dst.name).rename(dst)
        if backup is not None:
            shutil.rmtree(backup, ignore_errors=True)
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def _validate_extension(ext_dir: Path) -> bool:
    name = ext_dir.name
    if not _is_valid_extension_name(name):
        log.error("skip %s: invalid extension name", name)
        return False
    if not (ext_dir / f"{name}.py").is_file():
        log.error("skip %s: missing %s.py", name, name)
        return False
    manifest_path = ext_dir / "manifest.json"
    if not manifest_path.is_file():
        log.error("skip %s: missing manifest.json", name)
        return False
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError) as exc:
        log.error("skip %s: manifest.json invalid (%s)", name, exc)
        return False
    if manifest.get("name") != name:
        log.error(
            "skip %s: manifest.name=%r doesn't match directory",
            name,
            manifest.get("name"),
        )
        return False
    return True


def main() -> int:
    if not SOURCE_SRC.is_dir():
        log.error("source missing: %s", SOURCE_SRC)
        return 2

    TARGET_DIR.mkdir(parents=True, exist_ok=True)
    synced: list = []
    skipped: list = []

    for child in sorted(SOURCE_SRC.iterdir()):
        if not child.is_dir() or child.name.startswith((".", "__")):
            continue
        if not _validate_extension(child):
            skipped.append(child.name)
            continue
        try:
            _atomic_replace_tree(child, TARGET_DIR / child.name)
            synced.append(child.name)
        except OSError as exc:
            log.exception("failed syncing %s: %s", child.name, exc)
            skipped.append(child.name)

    if SCHEDULE_FILE.is_file():
        try:
            shutil.copy2(SCHEDULE_FILE, TARGET_DIR / SCHEDULE_FILE.name)
        except OSError as exc:
            log.exception("failed copying schedule.json: %s", exc)

    log.info("synced=%s skipped=%s target=%s", synced, skipped, TARGET_DIR)
    return 0 if not skipped else 1


if __name__ == "__main__":
    sys.exit(main())

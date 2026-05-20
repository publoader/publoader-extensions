"""Validate every src/<extension>/manifest.json against the required shape."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

REQUIRED_FIELDS = {
    "name": str,
    "version": str,
    "publoader_api": str,
    "entrypoint": str,
    "class_name": str,
    "mangadex_group_id": str,
    "languages": list,
    "allowed_hosts": list,
    "permissions": dict,
}

_UUID = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_EXT_NAME = re.compile(r"^[a-z0-9_]+$")


def validate(ext_dir: Path) -> list:
    name = ext_dir.name
    path = ext_dir / "manifest.json"
    if not path.is_file():
        return [f"{name}: missing manifest.json"]
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        return [f"{name}: unreadable ({e})"]

    failures: list = []
    if not isinstance(data, dict):
        return [f"{name}: top-level must be an object"]

    for field, want_type in REQUIRED_FIELDS.items():
        if field not in data:
            failures.append(f"{name}: missing field {field!r}")
        elif not isinstance(data[field], want_type):
            failures.append(
                f"{name}: field {field!r} expected {want_type.__name__}, got "
                f"{type(data[field]).__name__}"
            )

    if data.get("name") != name:
        failures.append(
            f"{name}: manifest.name={data.get('name')!r} doesn't match dir"
        )
    if not _EXT_NAME.match(name):
        failures.append(f"{name}: dir name isn't lower_snake_case")
    if "mangadex_group_id" in data and not _UUID.match(str(data["mangadex_group_id"])):
        failures.append(f"{name}: mangadex_group_id isn't a UUID")
    if "languages" in data:
        for lang in data["languages"]:
            if not isinstance(lang, str):
                failures.append(f"{name}: languages entry {lang!r} isn't a string")
    if "allowed_hosts" in data:
        for host in data["allowed_hosts"]:
            if not isinstance(host, str) or "/" in host:
                failures.append(f"{name}: allowed_hosts entry {host!r} invalid")
    perms = data.get("permissions")
    if isinstance(perms, dict):
        for key in ("network", "subprocess"):
            if key in perms and not isinstance(perms[key], bool):
                failures.append(f"{name}: permissions.{key} must be bool")
        for key in ("filesystem_read", "filesystem_write"):
            if key in perms and not isinstance(perms[key], list):
                failures.append(f"{name}: permissions.{key} must be a list")
    return failures


def main() -> int:
    if not SRC.is_dir():
        print("no src/ directory", file=sys.stderr)
        return 2
    overall_ok = True
    for ext_dir in sorted(SRC.iterdir()):
        if not ext_dir.is_dir() or ext_dir.name.startswith((".", "__")):
            continue
        failures = validate(ext_dir)
        if failures:
            overall_ok = False
            for f in failures:
                print(f"FAIL {f}")
        else:
            print(f"OK   {ext_dir.name}/manifest.json")
    return 0 if overall_ok else 1


if __name__ == "__main__":
    sys.exit(main())

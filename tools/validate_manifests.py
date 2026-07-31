"""Validate every src/<extension>/manifest.json against the required shape.

Understands both extension contracts:

  * publoader_api ^1 / runtime "python" — the legacy class-based extensions,
    which must declare ``class_name`` and a ``.py`` entrypoint.
  * publoader_api ^2 / runtime "node"   — the TypeScript/ESM extensions, whose
    entrypoint is the bundled ``.mjs`` and which have no class at all.

Mirrors the enforced zod schema in the publoader platform repo
(``platform/src/contracts/manifest.ts``); keep the two in step.
"""
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
_ENTRYPOINT = re.compile(r"^[a-zA-Z0-9_./-]+\.(py|mjs|js)$")


def manifest_runtime(data: dict) -> str:
    """Effective runtime: explicit field, else the publoader_api major."""
    runtime = data.get("runtime")
    if runtime in ("node", "python"):
        return runtime
    major = re.sub(r"^[^0-9]*", "", str(data.get("publoader_api", ""))).split(".")[0]
    return "python" if major == "1" else "node"


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

    runtime = manifest_runtime(data)
    if "runtime" in data and data["runtime"] not in ("node", "python"):
        failures.append(f"{name}: runtime must be 'node' or 'python'")

    entrypoint = data.get("entrypoint")
    if isinstance(entrypoint, str):
        if not _ENTRYPOINT.match(entrypoint):
            failures.append(f"{name}: entrypoint {entrypoint!r} must be .py/.mjs/.js")
        elif runtime == "python" and not entrypoint.endswith(".py"):
            failures.append(f"{name}: python runtime needs a .py entrypoint")
        elif runtime == "node" and entrypoint.endswith(".py"):
            failures.append(f"{name}: node runtime can't have a .py entrypoint")

    if runtime == "python":
        # v1 extensions are loaded by class name; v2 has no class.
        if "class_name" not in data:
            failures.append(f"{name}: missing field 'class_name'")
        elif not isinstance(data["class_name"], str):
            failures.append(f"{name}: field 'class_name' expected str")
    elif "class_name" in data:
        failures.append(f"{name}: 'class_name' is meaningless for the node runtime")

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
            elif runtime == "node" and perms.get(key):
                failures.append(
                    f"{name}: permissions.{key} must be empty — the node runtime "
                    f"gives extensions no filesystem access"
                )
    data_files = data.get("data_files", {})
    if isinstance(data_files, dict):
        for key, filename in data_files.items():
            if not isinstance(filename, str):
                failures.append(f"{name}: data_files[{key!r}] isn't a string")
            elif not (ext_dir / filename).is_file():
                failures.append(f"{name}: data_files[{key!r}] -> {filename} not found")
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

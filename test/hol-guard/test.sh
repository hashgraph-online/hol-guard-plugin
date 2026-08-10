#!/bin/sh
set -eu

command -v hol-guard >/dev/null
command -v plugin-scanner >/dev/null
hol-guard --help >/dev/null
plugin-scanner --help >/dev/null

python3 - <<'PY'
from pathlib import Path

for name in ("hol-guard", "plugin-scanner"):
    path = Path("/usr/local/bin") / name
    if not path.is_symlink():
        raise SystemExit(f"{path} is not a symlink into the isolated HOL Guard environment")
    resolved = path.resolve()
    if "/usr/local/share/hol-guard/venv/bin/" not in str(resolved):
        raise SystemExit(f"unexpected {name} target: {resolved}")
PY

echo "HOL Guard Dev Container feature passed."

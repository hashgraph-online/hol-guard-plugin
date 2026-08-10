#!/bin/sh
set -eu

VERSION="${VERSION:-latest}"
INSTALL_ROOT="/usr/local/share/hol-guard"
VENV_DIR="${INSTALL_ROOT}/venv"

ensure_python() {
    if command -v python3 >/dev/null 2>&1; then
        return 0
    fi

    if command -v apt-get >/dev/null 2>&1; then
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-venv ca-certificates
        rm -rf /var/lib/apt/lists/*
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y python3 ca-certificates
        dnf clean all
    elif command -v microdnf >/dev/null 2>&1; then
        microdnf install -y python3 ca-certificates
        microdnf clean all
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache python3 py3-pip ca-certificates
    else
        echo "HOL Guard requires Python 3.10 or newer, and no supported package manager was found." >&2
        exit 1
    fi
}

ensure_supported_python() {
    if ! python3 - <<'PY'
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
    then
        echo "HOL Guard requires Python 3.10 or newer. Found: $(python3 --version 2>&1)" >&2
        exit 1
    fi
}

ensure_venv_support() {
    probe="$(mktemp -d)"
    if python3 -m venv "${probe}/venv" >/dev/null 2>&1; then
        rm -rf "$probe"
        return 0
    fi
    rm -rf "$probe"

    if command -v apt-get >/dev/null 2>&1; then
        apt-get update
        DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3-venv
        rm -rf /var/lib/apt/lists/*
    else
        echo "Python venv support is required to install HOL Guard without modifying system Python packages." >&2
        exit 1
    fi
}

ensure_python
ensure_supported_python
ensure_venv_support

rm -rf "$VENV_DIR"
mkdir -p "$INSTALL_ROOT"
python3 -m venv "$VENV_DIR"

"$VENV_DIR/bin/python" -m pip install --disable-pip-version-check --no-cache-dir --upgrade pip
if [ "$VERSION" = "latest" ]; then
    "$VENV_DIR/bin/python" -m pip install --disable-pip-version-check --no-cache-dir hol-guard
else
    case "$VERSION" in
        *[!0-9A-Za-z._+-]*)
            echo "Invalid HOL Guard version: $VERSION" >&2
            exit 1
            ;;
    esac
    "$VENV_DIR/bin/python" -m pip install --disable-pip-version-check --no-cache-dir "hol-guard==$VERSION"
fi

for command_name in hol-guard plugin-scanner plugin-guard plugin-ecosystem-scanner; do
    if [ -x "$VENV_DIR/bin/$command_name" ]; then
        ln -sf "$VENV_DIR/bin/$command_name" "/usr/local/bin/$command_name"
    fi
done

hol-guard --help >/dev/null
plugin-scanner --help >/dev/null

echo "HOL Guard installed. Run 'hol-guard init' after the dev container starts to enable protection for your user and agent tools."

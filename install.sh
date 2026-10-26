#!/usr/bin/env bash
# One-line installer for Claw Orchestrator as an OpenClaw plugin.
# Standalone use (CLI, MCP server, ACP agent) needs only: npm install -g @enderfga/claw-orchestrator
# Usage: curl -fsSL https://raw.githubusercontent.com/Enderfga/claw-orchestrator/main/install.sh | bash
set -euo pipefail

NPM_PACKAGE="@enderfga/claw-orchestrator"
LEGACY_PACKAGE="@enderfga/openclaw-claude-code"
LEGACY_PLUGIN_ID="openclaw-claude-code"
CONFIG_FILE="${HOME}/.openclaw/openclaw.json"

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✔\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m✘\033[0m %s\n' "$*" >&2; exit 1; }

# ── Prerequisites ────────────────────────────────────────
command -v npm  >/dev/null 2>&1 || fail "npm not found. Install Node.js 22 or later first: https://nodejs.org"
command -v openclaw >/dev/null 2>&1 || fail "openclaw not found. This script installs the OpenClaw plugin: install OpenClaw first (https://docs.openclaw.ai), or for standalone use run: npm install -g ${NPM_PACKAGE}"

# ── Step 1: npm global install ───────────────────────────
info "Installing ${NPM_PACKAGE} via npm..."

# Symmetric to the openclaw.json cleanup below: a direct v2.x -> v3.1 upgrade
# may still have the deprecated package globally installed. We don't auto-
# uninstall (the operator may have scripts pinned to the old name during a
# migration window); just surface the deprecation and the one-liner to clean
# it up at their convenience.
if npm ls -g --depth=0 --json 2>/dev/null | grep -q "\"${LEGACY_PACKAGE}\""; then
    warn "${LEGACY_PACKAGE} is still installed globally. After this script finishes, run:"
    warn "    npm uninstall -g ${LEGACY_PACKAGE}"
fi

npm install -g "${NPM_PACKAGE}" --silent 2>&1 | tail -1

PKG_PATH="$(npm root -g)/${NPM_PACKAGE}"
[ -d "${PKG_PATH}" ] || fail "npm install succeeded but package not found at ${PKG_PATH}"

VERSION="$(node -e "console.log(require('${PKG_PATH}/package.json').version)")"
ok "Installed v${VERSION} at ${PKG_PATH}"

# ── Step 2: Register in openclaw.json via plugins.load.paths ──
if [ ! -f "${CONFIG_FILE}" ]; then
    warn "openclaw.json not found at ${CONFIG_FILE}"
    warn "Add this to your openclaw.json manually:"
    echo ""
    echo '  "plugins": { "load": { "paths": ["'"${PKG_PATH}"'"] } }'
    echo ""
else
    info "Configuring openclaw.json..."
    python3 -c "
import json, sys

with open('${CONFIG_FILE}') as f:
    cfg = json.load(f)

plugins = cfg.setdefault('plugins', {})
load = plugins.setdefault('load', {})
paths = load.setdefault('paths', [])

pkg_path = '${PKG_PATH}'
legacy_plugin_id = '${LEGACY_PLUGIN_ID}'

# Direct v2.x -> v3.1 upgrades can still have stale legacy load paths.
# Keep this idempotent cleanup even after the v3.0 compatibility aliases are gone.
new_paths = []
for p in paths:
    if p.endswith(f'/{legacy_plugin_id}'):
        print(f'Removing stale v2.x load path: {p}')
        continue
    new_paths.append(p)
paths[:] = new_paths

# Check if already registered (exact match or different path to same package)
already = False
for p in paths:
    if p == pkg_path:
        already = True
        break
    # Also match if an existing path ends with the new package name (different prefix)
    if p.endswith('/claw-orchestrator'):
        print(f'Replacing existing path: {p}')
        paths[paths.index(p)] = pkg_path
        already = True
        break

if not already:
    paths.append(pkg_path)

# Remove stale entries.openclaw-claude-code if present (doesn't work without load.paths)
entries = plugins.get('entries', {})
if legacy_plugin_id in entries:
    del entries[legacy_plugin_id]
    print(f'Removed stale plugins.entries.{legacy_plugin_id}')

with open('${CONFIG_FILE}', 'w') as f:
    json.dump(cfg, f, indent=2)
    f.write('\n')
" 2>&1 && ok "Plugin registered in plugins.load.paths" \
         || { warn "Auto-configure failed. Add manually to openclaw.json:"; echo '  "plugins": { "load": { "paths": ["'"${PKG_PATH}"'"] } }'; }
fi

# ── Step 3: Restart gateway ──────────────────────────────
echo ""
info "Restarting OpenClaw gateway..."
if openclaw gateway restart 2>&1 | grep -q "Restarted"; then
    ok "Gateway restarted"
else
    warn "Gateway restart may have failed — try: openclaw gateway restart"
fi

# ── Step 4: Verify ───────────────────────────────────────
sleep 2
info "Verifying..."
if openclaw plugins list 2>/dev/null | grep -q "claw-orchestrator"; then
    ok "Claw Orchestrator is loaded and ready!"
else
    warn "Plugin may need a moment to load. Check with: openclaw plugins list"
fi

echo ""
ok "Done! Your OpenClaw agents now have session_start, workflow_start, council_start and the rest of the Claw Orchestrator tools."
echo "  Docs: https://github.com/Enderfga/claw-orchestrator"

#!/bin/bash
# CCrew — a parallel "UI skin over the claude & codex CLIs", built on the KiroCrew
# fork. Runs ALONGSIDE an installed KiroCrew without collision:
#
#   * KIROCREW_PROFILE=standalone   — this is an OSS fork with no enterprise
#     companion package, so a non-standalone profile (e.g. an inherited
#     'amazon'/'enterprise' marker left by an installed KiroCrew or its parent
#     process) fails closed at boot. Standalone is the correct, only-bootable
#     edition here. We FORCE it (not `:-`) so an inherited KIROCREW_PROFILE in
#     the environment cannot override it. It does NOT touch login/licensing:
#     each backend (claude / codex / kiro) signs in through its OWN credential
#     file, outside KiroCrew, so both apps share the same CLI logins.
#   * KIROCREW_HOME=~/.ccrew        — isolated data home (sessions, config,
#     memory) so CCrew never shares state with an installed ~/.kiro/crew.
#   * KIROCREW_PORT=5490            — distinct from KiroCrew's default 5476.
#
# The CLI credentials (~/.claude, ~/.codex, kiro-cli's) live OUTSIDE the data
# home, so isolating the home does not re-prompt any login.
#
# This file is additive (a new launcher, no edits to shared code) to keep
# `git pull upstream` conflict-free.
#
# Usage: ./ccrew.sh            # run the parallel CCrew gateway
#        ./ccrew.sh doctor     # run any kirocrew subcommand under the CCrew env
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Prefer the venv Python (has all deps). Override with RUNTIME_PYTHON if needed.
RUNTIME_PYTHON="${RUNTIME_PYTHON:-}"
if [ -z "$RUNTIME_PYTHON" ] || [ ! -x "$RUNTIME_PYTHON" ]; then
    if [ -x "$SCRIPT_DIR/.venv/bin/python" ]; then
        RUNTIME_PYTHON="$SCRIPT_DIR/.venv/bin/python"
    fi
fi
if [ ! -x "$RUNTIME_PYTHON" ]; then
    echo "ERROR: Cannot find the CCrew venv Python at $SCRIPT_DIR/.venv/bin/python."
    echo "Build once with:  make frontend && make backend PY=python3"
    echo "(or set RUNTIME_PYTHON to a Python that has the deps installed)."
    exit 1
fi

# The Phase 1 fix: FORCE the standalone edition so boot composes cleanly.
# Forced (not `${VAR:-default}`) because this session's parent environment may
# already carry KIROCREW_PROFILE=amazon/enterprise, which would otherwise win
# and fail boot closed.
export KIROCREW_PROFILE=standalone

# Isolated data home. Absolutize it: config_dir() resolves relative paths
# against each process's CWD, and MCP subprocesses are spawned with session
# CWDs — a relative HOME makes them create empty config dirs (no .local_secret)
# and their gateway IPC calls then fail 403.
export KIROCREW_HOME="${KIROCREW_HOME:-$HOME/.ccrew}"
case "$KIROCREW_HOME" in
    /*) ;;
    *) KIROCREW_HOME="$SCRIPT_DIR/$KIROCREW_HOME" ;;
esac

# Distinct port from an installed KiroCrew (5476).
export KIROCREW_PORT="${KIROCREW_PORT:-5490}"

# Default subcommand is `gateway`; allow any (e.g. `doctor`) to be passed.
if [ "$#" -eq 0 ]; then
    set -- gateway
fi

echo "👻 CCrew starting — UI skin over claude & codex CLIs"
echo "   Python:  $RUNTIME_PYTHON"
echo "   Profile: $KIROCREW_PROFILE"
echo "   Data:    $KIROCREW_HOME"
echo "   Port:    $KIROCREW_PORT   (dashboard: http://127.0.0.1:$KIROCREW_PORT)"
echo ""

exec "$RUNTIME_PYTHON" -m kiro_crew "$@"

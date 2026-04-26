#!/usr/bin/env bash
# Manage agent-memory-daemon as a macOS LaunchAgent (auto-start at login).
# Usage: ./scripts/daemon.sh {start|stop|remove|status} [config-path]
# Env:
#   LOG_DIR       Override log directory (default: $HOME/.agent-memory/logs)
#   LOG_TTL_DAYS  Delete *.log older than N days on start (0 or unset = no cleanup)
set -euo pipefail

LABEL="com.agent-memory-daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="${LOG_DIR:-$HOME/.agent-memory/logs}"
LOG_TTL_DAYS="${LOG_TTL_DAYS:-0}"
CONFIG="${2:-$HOME/.agent-memory/memconsolidate.toml}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEMPLATE="$SCRIPT_DIR/$LABEL.plist.template"

cleanup_logs() {
    [[ "$LOG_TTL_DAYS" -gt 0 && -d "$LOG_DIR" ]] || return 0
    find "$LOG_DIR" -maxdepth 1 -name '*.log' -type f -mtime +"$LOG_TTL_DAYS" -delete 2>/dev/null || true
}

install_plist() {
    local bin
    bin="$(command -v agent-memory-daemon || true)"
    [[ -z "$bin" ]] && { echo "error: agent-memory-daemon not found in PATH. Install with: npm i -g agent-memory-daemon" >&2; exit 1; }
    [[ ! -f "$CONFIG" ]] && { echo "error: config not found: $CONFIG" >&2; exit 1; }
    mkdir -p "$LOG_DIR" "$(dirname "$PLIST")"
    sed -e "s|__LABEL__|$LABEL|g" \
        -e "s|__DAEMON_BIN__|$bin|g" \
        -e "s|__CONFIG__|$CONFIG|g" \
        -e "s|__LOG_DIR__|$LOG_DIR|g" \
        -e "s|__PATH__|$PATH|g" \
        "$TEMPLATE" > "$PLIST"
}

case "${1:-}" in
    start)
        cleanup_logs
        install_plist
        launchctl unload "$PLIST" 2>/dev/null || true
        launchctl load "$PLIST"
        echo "started. logs: $LOG_DIR/daemon.{out,err}.log"
        ;;
    stop)
        [[ -f "$PLIST" ]] && launchctl unload "$PLIST" && echo "stopped." || echo "not installed."
        ;;
    remove)
        [[ -f "$PLIST" ]] && launchctl unload "$PLIST" 2>/dev/null || true
        rm -f "$PLIST"
        echo "removed $PLIST (config and data untouched)."
        ;;
    status)
        launchctl list | grep "$LABEL" || echo "not running."
        ;;
    *)
        echo "usage: $0 {start|stop|remove|status} [config-path]" >&2
        exit 1
        ;;
esac

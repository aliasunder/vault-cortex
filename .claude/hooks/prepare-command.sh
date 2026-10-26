#!/usr/bin/env bash
# Repository command callers send the checkout and a non-SessionStart event
# as JSON on stdin. Only the selected physical Node bin goes to stdout.
set -euo pipefail

case "${1:-}" in
  environment) installer_operation=--node-bin ;;
  prepare) installer_operation=--prepare-node-bin ;;
  *) echo "[prepare-command] expected environment or prepare" >&2; exit 2 ;;
esac

hook_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${hook_directory}/install-deps.sh" "${installer_operation}"

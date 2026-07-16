#!/bin/zsh

SCRIPT_DIR="${0:A:h}"
cd "$SCRIPT_DIR" || exit 1

if [[ -x "$SCRIPT_DIR/LuminousQuest" ]]; then
  exec "$SCRIPT_DIR/LuminousQuest" "$@"
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[startup] pnpm is required when running from source."
  echo "Press Return to close."
  read -r
  exit 1
fi

pnpm start -- "$@"
STATUS=$?
if [[ $STATUS -ne 0 ]]; then
  echo "[startup] LuminousQuest exited with status $STATUS."
  echo "Press Return to close."
  read -r
fi
exit $STATUS

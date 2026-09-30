#!/usr/bin/env bash
# Copies pi-notes-daemon.py into iTerm2's AutoLaunch scripts directory.
# Handles both the default AppSupport location and a customized one
# (e.g. ~/.config/iterm2/AppSupport when NoSyncConfigDirectory is set).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)/iterm2/pi-notes-daemon.py"
TARGETS=(
  "$HOME/Library/Application Support/iTerm2/Scripts/AutoLaunch"
)

if [ -d "$HOME/.config/iterm2/AppSupport" ]; then
  TARGETS+=("$HOME/.config/iterm2/AppSupport/Scripts/AutoLaunch")
fi

for dir in "${TARGETS[@]}"; do
  mkdir -p "$dir"
  cp "$SRC" "$dir/"
  echo "installed: $dir/pi-notes-daemon.py"
done

echo
echo "Remaining steps (GUI-only):"
echo "  1. iTerm2 Settings > General > Magic > Enable Python API"
echo "  2. Settings > Keys > Key Bindings > + > Action 'Invoke Script Function' > save_selection_to_pi_notes()"
echo "  3. Restart iTerm2"

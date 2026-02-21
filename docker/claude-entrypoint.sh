#!/bin/bash
# Restore .claude.json from backup if it doesn't exist.
# The volume persists ~/.claude/ but the config lives at ~/.claude.json (outside the volume).
# Claude Code creates backups inside ~/.claude/backups/ which ARE persisted.

CONFIG="$HOME/.claude.json"
BACKUP_DIR="$HOME/.claude/backups"

if [ ! -f "$CONFIG" ] && [ -d "$BACKUP_DIR" ]; then
  LATEST=$(ls -t "$BACKUP_DIR"/.claude.json.backup.* 2>/dev/null | head -1)
  if [ -n "$LATEST" ]; then
    cp "$LATEST" "$CONFIG"
    echo "Restored $CONFIG from $LATEST"
  fi
fi

exec "$@"

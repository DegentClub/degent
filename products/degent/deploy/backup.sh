#!/bin/sh
# degent-mint backup: sqlite online backup (.backup, consistent under WAL while the service runs) plus the
# content-addressed blob directory (immutable files, copied without overwriting). docs/DEPLOY.md "Backups".
#
#   degent-mint-backup            one backup now
#   degent-mint-backup --loop     every BACKUP_INTERVAL_SECONDS (compose `mint-backup` service)
#   degent-mint-backup --check    exit 0 if the newest backup is younger than 2 intervals (HEALTHCHECK)
#   degent-mint-backup --restore <mint-YYYYmmddTHHMMSSZ.db.gz[.age]> <target.db>   restore drill / recovery
#
# The database holds half-signed reveals encrypted with REVEAL_ENCRYPTION_KEY, recipient addresses, notification
# e-mail addresses / Telegram chat ids and votes. Never store the reveal key next to the backups.
#   - Every file and directory is created private (umask 077).
#   - BACKUP_AGE_RECIPIENT (age public key(s), space-separated; required on mainnet): database snapshots are
#     encrypted with age before they are written (mint-<ts>.db.gz.age); no plaintext snapshot is kept.
#     Restore with BACKUP_AGE_IDENTITY=<age identity file>. Content blobs (the artworks, public once
#     inscribed) are copied as private files, not encrypted.
set -eu
umask 077

DB="${DATABASE_PATH:-/var/lib/degent-mint/mint.db}"
CONTENT="${CONTENT_DIR:-/var/lib/degent-mint/content}"
OUT="${BACKUP_DIR:-/backups}"
KEEP="${BACKUP_KEEP:-48}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-3600}"
RECIPIENTS="${BACKUP_AGE_RECIPIENT:-}"

log() { printf '{"time":"%s","level":"%s","service":"degent-mint-backup","msg":"%s"%s}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "${3:-}"; }

backup_once() {
  mkdir -p "$OUT/content"
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  tmp="$OUT/.mint-$ts.db"
  sqlite3 "$DB" ".timeout 10000" ".backup '$tmp'"
  if [ "$(sqlite3 "$tmp" 'PRAGMA integrity_check;')" != "ok" ]; then
    rm -f "$tmp"
    log error "backup failed" ',"reason":"integrity_check"'
    return 1
  fi
  orders="$(sqlite3 "$tmp" 'SELECT count(*) FROM orders;')"
  if [ -n "$RECIPIENTS" ]; then
    args=""
    for r in $RECIPIENTS; do args="$args -r $r"; done
    # shellcheck disable=SC2086 # one -r per recipient
    if ! gzip -9 -c "$tmp" | age $args -o "$tmp.gz.age"; then
      rm -f "$tmp" "$tmp.gz.age"
      log error "backup failed" ',"reason":"encryption"'
      return 1
    fi
    rm -f "$tmp"
    mv "$tmp.gz.age" "$OUT/mint-$ts.db.gz.age"
    file="mint-$ts.db.gz.age"
  else
    gzip -9 "$tmp"
    mv "$tmp.gz" "$OUT/mint-$ts.db.gz"
    file="mint-$ts.db.gz"
  fi
  # Content blobs are write-once (<dir>/<aa>/<sha256>): copy new ones only.
  if [ -d "$CONTENT" ]; then
    (cd "$CONTENT" && find . -type f) | while read -r f; do
      [ -e "$OUT/content/$f" ] && continue
      mkdir -p "$(dirname "$OUT/content/$f")"
      cp "$CONTENT/$f" "$OUT/content/$f.tmp" && mv "$OUT/content/$f.tmp" "$OUT/content/$f"
    done
  fi
  # Retention: keep the newest $KEEP database snapshots (plain or encrypted).
  ls -1t "$OUT"/mint-*.db.gz "$OUT"/mint-*.db.gz.age 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f "$old"; done
  log info "backup completed" ",\"file\":\"$file\",\"orders\":$orders"
}

check() {
  newest="$(ls -1t "$OUT"/mint-*.db.gz "$OUT"/mint-*.db.gz.age 2>/dev/null | head -n 1 || true)"
  [ -n "$newest" ] || { echo "no backup yet"; exit 1; }
  age=$(( $(date +%s) - $(date -r "$newest" +%s) ))
  [ "$age" -le $((INTERVAL * 2)) ] || { echo "newest backup is ${age}s old"; exit 1; }
  echo "ok: $newest (${age}s)"
}

restore() {
  src="$1"; dst="$2"
  [ -e "$dst" ] && { echo "refusing to overwrite $dst (stop the service and move it away first)"; exit 1; }
  case "$src" in
    *.age)
      [ -n "${BACKUP_AGE_IDENTITY:-}" ] || { echo "set BACKUP_AGE_IDENTITY to the age identity file for $src"; exit 1; }
      age -d -i "$BACKUP_AGE_IDENTITY" "$src" | gunzip -c > "$dst.tmp" ;;
    *) gunzip -c "$src" > "$dst.tmp" ;;
  esac
  [ "$(sqlite3 "$dst.tmp" 'PRAGMA integrity_check;')" = "ok" ] || { rm -f "$dst.tmp"; echo "integrity check failed"; exit 1; }
  mv "$dst.tmp" "$dst"
  echo "restored $src -> $dst ($(sqlite3 "$dst" 'SELECT count(*) FROM orders;') orders); copy $OUT/content back to CONTENT_DIR too"
}

case "${1:-}" in
  --loop) while :; do backup_once || true; sleep "$INTERVAL"; done ;;
  --check) check ;;
  --restore) [ $# -eq 3 ] || { echo "usage: $0 --restore <backup.db.gz[.age]> <target.db>"; exit 2; }; restore "$2" "$3" ;;
  "") backup_once ;;
  *) echo "usage: $0 [--loop|--check|--restore <backup.db.gz[.age]> <target.db>]"; exit 2 ;;
esac

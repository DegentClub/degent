#!/usr/bin/env bash
# degent.club server deploy entry point (docs/SERVER.md). bootstrap.sh installs it as /opt/degent/bin/deploy.sh
# (root-owned, 0755); the deploy workflow re-installs it from the commit it deploys and runs it with sudo:
#
#   sudo /opt/degent/bin/deploy.sh deploy <sha|tag> [both|mainnet|signet]   pull ghcr.io/degentclub/degent-*:<tag>,
#                                                        compose up, wait for health, roll back on failure
#   sudo /opt/degent/bin/deploy.sh rollback [both|mainnet|signet]            back to the previous tag
#   sudo /opt/degent/bin/deploy.sh status                                    JSON: tags, containers, API health
#   sudo /opt/degent/bin/deploy.sh logs <service> [lines]                    logs of one allow-listed service
#
# Hardened option (docs/SERVER.md): bound as the forced command of a key-only `deploy` SSH key, the same grammar is
# read from SSH_ORIGINAL_COMMAND. Either way the command line is validated strictly before anything runs.
# Every command prints ONE JSON result line on stdout (logs excepted); progress goes to stderr.
# shellcheck disable=SC2016 # single-quoted strings are jq programs: $names are jq variables
set -euo pipefail
set -f # no globbing of anything that came from the client
umask 077

DEGENT_HOME="${DEGENT_HOME:-/opt/degent}"
ENV_FILE="$DEGENT_HOME/compose/.env"
STATE="$DEGENT_HOME/state"
RELEASES="$DEGENT_HOME/releases"
REGISTRY="ghcr.io/degentclub"
PROJECT="degent"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-240}"
HEALTH_INTERVAL="${HEALTH_INTERVAL:-5}"

# ---------------------------------------------------------------------------------------------------- grammar
TAG_RE='^([0-9a-f]{7,40}|v[0-9]+(\.[0-9]+){0,2}(-[0-9A-Za-z.]{1,32})?)$'
TARGET_RE='^(both|mainnet|signet)$'
SERVICE_RE='^(caddy|web-mainnet|mint-mainnet-api|mint-mainnet-worker|web-signet|mint-signet-api|mint-signet-worker)$'
LINES_RE='^[0-9]{1,4}$'
MODE_RE='^(full|readonly)$'

log() { printf '%s deploy.sh: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
emit() { jq -cn "$@"; }

fail() {
  local action="$1" message="$2" code="${3:-1}"
  emit --arg action "$action" --arg error "$message" '{ok:false, action:$action, error:$error}'
  exit "$code"
}

usage() {
  fail "usage" "allowed: deploy <sha|tag> [both|mainnet|signet] | rollback [both|mainnet|signet] | status | logs <service> [lines]" 2
}

# ------------------------------------------------------------------------------------------------ env + state
env_get() { # value of KEY in the .env (never sourced: it is data, not code)
  [ -f "$ENV_FILE" ] || return 0
  grep -E "^$1=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

state_get() { if [ -f "$STATE/$1" ]; then cat "$STATE/$1"; fi; }
state_set() { printf '%s\n' "$2" > "$STATE/$1.tmp" && mv "$STATE/$1.tmp" "$STATE/$1"; }

image() { printf '%s/degent-%s:%s' "$REGISTRY" "$1" "$2"; }

compose_in() { # compose_in <release dir> <args...>
  local rel="$1"; shift
  docker compose --project-name "$PROJECT" --project-directory "$rel" -f "$rel/compose.server.yaml" --env-file "$ENV_FILE" "$@"
}

# Sets REL to the release directory of the last successful deploy (fails, printing JSON, when there is none).
require_release() {
  local r
  r="$(state_get release)"
  [ -n "$r" ] && [ -d "$RELEASES/$r" ] || fail "$1" "nothing deployed yet: run deploy <sha> first"
  REL="$RELEASES/$r"
}

mode_of() { # mode_of mainnet|signet -> full|readonly (from the .env; default readonly)
  local m
  m="$(env_get "$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')_MINT_MODE")"
  if [[ "$m" =~ $MODE_RE ]]; then printf '%s' "$m"; else printf 'readonly'; fi
}

# Export what compose interpolates for a pair of tags. Read-only networks run no worker (the service refuses one).
export_tags() {
  export MAINNET_TAG="$1" SIGNET_TAG="$2" DEGENT_HOME
  MAINNET_MINT_MODE="$(mode_of mainnet)"; SIGNET_MINT_MODE="$(mode_of signet)"
  export MAINNET_MINT_MODE SIGNET_MINT_MODE
  MAINNET_WORKERS=0; SIGNET_WORKERS=0
  if [ "$MAINNET_MINT_MODE" = full ]; then MAINNET_WORKERS=1; fi
  if [ "$SIGNET_MINT_MODE" = full ]; then SIGNET_WORKERS=1; fi
}

# Unpack the release bundle (compose.server.yaml + caddy/) that the mint image of <tag> carries at /app/deploy.
fetch_release() {
  local tag="$1" dir="$RELEASES/$1" cid
  if [ -f "$dir/compose.server.yaml" ]; then touch "$dir"; return 0; fi
  rm -rf "$dir.tmp"
  mkdir -p "$dir.tmp"
  cid="$(docker create "$(image mint "$tag")")"
  docker cp "$cid:/app/deploy/." "$dir.tmp/" >/dev/null
  docker rm -f "$cid" >/dev/null
  [ -f "$dir.tmp/compose.server.yaml" ] || { rm -rf "$dir.tmp"; fail deploy "image $(image mint "$tag") carries no /app/deploy/compose.server.yaml"; }
  chmod -R go-w "$dir.tmp"
  mv "$dir.tmp" "$dir"
}

services_for() { # services a deploy of <target> must see healthy
  local out=""
  case "$1" in
    mainnet|both) out="web-mainnet mint-mainnet-api"; if [ "$MAINNET_WORKERS" = 1 ]; then out="$out mint-mainnet-worker"; fi ;;
  esac
  case "$1" in
    signet|both) out="$out web-signet mint-signet-api"; if [ "$SIGNET_WORKERS" = 1 ]; then out="$out mint-signet-worker"; fi ;;
  esac
  printf '%s' "$out"
}

up() { # up <release dir>
  compose_in "$1" up -d --remove-orphans \
    --scale "mint-mainnet-worker=${MAINNET_WORKERS}" --scale "mint-signet-worker=${SIGNET_WORKERS}" >&2
}

# Wait until every service is healthy (or running, when its image has no HEALTHCHECK, e.g. caddy).
wait_healthy() {
  local rel="$1"; shift
  local deadline=$(( $(date +%s) + HEALTH_TIMEOUT )) svc cid st pending
  while :; do
    pending=""
    for svc in "$@"; do
      cid="$(compose_in "$rel" ps -q "$svc" 2>/dev/null | head -n 1 || true)"
      st=""
      [ -n "$cid" ] && st="$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)"
      case "$st" in healthy|running) ;; *) pending="$pending $svc:${st:-missing}" ;; esac
    done
    [ -z "$pending" ] && return 0
    if [ "$(date +%s)" -ge "$deadline" ]; then log "not healthy:$pending"; UNHEALTHY="${pending# }"; return 1; fi
    sleep "$HEALTH_INTERVAL"
  done
}

# GET /v1/health from inside a mint container (no mint port is published); prints the JSON body or null.
api_health() {
  local body
  body="$(compose_in "$1" exec -T "$2" node -e "fetch('http://127.0.0.1:8787/v1/health').then(r=>r.text()).then(t=>process.stdout.write(t),()=>process.stdout.write('null'))" 2>/dev/null || true)"
  printf '%s' "$body" | jq -c . 2>/dev/null || echo null
}

# Keep the 5 newest release bundles (a rollback to an older tag unpacks its bundle from the image again).
prune_releases() {
  local n=0 d
  while IFS= read -r d; do
    n=$((n + 1))
    [ "$n" -le 5 ] || rm -rf "${RELEASES:?}/${d:?}"
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d ! -name '*.tmp' -printf '%T@ %f\n' 2>/dev/null | sort -rn | cut -d' ' -f2)
}

# ------------------------------------------------------------------------------------------------- commands
do_deploy() {
  local tag="$1" target="$2" action="${3:-deploy}"
  local cur_m cur_s new_m new_s rel svcs img
  cur_m="$(state_get mainnet)"; cur_s="$(state_get signet)"
  new_m="$cur_m"; new_s="$cur_s"
  case "$target" in both) new_m="$tag"; new_s="$tag" ;; mainnet) new_m="$tag" ;; signet) new_s="$tag" ;; esac
  # First deploy of a single target: the other side starts on the same tag.
  [ -n "$new_m" ] || new_m="$tag"
  [ -n "$new_s" ] || new_s="$tag"

  log "pulling $tag ($target)"
  for img in "$(image mint "$tag")" "$(image mint "$new_m")" "$(image web-mainnet "$new_m")" "$(image mint "$new_s")" "$(image web-signet "$new_s")"; do
    docker pull -q "$img" >&2 || fail "$action" "cannot pull $img (built by the deploy workflow? logged in to ghcr.io or packages public?)"
  done
  fetch_release "$tag"
  rel="$RELEASES/$tag"
  export_tags "$new_m" "$new_s"
  compose_in "$rel" pull -q caddy >&2 || fail "$action" "cannot pull the caddy image"

  log "compose up (mainnet $new_m $MAINNET_MINT_MODE, signet $new_s $SIGNET_MINT_MODE)"
  svcs="caddy $(services_for "$target")"
  # shellcheck disable=SC2086 # word splitting of the service list is intended
  if up "$rel" && wait_healthy "$rel" $svcs; then
    state_set mainnet.prev "$cur_m"; state_set signet.prev "$cur_s"
    state_set mainnet "$new_m"; state_set signet "$new_s"; state_set release "$tag"
    prune_releases
    emit --arg action "$action" --arg tag "$tag" --arg target "$target" --arg m "$new_m" --arg s "$new_s" \
      --arg mm "$MAINNET_MINT_MODE" --arg sm "$SIGNET_MINT_MODE" \
      --argjson mainnet "$(api_health "$rel" mint-mainnet-api)" --argjson signet "$(api_health "$rel" mint-signet-api)" \
      '{ok:true, action:$action, tag:$tag, target:$target, tags:{mainnet:$m, signet:$s}, modes:{mainnet:$mm, signet:$sm},
        health:{mainnet:$mainnet, signet:$signet}}'
    return 0
  fi

  # Roll back to what ran before (if anything did).
  local unhealthy="${UNHEALTHY:-compose up failed}" prev_rel fail_logs
  # Capture the failing containers' own output so a health failure is diagnosable from the workflow log
  # (we cannot SSH in interactively). Bounded so the JSON result stays small.
  fail_logs="$( { compose_in "$rel" logs --no-color --tail=20 mint-mainnet-api mint-signet-api web-mainnet web-signet caddy 2>&1; \
                  compose_in "$rel" ps --format 'table {{.Name}}\t{{.State}}\t{{.Status}}' 2>&1; } | tail -c 3500 || true)"
  prev_rel="$(state_get release)"
  if [ -n "$cur_m" ] && [ -n "$cur_s" ] && [ -n "$prev_rel" ] && [ -d "$RELEASES/$prev_rel" ]; then
    log "rolling back to mainnet $cur_m, signet $cur_s"
    export_tags "$cur_m" "$cur_s"
    # shellcheck disable=SC2046 # word splitting of the service list is intended
    if up "$RELEASES/$prev_rel" && wait_healthy "$RELEASES/$prev_rel" caddy $(services_for both); then
      emit --arg action "$action" --arg tag "$tag" --arg u "$unhealthy" --arg m "$cur_m" --arg s "$cur_s" --arg logs "$fail_logs" \
        '{ok:false, action:$action, tag:$tag, error:("not healthy: " + $u), rolledBack:true, tags:{mainnet:$m, signet:$s}, logs:$logs}'
    else
      emit --arg action "$action" --arg tag "$tag" --arg u "$unhealthy" --arg logs "$fail_logs" \
        '{ok:false, action:$action, tag:$tag, error:("not healthy: " + $u), rolledBack:false, rollbackFailed:true, logs:$logs}'
    fi
  else
    emit --arg action "$action" --arg tag "$tag" --arg u "$unhealthy" --arg logs "$fail_logs" \
      '{ok:false, action:$action, tag:$tag, error:("not healthy: " + $u), rolledBack:false, reason:"no previous release", logs:$logs}'
  fi
  exit 1
}

do_rollback() {
  local target="$1" pm ps
  pm="$(state_get mainnet.prev)"; ps="$(state_get signet.prev)"
  case "$target" in
    mainnet) [ -n "$pm" ] || fail rollback "no previous mainnet tag"; do_deploy "$pm" mainnet rollback ;;
    signet) [ -n "$ps" ] || fail rollback "no previous signet tag"; do_deploy "$ps" signet rollback ;;
    both)
      [ -n "$pm" ] && [ -n "$ps" ] || fail rollback "no previous tags"
      [ "$pm" = "$ps" ] || fail rollback "previous tags differ (mainnet $pm, signet $ps): roll back each target separately"
      do_deploy "$pm" both rollback ;;
  esac
}

do_status() {
  local ps
  require_release status
  export_tags "$(state_get mainnet)" "$(state_get signet)"
  ps="$(compose_in "$REL" ps -a --format json 2>/dev/null || echo '[]')"
  # Compose prints either one JSON array or one object per line, depending on its version.
  case "$ps" in "["*) ;; *) ps="$(printf '%s\n' "$ps" | jq -cs .)" ;; esac
  emit --arg m "$(state_get mainnet)" --arg s "$(state_get signet)" --arg pm "$(state_get mainnet.prev)" --arg psv "$(state_get signet.prev)" \
    --arg mm "$MAINNET_MINT_MODE" --arg sm "$SIGNET_MINT_MODE" --argjson containers "$ps" \
    --argjson mainnet "$(api_health "$REL" mint-mainnet-api)" --argjson signet "$(api_health "$REL" mint-signet-api)" \
    '{ok:true, action:"status", tags:{mainnet:$m, signet:$s}, previous:{mainnet:$pm, signet:$psv}, modes:{mainnet:$mm, signet:$sm},
      containers:[$containers[] | {service:.Service, state:.State, health:(.Health // ""), image:.Image, status:.Status}],
      health:{mainnet:$mainnet, signet:$signet}}'
}

do_logs() {
  require_release logs
  export_tags "$(state_get mainnet)" "$(state_get signet)"
  compose_in "$REL" logs --no-color --tail "$2" "$1"
}

# ------------------------------------------------------------------------------------------------- dispatch
main() {
  local cmd target
  if [ -n "${SSH_ORIGINAL_COMMAND+x}" ]; then cmd="$SSH_ORIGINAL_COMMAND"; else cmd="$*"; fi
  # Whole-line allow-list before any word is looked at: at most three simple words separated by single spaces.
  [ ${#cmd} -le 200 ] && [[ "$cmd" =~ ^[A-Za-z0-9._:-]+( [A-Za-z0-9._:-]+){0,2}$ ]] || usage
  local -a w
  read -r -a w <<< "$cmd"
  command -v jq >/dev/null || { echo '{"ok":false,"error":"jq missing: run bootstrap.sh"}'; exit 1; }
  mkdir -p "$STATE" "$RELEASES"

  case "${w[0]}" in
    deploy|rollback)
      exec 9> "$STATE/.lock"
      flock -n 9 || fail "${w[0]}" "another deploy is running" ;;
  esac

  case "${w[0]}" in
    deploy)
      [ ${#w[@]} -ge 2 ] && [[ "${w[1]}" =~ $TAG_RE ]] || usage
      target="${w[2]:-both}"
      [[ "$target" =~ $TARGET_RE ]] || usage
      do_deploy "${w[1]}" "$target" ;;
    rollback)
      target="${w[1]:-both}"
      [ ${#w[@]} -le 2 ] && [[ "$target" =~ $TARGET_RE ]] || usage
      do_rollback "$target" ;;
    status) [ ${#w[@]} -eq 1 ] || usage; do_status ;;
    logs)
      [ ${#w[@]} -ge 2 ] && [[ "${w[1]}" =~ $SERVICE_RE ]] || usage
      local lines="${w[2]:-200}"
      [[ "$lines" =~ $LINES_RE ]] || usage
      do_logs "${w[1]}" "$lines" ;;
    *) usage ;;
  esac
}

main "$@"

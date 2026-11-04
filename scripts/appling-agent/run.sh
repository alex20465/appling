#!/usr/bin/env bash
# Starts one headless run of the appling-maintainer agent (.claude/agents/appling-maintainer.md).
# Install with cron, twice a day:
#   0 3,18 * * * /path/to/appling/scripts/appling-agent/run.sh
# Environment (all optional):
#   APPLING_AGENT_HOME      state, research, inbox, logs and the clone (default ~/.local/share/appling-agent)
#   APPLING_AGENT_REPO      repository to clone (default alex20465/appling)
#   APPLING_AGENT_WORKTREE  the maintainer's working copy to keep on the latest main
#   APPLING_AGENT_NOTIFY    Telegram notify script (default ~/.claude/skills/telegram-notify/notify.sh)
#   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_STATE_DIR  as for the notify script
set -euo pipefail

export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

home="${APPLING_AGENT_HOME:-$HOME/.local/share/appling-agent}"
repo="${APPLING_AGENT_REPO:-alex20465/appling}"
worktree="${APPLING_AGENT_WORKTREE:-}"
notify="${APPLING_AGENT_NOTIFY:-$HOME/.claude/skills/telegram-notify/notify.sh}"
tg="${TELEGRAM_STATE_DIR:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/channels/telegram}"
clone="$home/repo"
state="$home/state.json"
research="$home/research"
inbox="$home/inbox.jsonl"
logs="$home/logs"

mkdir -p "$home" "$research" "$logs"
[ -f "$state" ] || echo '{}' >"$state"

# One run at a time; a run that overlaps the next cron slot skips it.
exec 9>"$home/run.lock"
flock -n 9 || { echo "another run is active" >&2; exit 0; }

log="$logs/$(date +%Y%m%dT%H%M%S).log"
exec > >(tee -a "$log") 2>&1
find "$logs" -name '*.log' -mtime +30 -delete

fail() {
  echo "$1" >&2
  if [ -x "$notify" ]; then "$notify" "❌ Appling agent: $1 (log: $log)" || true; fi
  exit 1
}

# corepack runs the pinned pnpm; without it (Node 25+) the global pnpm must be that version.
if command -v corepack >/dev/null; then pnpm=(corepack pnpm); else pnpm=(pnpm); fi

# Clean clone on the latest main.
if [ ! -d "$clone/.git" ]; then
  gh repo clone "$repo" "$clone" || fail "cannot clone $repo"
fi
git -C "$clone" fetch --prune origin || fail "git fetch failed"
git -C "$clone" checkout -q -f main
git -C "$clone" reset -q --hard origin/main
git -C "$clone" clean -q -fd
(cd "$clone" && "${pnpm[@]}" install --frozen-lockfile) || fail "pnpm install failed"

# The maintainer's working copy follows main unless it holds work of its own.
wt_status="none configured (APPLING_AGENT_WORKTREE)"
if [ -n "$worktree" ]; then
  if [ ! -d "$worktree" ]; then
    wt_status="$worktree is missing"
  elif ! git -C "$worktree" fetch -q origin; then
    wt_status="$worktree: fetch failed"
  else
    branch="$(git -C "$worktree" rev-parse --abbrev-ref HEAD)"
    behind="$(git -C "$worktree" rev-list --count HEAD..origin/main)"
    if [ -n "$(git -C "$worktree" status --porcelain)" ]; then
      wt_status="$branch left alone (dirty), $behind commits behind origin/main"
    elif [ "$behind" = 0 ]; then
      wt_status="$branch up to date with origin/main"
    elif [ "$branch" != main ] && git -C "$worktree" rev-parse -q --verify '@{upstream}' >/dev/null; then
      wt_status="$branch left alone (pushed), $behind commits behind origin/main"
    elif git -C "$worktree" rebase -q origin/main; then
      wt_status="$branch rebased onto origin/main ($behind new commits)"
    else
      git -C "$worktree" rebase --abort
      wt_status="$branch left alone (conflicting), $behind commits behind origin/main"
    fi
  fi
fi

# Telegram inbox: messages of the maintainer's chat since the last run, one JSON line each.
token="${TELEGRAM_BOT_TOKEN:-}"
if [ -z "$token" ] && [ -f "$tg/.env" ]; then
  token="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' "$tg/.env" | tr -d "\"'")"
fi
chat="${TELEGRAM_CHAT_ID:-}"
if [ -z "$chat" ] && [ -f "$tg/access.json" ]; then
  chat="$(jq -r '.allowFrom[0] // empty' "$tg/access.json")"
fi
inbox_status="not polled (no Telegram bot token or chat id)"
if [ -n "$token" ] && [ -n "$chat" ]; then
  offset="$(jq -r '.telegram_offset // 0' "$state")"
  if updates="$(curl -fsS "https://api.telegram.org/bot$token/getUpdates?offset=$offset&timeout=0")"; then
    new="$(printf '%s' "$updates" | jq -c --arg chat "$chat" \
      '.result[] | .message // empty | select((.chat.id | tostring) == $chat and .text != null) | {date: (.date | todate), text}')"
    count=0
    if [ -n "$new" ]; then
      printf '%s\n' "$new" >>"$inbox"
      count="$(printf '%s\n' "$new" | wc -l)"
    fi
    next="$(printf '%s' "$updates" | jq '[.result[].update_id] | max // empty | . + 1')"
    if [ -n "$next" ]; then
      jq --argjson o "$next" '.telegram_offset = $o' "$state" >"$state.tmp" && mv "$state.tmp" "$state"
    fi
    inbox_status="$count new messages since the last run (the last $count lines)"
  else
    inbox_status="polling failed, read only older messages"
  fi
fi
touch "$inbox"

daily=no
if [ "$((10#$(date +%H)))" -ge 18 ] && [ "$(jq -r '.last_daily // ""' "$state")" != "$(date +%F)" ]; then
  daily=yes
fi

context="## This run

- Time: $(date '+%F %H:%M %Z')
- Daily check due: $daily
- State file: $state
- Research folder: $research
- Telegram inbox: $inbox ($inbox_status)
- Telegram notify: $notify
- pnpm: \`${pnpm[*]}\` (use it wherever this prompt says \`corepack pnpm\`)
- Maintainer's working copy: ${worktree:-none}: $wt_status"

allowed=(
  Read Write Edit Glob Grep Skill TodoWrite WebSearch WebFetch Agent
  "Bash(git *)" "Bash(gh *)" "Bash(${pnpm[*]} *)" "Bash(node *)"
  "Bash(npm whoami)" "Bash(npm view *)" "Bash($notify *)"
  "Bash(jq *)" "Bash(cat *)" "Bash(ls *)" "Bash(date *)" "Bash(wc *)" "Bash(head *)" "Bash(tail *)"
)
denied=(
  "Bash(git push -f *)" "Bash(git push --force *)" "Bash(git push origin +*)"
  "Bash(gh pr merge * --admin*)" "Bash(gh repo delete *)" "Bash(gh repo edit *)"
  "Bash(gh secret *)" "Bash(gh variable *)" "Bash(gh api -X DELETE *)" "Bash(gh api --method DELETE *)"
)

cd "$clone"
printf '%s\n' "$context" | claude -p --agent appling-maintainer \
  --add-dir "$home" \
  --allowedTools "$(IFS=,; echo "${allowed[*]}")" \
  --disallowedTools "$(IFS=,; echo "${denied[*]}")" \
  || fail "claude exited with $?"

#!/usr/bin/env bash
set -Eeuo pipefail

# Codex 长任务守护脚本：
# - 面向“让 Codex 在无人值守时持续推进同一项任务”的业务场景。
# - 首次执行走 `codex exec`，后续统一走 `codex exec resume`，避免只靠终端抓屏判断状态。
# - 完成判定依赖一个随机完成协议，而不是依赖自然语言总结，降低误判为“已完成”的风险。
# - 默认优先绑定当前工作目录下最近一次会话；如果能从 JSON 事件里提取到 session id，会进一步缩小续跑目标。

CODEX_BIN=${CODEX_BIN:-codex}
WORKDIR=${WORKDIR:-$(pwd)}
STATE_DIR=${STATE_DIR:-}
INTERVAL=${INTERVAL:-3}
CONFIRM_TEXT=${CONFIRM_TEXT:-"CONFIRMED: all tasks completed"}
RESUME_TEXT_BASE=${RESUME_TEXT_BASE:-"You must respond to this message. Continue any unfinished user-requested work immediately from the current state. Do not restart. Do not summarize. Do not ask for confirmation. If all requested work is already complete, follow the completion protocol below."}
MODEL=${MODEL:-}
PROFILE=${PROFILE:-}
USE_FULL_AUTO=${USE_FULL_AUTO:-1}
DANGEROUSLY_BYPASS=${DANGEROUSLY_BYPASS:-0}
SKIP_GIT_REPO_CHECK=${SKIP_GIT_REPO_CHECK:-0}
START_WITH_RESUME_IF_POSSIBLE=${START_WITH_RESUME_IF_POSSIBLE:-1}

SESSION_ID=
NONCE=
DONE_TOKEN=
EVENT_LOG_FILE=
RUN_LOG_FILE=
LAST_MESSAGE_FILE=
SESSION_ID_FILE=
META_FILE=
INITIAL_PROMPT_FILE=
RESUME_PROMPT_FILE=
START_WITH_RESUME=0

# 对外暴露统一用法，方便把这个脚本接进 cron、tmux 或其他 supervisor。
usage() {
  printf 'Usage: %s <prompt_file | ->\n' "${0##*/}" >&2
  printf 'Example: %s ./prompt.md\n' "${0##*/}" >&2
  printf 'Example: cat ./prompt.md | WORKDIR=/repo %s -\n' "${0##*/}" >&2
  printf 'Env: WORKDIR=. INTERVAL=3 STATE_DIR=/tmp/codex-run MODEL=gpt-5 USE_FULL_AUTO=1\n' >&2
  printf 'Note: when SESSION_ID is unavailable, resume falls back to `codex exec resume --last` in WORKDIR.\n' >&2
  exit 1
}

# 守护脚本的日志只服务“值守与排障”，因此统一打到 stderr，避免污染 Codex 的结构化输出文件。
log() {
  printf '[%s] %s\n' "$(date '+%F %T')" "$*" >&2
}

# 致命错误统一经这里退出，保证人工值守时能直接看到“为什么这次没有继续跑”。
die() {
  log "ERROR: $*"
  exit 1
}

# 业务上只依赖“命令是否存在”，避免把运行前置校验散落在主流程里。
command_exists() {
  command -v "$1" >/dev/null 2>&1
}

# 状态目录保存本轮守护的事件、最后一条消息和完成协议元数据，便于长任务回放与续查。
prepare_state_dir() {
  if [[ -n "$STATE_DIR" ]]; then
    mkdir -p "$STATE_DIR"
  else
    STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/codex-run.XXXXXX")
  fi

  EVENT_LOG_FILE="$STATE_DIR/events.jsonl"
  RUN_LOG_FILE="$STATE_DIR/runner.log"
  LAST_MESSAGE_FILE="$STATE_DIR/last-message.txt"
  SESSION_ID_FILE="$STATE_DIR/session-id.txt"
  META_FILE="$STATE_DIR/meta.env"
  INITIAL_PROMPT_FILE="$STATE_DIR/initial-prompt.txt"
  RESUME_PROMPT_FILE="$STATE_DIR/resume-prompt.txt"
}

# 如果守护脚本自己重启了，优先恢复上一轮已经创建过的 Codex 会话，避免同一任务被重复起新会话。
load_previous_session_state() {
  local saved_session_id

  [[ "$START_WITH_RESUME_IF_POSSIBLE" == "1" ]] || return 0

  if [[ -f "$SESSION_ID_FILE" ]]; then
    saved_session_id=$(sed -n '1p' "$SESSION_ID_FILE" | tr -d '\r')
    if [[ -n "$saved_session_id" ]]; then
      SESSION_ID="$saved_session_id"
    fi
  fi

  if [[ -n "$SESSION_ID" || -f "$EVENT_LOG_FILE" ]]; then
    START_WITH_RESUME=1
  fi
}

# 初始任务通常来自单独的 prompt 文件或标准输入，这样外部系统可以稳定生成任务描述后再交给 Codex。
read_initial_prompt() {
  local prompt_source=$1
  local prompt_text

  if [[ "$prompt_source" == "-" ]]; then
    [[ -t 0 ]] && die "Prompt source is '-', but stdin is empty."
    prompt_text=$(cat)
  else
    [[ -f "$prompt_source" ]] || die "Prompt file does not exist: $prompt_source"
    prompt_text=$(cat "$prompt_source")
  fi

  [[ -n "$prompt_text" ]] || die "Initial prompt is empty."
  printf '%s' "$prompt_text"
}

# 随机 nonce 用于把“本轮真正完成”编码成一次性令牌，降低旧输出或自然语言撞词造成的误判。
generate_completion_nonce() {
  local raw_nonce nonce_group_1 nonce_group_2 nonce_group_3

  raw_nonce=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
  NONCE="${raw_nonce:0:4}-${raw_nonce:4:4}-${raw_nonce:8:4}"
  IFS='-' read -r nonce_group_1 nonce_group_2 nonce_group_3 <<<"$NONCE"
  DONE_TOKEN="$nonce_group_3-$nonce_group_2-$nonce_group_1"
}

# 初始提示和续跑提示都要复用同一套完成协议，避免不同轮次对“何时算完成”理解不一致。
completion_protocol_text() {
  printf 'When using the completion protocol, reply with EXACTLY two lines and nothing else: line 1 = same groups in reverse order for nonce `%s`; line 2 = `%s`.' "$NONCE" "$CONFIRM_TEXT"
}

# 首跑消息既要保留用户真实任务，也要补充“自动守护模式”的完成口令要求。
build_initial_prompt() {
  local base_prompt=$1

  printf '%s\n\n%s\n' "$base_prompt" "$(completion_protocol_text)"
}

# 续跑消息只负责把 Codex 拉回“继续干活或按协议收尾”这两种状态，避免每次 resume 都重放整份任务描述。
build_resume_prompt() {
  printf '%s %s\n' "$RESUME_TEXT_BASE" "$(completion_protocol_text)"
}

# 通过最后一条 assistant 消息精确判定是否真的完成，避免抓整段事件流导致误把中间输出当成完工。
completion_detected() {
  local line1 line2 line3

  [[ -f "$LAST_MESSAGE_FILE" ]] || return 1
  line1=$(sed -n '1p' "$LAST_MESSAGE_FILE" | tr -d '\r')
  line2=$(sed -n '2p' "$LAST_MESSAGE_FILE" | tr -d '\r')
  line3=$(sed -n '3p' "$LAST_MESSAGE_FILE" | tr -d '\r')

  [[ "$line1" == "$DONE_TOKEN" && "$line2" == "$CONFIRM_TEXT" && -z "$line3" ]]
}

# 长任务经常需要回看“第几轮 assistant 最后说了什么”，因此每轮都留一份快照，方便人工排障。
snapshot_last_message() {
  local attempt=$1
  local snapshot_file

  [[ -f "$LAST_MESSAGE_FILE" ]] || return 0
  snapshot_file=$(printf '%s/attempt-%04d.last.txt' "$STATE_DIR" "$attempt")
  cp "$LAST_MESSAGE_FILE" "$snapshot_file"
}

# 如果 Codex 的 JSON 事件里带了 session id，就保存下来，后续 resume 可以比 `--last` 更稳。
maybe_record_session_id() {
  local discovered_session_id

  [[ -n "$SESSION_ID" ]] && return 0
  [[ -f "$EVENT_LOG_FILE" ]] || return 0

  discovered_session_id=$(
    grep -Eo '"(session_id|conversation_id|thread_id)"[[:space:]]*:[[:space:]]*"[0-9a-fA-F-]{36}"' "$EVENT_LOG_FILE" \
      | tail -n 1 \
      | grep -Eo '[0-9a-fA-F-]{36}' \
      || true
  )

  if [[ -n "$discovered_session_id" ]]; then
    SESSION_ID="$discovered_session_id"
    printf '%s\n' "$SESSION_ID" > "$SESSION_ID_FILE"
    log "bound session id: $SESSION_ID"
  fi
}

# 把关键元信息落盘，便于脚本重启后人工快速知道这轮守护到底盯的是哪个工作目录和完成口令。
write_state_metadata() {
  {
    printf 'WORKDIR=%q\n' "$WORKDIR"
    printf 'STATE_DIR=%q\n' "$STATE_DIR"
    printf 'NONCE=%q\n' "$NONCE"
    printf 'DONE_TOKEN=%q\n' "$DONE_TOKEN"
    printf 'CONFIRM_TEXT=%q\n' "$CONFIRM_TEXT"
  } > "$META_FILE"
}

# 首跑负责创建新会话，因此这里统一挂上工作目录、自动执行策略和结构化输出文件。
run_initial_exec() {
  local prompt_payload=$1
  local exit_code
  local cmd=("$CODEX_BIN" "exec" "--json" "-o" "$LAST_MESSAGE_FILE")

  if [[ "$DANGEROUSLY_BYPASS" == "1" ]]; then
    cmd+=("--dangerously-bypass-approvals-and-sandbox")
  elif [[ "$USE_FULL_AUTO" == "1" ]]; then
    cmd+=("--full-auto")
  fi

  if [[ "$SKIP_GIT_REPO_CHECK" == "1" ]]; then
    cmd+=("--skip-git-repo-check")
  fi

  if [[ -n "$MODEL" ]]; then
    cmd+=("-m" "$MODEL")
  fi

  if [[ -n "$PROFILE" ]]; then
    cmd+=("--profile" "$PROFILE")
  fi

  cmd+=("-C" "$WORKDIR" "$prompt_payload")

  log "starting initial codex exec"
  if "${cmd[@]}" >>"$EVENT_LOG_FILE" 2>>"$RUN_LOG_FILE"; then
    return 0
  else
    exit_code=$?
  fi

  log "initial codex exec exited with code=$exit_code"
  return "$exit_code"
}

# 续跑只补一条“继续做”的消息，让 Codex 在同一会话上下文里接着推进，而不是重新起一轮新任务。
run_resume_exec() {
  local prompt_payload=$1
  local exit_code
  local cmd=("$CODEX_BIN" "exec" "resume" "--json" "-o" "$LAST_MESSAGE_FILE")

  if [[ "$DANGEROUSLY_BYPASS" == "1" ]]; then
    cmd+=("--dangerously-bypass-approvals-and-sandbox")
  elif [[ "$USE_FULL_AUTO" == "1" ]]; then
    cmd+=("--full-auto")
  fi

  if [[ -n "$MODEL" ]]; then
    cmd+=("-m" "$MODEL")
  fi

  if [[ -n "$PROFILE" ]]; then
    cmd+=("--profile" "$PROFILE")
  fi

  if [[ -n "$SESSION_ID" ]]; then
    cmd+=("$SESSION_ID")
  else
    cmd+=("--last")
  fi

  cmd+=("$prompt_payload")

  if [[ -n "$SESSION_ID" ]]; then
    log "resuming codex session id=$SESSION_ID"
  else
    log "resuming codex with --last in workdir=$WORKDIR"
  fi

  if (
    cd "$WORKDIR"
    "${cmd[@]}"
  ) >>"$EVENT_LOG_FILE" 2>>"$RUN_LOG_FILE"; then
    return 0
  else
    exit_code=$?
  fi

  log "codex resume exited with code=$exit_code"
  return "$exit_code"
}

# 主循环的业务目标只有一个：只要没有明确完成，就不断把 Codex 拉回到同一项工作上继续推进。
main() {
  local prompt_source=${1-}
  local initial_prompt
  local initial_prompt_payload
  local resume_prompt_payload
  local attempt=0
  local exit_code=0

  [[ $# -eq 1 ]] || usage
  command_exists "$CODEX_BIN" || die "Codex binary not found: $CODEX_BIN"
  [[ -d "$WORKDIR" ]] || die "WORKDIR does not exist: $WORKDIR"
  WORKDIR=$(cd "$WORKDIR" && pwd)

  prepare_state_dir
  load_previous_session_state
  generate_completion_nonce
  write_state_metadata

  initial_prompt=$(read_initial_prompt "$prompt_source")
  initial_prompt_payload=$(build_initial_prompt "$initial_prompt")
  resume_prompt_payload=$(build_resume_prompt)
  printf '%s\n' "$initial_prompt_payload" > "$INITIAL_PROMPT_FILE"
  printf '%s\n' "$resume_prompt_payload" > "$RESUME_PROMPT_FILE"

  log "state directory: $STATE_DIR"
  log "workdir: $WORKDIR"
  log "completion nonce: $NONCE"
  log "completion token: $DONE_TOKEN"

  while true; do
    attempt=$((attempt + 1))

    if (( attempt == 1 && START_WITH_RESUME == 0 )); then
      if run_initial_exec "$initial_prompt_payload"; then
        exit_code=0
      else
        exit_code=$?
      fi
    else
      if run_resume_exec "$resume_prompt_payload"; then
        exit_code=0
      else
        exit_code=$?
      fi
    fi

    snapshot_last_message "$attempt"
    maybe_record_session_id

    if completion_detected; then
      log "completion protocol detected; stopping supervisor"
      exit 0
    fi

    log "attempt=$attempt finished with code=$exit_code without completion protocol; sleeping ${INTERVAL}s"
    sleep "$INTERVAL"
  done
}

main "$@"

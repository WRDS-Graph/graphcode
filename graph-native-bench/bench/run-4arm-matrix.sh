#!/usr/bin/env bash
# 4-arm robustness matrix on the Claude subscription (no API key).
#
# Arms (all run via `claude -p`, same gateway, differing only in harness wiring):
#   control                  — plain agent, no graph
#   codegraph                — agent + codegraph MCP (graph-as-a-tool)
#   graphcode-native-claude  — graph-native harness (turn-0 v2-ranked injection +
#                              graph-first prompt), re-homed onto claude (this work)
#
# Usage:
#   bash run-4arm-matrix.sh "I1 I8 I6 I10" "control codegraph graphcode-native-claude" 3
#     args: <task ids> <arms> <runs-per-cell> [start-run-number]
#
# Resumable: skips a cell whose r<N>.jsonl already exists with status finished.

set -uo pipefail

EVAL="/Users/eric/Documents/codegraph/hadoop-mcp-eval"
CG="/Users/eric/Documents/graphcode/codegraph/dist/bin/codegraph.js"
TASKS="${1:-I1 I8 I6 I10}"
ARMS="${2:-control codegraph graphcode-native-claude}"
RUNS="${3:-3}"
START="${4:-101}"   # run numbers 101+ to not collide with existing r1..r7

export GRAPHCODE_CODEGRAPH_BIN="$CG"
export GRAPHCODE_AUTOCONTEXT=1

cell_done() {
  # $1=task $2=arm $3=runnum — finished if jsonl exists and run_complete status=finished
  local f="$EVAL/outputs/agent-runs/sonnet-4.6/$1/$2/r$3.jsonl"
  [ -f "$f" ] || return 1
  grep -q '"type":"run_complete"' "$f" 2>/dev/null && grep -q '"status":"finished"' "$f" 2>/dev/null
}

runner_for() {
  case "$1" in
    graphcode-native-claude) echo "graphcode-claude" ;;
    *) echo "claude" ;;
  esac
}

total=0; ok=0; fail=0
for t in $TASKS; do
  for arm in $ARMS; do
    runner=$(runner_for "$arm")
    for i in $(seq 0 $((RUNS-1))); do
      rn=$((START+i))
      total=$((total+1))
      if cell_done "$t" "$arm" "$rn"; then
        echo "[skip] $t/$arm/r$rn (already finished)"; ok=$((ok+1)); continue
      fi
      echo "[run ] $t/$arm/r$rn  (runner=$runner)  $(date +%T)"
      timeout 600 node "$EVAL/scripts/run-flow-agent.mjs" \
        --task "$t" --arm "$arm" --runner "$runner" \
        --model sonnet-4.6 --run "$rn" \
        --tasks-file tasks/pr-derived-tasks.yaml \
        >/dev/null 2>"$EVAL/outputs/agent-runs/sonnet-4.6/.last-$t-$arm-r$rn.err"
      rc=$?
      if cell_done "$t" "$arm" "$rn"; then
        echo "       -> ok $(date +%T)"; ok=$((ok+1))
      else
        echo "       -> FAIL rc=$rc $(date +%T) (see .last-$t-$arm-r$rn.err)"; fail=$((fail+1))
      fi
    done
  done
done
echo "MATRIX DONE: total=$total ok=$ok fail=$fail  $(date +%T)"

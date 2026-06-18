#!/usr/bin/env bash
# Run the graphcode-native arm (v2 ranker wiring) across the held-out impact tasks.
# Each run is independent; we run them sequentially-with-a-cap to avoid hammering the
# provider. Writes r7.jsonl (v2) alongside the existing r5/r6 (v1) so they're comparable.
#
#   bash run-native-v2-matrix.sh I6 I8 I9 I10        # subset
#   bash run-native-v2-matrix.sh                      # full held-out set
set -u
cd /Users/eric/Documents/codegraph/hadoop-mcp-eval || exit 1

RUN="${RUN:-7}"
TASKS=("$@")
if [ ${#TASKS[@]} -eq 0 ]; then
  TASKS=(I1 I4 I6 I8 I9 I10 I13 I14)   # held-out, dedup'd (I5,I7 dropped per manifest)
fi

echo "== graphcode-native v2 matrix: tasks=[${TASKS[*]}] run=r${RUN} =="
for t in "${TASKS[@]}"; do
  echo "--- $t (r${RUN}) ---"
  GRAPHCODE_AUTOCONTEXT=1 timeout 600 node scripts/run-flow-agent.mjs \
    --task "$t" --arm graphcode-native --runner graphcode \
    --model sonnet-4.6 --run "$RUN" \
    --tasks-file tasks/pr-derived-tasks.yaml 2>&1 | tail -3
done
echo "== matrix complete =="

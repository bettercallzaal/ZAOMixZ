#!/usr/bin/env bash
# Run every offline test: web/dj/*.test.mjs and pipeline/feedback_api.test.cjs.
# A file fails if it exits non-zero OR never prints its summary line ("N passed, M failed"
# or "all passed"), so a test that crashes before it reports cannot pass by saying nothing.
# The pipeline/test_*_live.mjs files call live services and are not run here.
set -u
cd "$(dirname "$0")/.."
files=(web/dj/*.test.mjs pipeline/feedback_api.test.cjs)
ran=0; bad=0
for f in "${files[@]}"; do
  ran=$((ran + 1))
  out=$(node "$f" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then
    bad=$((bad + 1)); echo "FAIL  $f (exit $rc)"; echo "$out" | grep -E '^  (FAIL|not ok)|^FAIL|Error' | head -5
  elif ! echo "$out" | grep -qE '[0-9]+ passed|all passed'; then
    bad=$((bad + 1)); echo "FAIL  $f (no summary line)"
  else
    echo "ok    $f  $(echo "$out" | grep -E '[0-9]+ passed|all passed' | tail -1)"
  fi
done
echo
echo "$ran files, $bad failing"
[ "$ran" -gt 0 ] || { echo "no test files found"; exit 2; }
[ "$bad" -eq 0 ]

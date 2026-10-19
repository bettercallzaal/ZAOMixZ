#!/usr/bin/env bash
# Run every offline test: web/dj/*.test.mjs and pipeline/feedback_api.test.cjs.
# A file fails if it exits non-zero, never prints its summary line ("N passed, M failed" or
# "all passed"), or prints one with failures: a test that crashes before it reports, or that
# exits 0 by mistake after a failure, cannot pass.
# The pipeline/test_*_live.mjs files call live services and are not run here.
set -u
shopt -s nullglob
cd "$(dirname "$0")/.."
files=(web/dj/*.test.mjs pipeline/feedback_api.test.cjs)
[ -f pipeline/feedback_api.test.cjs ] || files=("${files[@]:0:${#files[@]}-1}")
[ "${#files[@]}" -gt 0 ] || { echo "no test files found"; exit 2; }
ran=0; bad=0
for f in "${files[@]}"; do
  ran=$((ran + 1))
  out=$(node "$f" 2>&1); rc=$?
  if [ $rc -ne 0 ]; then
    bad=$((bad + 1)); echo "FAIL  $f (exit $rc)"; echo "$out" | grep -E '^  (FAIL|not ok)|^FAIL|Error' | head -5
  elif ! echo "$out" | grep -qE '[0-9]+ passed|all passed'; then
    bad=$((bad + 1)); echo "FAIL  $f (no summary line)"
  elif echo "$out" | grep -E '[0-9]+ passed, [0-9]+ failed' | tail -1 | grep -qvE ', 0 failed'; then
    bad=$((bad + 1)); echo "FAIL  $f (summary reports failures: $(echo "$out" | grep -E '[0-9]+ passed, [0-9]+ failed' | tail -1))"
  else
    echo "ok    $f  $(echo "$out" | grep -E '[0-9]+ passed|all passed' | tail -1)"
  fi
done
echo
echo "$ran files, $bad failing"
[ "$bad" -eq 0 ]

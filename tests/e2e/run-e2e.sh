#!/bin/bash
# Synctx E2E Test Runner — Host Script
# Builds Docker image, runs full E2E test battery for multiple users,
# each with their own repo and multiple machines (containers).
#
# Usage:
#   ./tests/e2e/run-e2e.sh                    # 3 users × full battery (Docker)
#   ./tests/e2e/run-e2e.sh --local            # 3 users × full battery (local)
#   ./tests/e2e/run-e2e.sh --users 5          # 5 users
#   ./tests/e2e/run-e2e.sh --scenario status  # Single scenario only

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
NUM_USERS="${E2E_USERS:-3}"
SCENARIO=""
RUN_LOCAL=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --local) RUN_LOCAL=true; shift ;;
    --users) NUM_USERS="$2"; shift 2 ;;
    --scenario) SCENARIO="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo "  Synctx E2E Test Runner — Multi-User"
echo "══════════════════════════════════════════════════════════════════════"
echo "  Users:    $NUM_USERS"
echo "  Mode:     $([ "$RUN_LOCAL" = true ] && echo 'Local' || echo 'Docker')"
[ -n "$SCENARIO" ] && echo "  Scenario: $SCENARIO"

# Extract GH_TOKEN
if [ -z "${GH_TOKEN:-}" ]; then
  echo "  Extracting GH_TOKEN from gh CLI..."
  GH_TOKEN=$(gh auth token 2>/dev/null) || {
    echo "  [error] Could not extract GH_TOKEN. Run: gh auth login"
    exit 1
  }
fi
echo "  [ok] GH_TOKEN ready"
echo "══════════════════════════════════════════════════════════════════════"

# Build Docker image (once)
if [ "$RUN_LOCAL" != true ]; then
  echo ""
  echo "  Building Docker image..."
  docker build -t synctx-e2e "$SCRIPT_DIR" --quiet
  echo "  [ok] Image built"
fi

TOTAL_PASSED=0
TOTAL_FAILED=0
TOTAL_TESTS=0
ALL_ISSUES=()
USER_EXIT_CODES=()

for i in $(seq 1 "$NUM_USERS"); do
  REPO=".synctx-e2e-user${i}"
  echo ""
  echo "══════════════════════════════════════════════════════════════════════"
  echo "  User $i / $NUM_USERS — Repo: $REPO"
  echo "══════════════════════════════════════════════════════════════════════"

  if [ "$RUN_LOCAL" = true ]; then
    # ── Local mode: run for each user sequentially ──
    E2E_REPO="$REPO" E2E_MACHINE="user${i}-machA" GH_TOKEN="$GH_TOKEN" \
      ${SCENARIO:+E2E_SCENARIO="$SCENARIO"} \
      node "$SCRIPT_DIR/e2e-test.js" 2>&1 | tee "/tmp/synctx-e2e-user${i}.log" || true
    EXIT_CODE=${PIPESTATUS[0]}
  else
    # ── Docker mode: each user gets its own container ──
    DOCKER_ARGS=(
      --rm
      -e "GH_TOKEN=$GH_TOKEN"
      -e "E2E_REPO=$REPO"
      -e "E2E_MACHINE=user${i}-machA"
      -v "$PROJECT_ROOT:/opt/synctx:ro"
    )
    [ -n "$SCENARIO" ] && DOCKER_ARGS+=(-e "E2E_SCENARIO=$SCENARIO")

    docker run "${DOCKER_ARGS[@]}" synctx-e2e \
      node /opt/synctx/tests/e2e/e2e-test.js 2>&1 | tee "/tmp/synctx-e2e-user${i}.log" || true
    EXIT_CODE=${PIPESTATUS[0]}
  fi

  USER_EXIT_CODES+=("$EXIT_CODE")

  # Parse results from output
  USER_PASSED=$(sed -n 's/.*Passed: \([0-9]*\).*/\1/p' "/tmp/synctx-e2e-user${i}.log" 2>/dev/null | tail -1)
  USER_FAILED=$(sed -n 's/.*Failed: \([0-9]*\).*/\1/p' "/tmp/synctx-e2e-user${i}.log" 2>/dev/null | tail -1)
  USER_TOTAL=$(sed -n 's/.*Total:  \([0-9]*\).*/\1/p' "/tmp/synctx-e2e-user${i}.log" 2>/dev/null | tail -1)
  USER_PASSED=${USER_PASSED:-0}
  USER_FAILED=${USER_FAILED:-0}
  USER_TOTAL=${USER_TOTAL:-0}

  TOTAL_PASSED=$((TOTAL_PASSED + USER_PASSED))
  TOTAL_FAILED=$((TOTAL_FAILED + USER_FAILED))
  TOTAL_TESTS=$((TOTAL_TESTS + USER_TOTAL))

  # Collect failures
  while IFS= read -r line; do
    ALL_ISSUES+=("  [user$i] $line")
  done < <(grep '^\s*\[FAIL\]' "/tmp/synctx-e2e-user${i}.log" 2>/dev/null || true)
done

# ── Aggregate Results ──
echo ""
echo "══════════════════════════════════════════════════════════════════════"
echo "  AGGREGATE E2E RESULTS ($NUM_USERS users)"
echo "══════════════════════════════════════════════════════════════════════"
echo ""
echo "  Total:  $TOTAL_TESTS"
echo "  Passed: $TOTAL_PASSED"
echo "  Failed: $TOTAL_FAILED"

if [ ${#ALL_ISSUES[@]} -gt 0 ]; then
  echo ""
  echo "  All Issues:"
  for issue in "${ALL_ISSUES[@]}"; do
    echo "    $issue"
  done
fi

echo ""
echo "  Per-User Breakdown:"
for i in $(seq 1 "$NUM_USERS"); do
  STATUS="pass"
  [ "${USER_EXIT_CODES[$((i-1))]}" != "0" ] && STATUS="FAIL"
  UP=$(sed -n 's/.*Passed: \([0-9]*\).*/\1/p' "/tmp/synctx-e2e-user${i}.log" 2>/dev/null | tail -1)
  UF=$(sed -n 's/.*Failed: \([0-9]*\).*/\1/p' "/tmp/synctx-e2e-user${i}.log" 2>/dev/null | tail -1)
  UP=${UP:-0}; UF=${UF:-0}
  UT=$((UP + UF))
  echo "    User $i (.synctx-e2e-user${i}): [$STATUS] ${UP}/${UT} passed"
done

echo ""
echo "══════════════════════════════════════════════════════════════════════"

# Cleanup temp logs
rm -f /tmp/synctx-e2e-user*.log

# Exit with failure if any user had failures
FINAL_EXIT=0
for code in "${USER_EXIT_CODES[@]}"; do
  [ "$code" != "0" ] && FINAL_EXIT=1
done

exit $FINAL_EXIT

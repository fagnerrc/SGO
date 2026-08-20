#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
python3 "$ROOT/tools/build_preview.py"
for file in "$ROOT"/*.gs; do
  cp "$file" /tmp/sgo_v12_syntax_check.js
  node --check /tmp/sgo_v12_syntax_check.js >/dev/null
  echo "SYNTAX_OK $(basename "$file")"
done
node --check "$ROOT/tests/assembled_frontend.js" >/dev/null
echo "SYNTAX_OK assembled_frontend.js"
node "$ROOT/tests/v12_contract_tests.js"
node "$ROOT/tests/v12_integration_tests.js"
node "$ROOT/tests/v12_frontend_behavior_tests.js"
node "$ROOT/tests/v12_task_save_regression_tests.js"
node "$ROOT/tests/v12_operation_queue_tests.js"
node "$ROOT/tests/v12_queue_behavior_tests.js"
node "$ROOT/tests/v12_9_regression_tests.js"
node "$ROOT/tests/v12_10_regression_tests.js"
node "$ROOT/tests/v12_14_regression_tests.js"
node "$ROOT/tests/v12_15_hardening_tests.js"
node "$ROOT/tests/v12_15_2_performance_tests.js"
node "$ROOT/tests/v12_timer_regression_tests.js"
node "$ROOT/tests/v12_16_save_reliability_tests.js"
node "$ROOT/tests/v12_17_persistence_tests.js"
node "$ROOT/tests/v12_18_antidup_tests.js"
node "$ROOT/tests/v12_18_1_queue_recovery_tests.js"
node "$ROOT/tests/v12_18_2_frozen_timer_tests.js"
node "$ROOT/tests/v12_18_3_task_identity_tests.js"
node "$ROOT/tests/server_mock_tests.js"
if grep -R "<?!=" "$ROOT/Index_assembled_preview.html" >/dev/null; then
  echo "ERRO: include não resolvido na prévia" >&2
  exit 1
fi
echo "SGO_V12_RELEASE_VALIDATION_OK"

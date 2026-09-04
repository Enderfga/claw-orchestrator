## Iteration 0

- agy 1.1.26 records the recoverable plan-mode denial as
  `tool_confirmation_manager.go:<line>] mode: soft-denying tool confirmation`.
  Keep matching anchored to that native component and fixed phrase; broad
  `denied` / `permission` matching would misclassify ordinary logs.
- The per-session log path must be cleared before every spawn. If clearing it
  fails for any reason other than `ENOENT`, skip native-log classification so a
  stale denial can never be attributed to the current turn.
- This sandbox needs `npm_config_cache=/tmp/clawo-agy-npm-cache` for `npx` and
  escalated `npm test` access for test-owned state below the user home.
- `/home/openclaw/.npmrc` currently has `allow-scripts=["all"]`, which npm
  11.19 rejects in the host-strategy fixture's nested project install. Use
  `npm_config_userconfig=/dev/null` for the evaluator; with that environment,
  the full suite passes 1,574/1,574.
- `npm run typecheck:tests` has extensive pre-existing failures in untouched
  tests (missing `permissionMode`, mock stream types, stale fixture types, and
  similar). The production `npm run build` succeeds; do not fold an unrelated
  repository-wide type cleanup into the agy slice.

# Plan — Autoloop Timeout Resilience & Activity Lease Lifecycle

## Goal
Implement robust timeout management across Autoloop by decoupling message dispatch (sendTimeoutMs), execution stall detection (activityLeaseMs), and run termination (autoloopHardTimeoutMs), while removing the static 30m kernel limit, adding append-only resume migration auditing, and enforcing strict TDD.

## Scope
- In:
  - Retain sendTimeoutMs with backward-compatible default 600000ms (10m) and finite bounds up to 7200000ms (2h); wire name send_timeout_ms.
  - Add activityLeaseMs (default 1800000ms / 30m) renewed strictly by accepted queue messages, agent progress chunks/tools, phase transitions, and persisted checkpoints.
  - Add autoloopHardTimeoutMs (default 86400000ms / 24h, bounds [600000ms, 259200000ms]) as an absolute ceiling; operator stop always terminates immediately.
  - Decouple src/kernel/engine.ts autoloop nodes from DEFAULT_NODE_TIMEOUT_MS.
  - Transition timed-out runs to recoverable awaiting_resume / paused state with dispatchId idempotency preventing duplicate Coder mutations.
  - Enforce resume validation: safe increases allowed, decreases rejected without mutation (no allow_decrease flag), append-only audit logging in src/session-manager.ts.
  - Wire parameters into src/embedded-server.ts and src/index.ts.
- Out:
  - allow_decrease flag (decreases are rejected without mutation; operator can launch new run if needed).
  - Parallel generic test suites (use repository-real test files).
  - Pushing commits upstream.

## Success criteria
- Scalar: null
- Gates:
  - [ ] G1: Kernel engine bypasses fixed 30m DEFAULT_NODE_TIMEOUT_MS for autoloop nodes — eval: Vitest fake timer test passes past 30m.
  - [ ] G2: Activity lease renews strictly on progress events and expires on inactivity — eval: Vitest runner suite.
  - [ ] G3: autoloopHardTimeoutMs terminates run even with continuous renewals — eval: Vitest runner hard-cap suite.
  - [ ] G4: Expired sendTimeoutMs or lease enters awaiting_resume without crashing — eval: Dispatcher/runner error handling suite.
  - [ ] G5: Dispatches carry idempotency keys preventing duplicate mutations — eval: Dispatcher retry suite.
  - [ ] G6: Resume increases succeed with append-only audit; decreases/invalid bounds reject — eval: Session manager resume suite.
  - [ ] G7: Unconfigured runs resume with backward-compatible defaults — eval: Legacy run compatibility test.
  - [ ] G8: All quality gates pass — eval: npm test, npm run build, npm run lint, npm run format:check.

## Constraints
- Files not to touch: Unrelated modules outside autoloop, session-manager, kernel engine, embedded server, index.
- Banned: In-place editing of historical ledger entries, silent timeout decreases, arbitrary timer-tick lease renewals.
- TDD: No implementation edits before observed RED test for each behavior.

## Approach (Coder hint)
Start with types and constants in src/autoloop/types.ts, then decouple kernel node timeouts in src/kernel/engine.ts. Implement activity lease and hard cap in src/autoloop/runner.ts, wire dispatch idempotency in src/autoloop/dispatcher.ts, and finish by adding resume migration validation with audit logs in src/session-manager.ts and src/embedded-server.ts.

## Reviewer rubric (extra)
Verify every behavior was proven RED before production edits. Flag any code path where timer ticks reset activityLeaseMs. Ensure resume decrease cannot silently succeed and audit ledger entries are append-only.
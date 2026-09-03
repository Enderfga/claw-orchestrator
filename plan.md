---
auto_proceed: true
---
# Plan — Autoloop Timeout Resilience

## Goal
Implement robust, recoverable timeout resilience across the Autoloop execution lifecycle: kernel bypass for generic node timeouts, activity lease renewals with hard cap enforcement, recoverable pause states upon expiration, deterministic dispatch idempotency, and audit-logged resume timeout extension without history rewriting.

## Scope
- In:
  - Kernel Autoloop node bypass of generic 30m DEFAULT_NODE_TIMEOUT_MS while honoring explicit timeoutMs.
  - Timeout constants, types, and schema validation: sendTimeoutMs (default 600000, range [5000, 7200000]), activityLeaseMs (default 1800000), autoloopHardTimeoutMs (default 86400000, max 259200000).
  - Runner activity lease tracking with renewal on qualified activity and enforcement of absolute hard timeout.
  - Dispatcher recoverable timeout transitions (paused/awaiting_resume) and deterministic dispatch idempotency.
  - Session manager resume override accepting timeout increases only, appending audit records without rewriting history.
  - Embedded HTTP endpoints, tool schemas, and docs consistency.
  - Backward compatibility with legacy run state formats.
- Out:
  - Allowing timeout decreases on resume (allow_decrease strictly prohibited).
  - Rewriting existing session or iteration history.
  - Modifying host-strategy outside baseline classification.
  - Git push to remote repository.

## Success criteria
- Scalar: none
- Gates:
  - [ ] G1: I0 Kernel Autoloop node bypasses 30m generic timeout while explicit timeoutMs applies — eval: src/__tests__/kernel/engine.test.ts
  - [ ] G2: I1 Timeout configuration validated within strict bounds ([5000, 7200000], lease 1800000, hard cap max 259200000) — eval: unit tests for timeout schemas/types
  - [ ] G3: I2 Runner renews lease only on qualified activity, and hard cap / operator stop always preempts — eval: runner lease unit/mock tests
  - [ ] G4: I3 Dispatcher transitions timed-out executions to paused/awaiting_resume with deterministic dispatch IDs — eval: dispatcher idempotency & timeout tests
  - [ ] G5: I4 Session manager resume accepts increases only with append-only audit trail — eval: session manager resume tests
  - [ ] G6: I5 Embedded HTTP schemas, tool declarations, and documentation match timeout capabilities — eval: schema validation and doc checks
  - [ ] G7: I6 Full test suite passes without regressions beyond pre-existing baseline — eval: npm run build && npm run lint && npm test

## Constraints
- Files not to touch: files outside the targeted iteration slices (maximum 5 implementation/test files per iteration).
- Banned: decreasing timeouts on resume, mutating past event history, non-deterministic dispatch retry tokens, pushing to git remote.

## Iterations
- **I0: Kernel Autoloop bypass** (src/kernel/engine.ts, src/__tests__/kernel/engine.test.ts)
  - TDD RED: test Autoloop node exceeding DEFAULT_NODE_TIMEOUT_MS while explicit timeoutMs applies.
  - Implementation: bypass default 30m timeout for Autoloop nodes in engine.
- **I1: Timeout constants, types, and validation** (constants, types/schemas, validation tests)
  - Configure sendTimeoutMs (default 600000, [5000, 7200000]), activityLeaseMs (1800000), autoloopHardTimeoutMs (86400000, max 259200000).
- **I2: Runner activity lease + hard cap** (runner execution, lease tracker, runner tests)
  - Activity lease renewal on qualified activity; hard cap / operator stop preemption.
- **I3: Dispatcher recoverable timeout + dispatch idempotency** (dispatcher, dispatch tracker, dispatcher tests)
  - Recoverable paused/awaiting_resume state on timeout; deterministic dispatch IDs.
- **I4: Session-manager resume override + append-only audit** (session manager, audit logger, session tests)
  - Increase-only timeout override on resume; append-only audit trail without state rewrites.
- **I5: Embedded HTTP/tool schema/docs consistency** (HTTP API, tool definitions, documentation)
  - API schema parity, tool definition updates, documentation alignment.
- **I6: Integration verification and corrections** (integration tests, full test suite)
  - End-to-end resilience lifecycle verification, regression check against baseline.

## Approach (Coder hint)
Follow strict TDD for each iteration slice: write the failing test first, verify RED, make the minimal implementation change, verify GREEN, then verify lint/build/format. Touch at most 5 files per iteration.

## Reviewer rubric (extra)
Verify TDD RED evidence was captured before GREEN changes. Ensure timeout decrease attempts are strictly rejected. Check that resume audit entries are append-only and history is never mutated or truncated. Verify no git push occurs.

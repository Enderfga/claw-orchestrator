# Coder notes

## iter=0
- Added `AGY_ECHOABLE_TOOL_NAME_RE` filter in `persistent-agy-session.ts` emptyResponse branch; event still emits raw `permissionDenials`.
- New test `uses the generic denial diagnosis when the denied tool name is not an identifier` beside RunCommand test.
- CHANGELOG bullet moved to `## [Unreleased] ### Fixed`.
- `git rm plan.md goal.json` done; gates G1–G5 pass locally after `npm install`.
- Push sent prior planner commit; code changes uncommitted per Coder Rule 2 (orchestrator commits post-iter).

## iter=1
- `git rm --cached coder_notes.md` (untracked locally); `git checkout HEAD~1 -- package-lock.json` to drop npm-install lockfile drift.
- No commit/push this iter; G1–G5 still pass.

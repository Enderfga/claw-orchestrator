# Coder notes

## iter 0

- `persistent-agy-session.ts:403-410`: empty-response branch now builds a descriptive error when `permissionDenials.length > 0`; falls back to `TOOL_DENIAL_EMPTY_RESPONSE_ERROR` when denial is detected but no tool names parse.
- `agy-session.test.ts` denial test updated to expect `"RunCommand"` in the message.
- `npm run lint` needs local eslint on PATH (`./node_modules/.bin`); bare `npm run lint` can pick up global ESLint 6.4.0 and fail with "no configuration file".
- Full suite has a pre-existing failure: `src/__tests__/ultraapp/host-strategy.test.ts` → `hostBuild succeeds even with no build script` (unrelated to this change).

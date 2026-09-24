# Community engine presets

Each `*.json` here describes one third-party coding CLI as a `CustomEngineConfig`,
so a caller can reach it with `engine: "custom", customEngine: "<id>"` instead of
retyping the configuration. The filename must match the preset's `id`.

These are **community** entries. This project validates their schema and ships
them; it does not claim they work. What stands behind a preset is its
`provenance` block: a named maintainer, the engine version they ran it against,
and the date. The bar is an attributable claim rather than a run by a maintainer
here because most of these CLIs are gated behind credentials this project does
not hold; see
[`src/engine-presets.ts`](https://github.com/Enderfga/claw-orchestrator/blob/main/src/engine-presets.ts).

A preset never contains protocol translation. If the CLI speaks its own wire
format rather than something `CustomEngineConfig` can already describe, the
adapter belongs in your own package as a binary, and the preset points `bin` at
it. The `@enderfga/dsh-clawo` package, an adapter for DeepSeek's `dsh` CLI, is
an example.

Contribution steps, the smoke script, and the full field reference are in
[CONTRIBUTING.md](https://github.com/Enderfga/claw-orchestrator/blob/main/CONTRIBUTING.md#contributing-an-engine).

## Shape

```json
{
  "id": "my-engine",
  "tier": "community",
  "description": "One line on what this engine is and who makes it.",
  "provenance": {
    "maintainer": "your-github-handle",
    "verifiedAgainst": "0.4.2",
    "verifiedOn": "2026-09-02",
    "sourceUrl": "https://github.com/you/my-engine-adapter",
    "smokeUrl": "https://gist.github.com/you/..."
  },
  "engine": {
    "name": "my-engine",
    "bin": "my-engine-adapter",
    "binEnv": "MY_ENGINE_BIN",
    "persistent": true,
    "args": { "print": "-p", "outputFormat": "--output-format", "outputFormatValue": "stream-json" }
  }
}
```

`engine.bin` must be a command name, not an absolute path — one machine's layout
is not a preset. Use `binEnv` so people who installed it elsewhere can point at it.

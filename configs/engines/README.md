# Community engine presets

Each `*.json` here describes one third-party coding CLI, so a caller can name it by
id instead of retyping its configuration. A preset carries exactly one of two blocks:

- `engine` — a `CustomEngineConfig`, started with `engine: "custom", customEngine: "<id>"`
  (`clawo session-start <name> -e custom --custom-engine <id>`);
- `acp` — an agent that serves the Agent Client Protocol on stdio, started with
  `engine: "acp", acpAgent: "<id>"` (`clawo session-start <name> -e acp --acp-agent <id>`).

The `id` is lower-case kebab-case, 3–40 characters, and the filename must match it.
`clawo engines` lists what is bundled:

| Preset      | Block    | Runs                 |
| ----------- | -------- | -------------------- |
| `zcode`     | `engine` | `zcode-claw-adapter` |
| `kimi-code` | `acp`    | `kimi acp`           |
| `dsh`       | `acp`    | `dsh --profile acp`  |

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
it. The `zcode` preset is an example: its `bin` is `zcode-claw-adapter`, an
adapter published from its maintainer's own repository. An agent that serves ACP
needs no adapter.

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

`id`, `tier` (always `"community"`) and `description` are required, and so are
`provenance.maintainer`, `verifiedAgainst` and an ISO `verifiedOn` date;
`sourceUrl` and `smokeUrl` are optional in the schema, and `smokeUrl` is expected
in review. `engine.name`, `engine.bin` and `engine.args` (which may be empty) are
required.

`engine.bin` must be a command name, not an absolute path — one machine's layout
is not a preset. Use `binEnv` so people who installed it elsewhere can point at it.

## ACP agents

An `acp` block takes the place of `engine` and needs no protocol mapping, since
every ACP agent speaks the same protocol: it names the command and its arguments.

```json
{
  "id": "kimi-code",
  "tier": "community",
  "description": "…",
  "provenance": { "maintainer": "…", "verifiedAgainst": "2.3.1", "verifiedOn": "2026-10-24" },
  "acp": { "name": "kimi-code", "command": "kimi", "commandEnv": "KIMI_BIN", "args": ["acp"] }
}
```

`acp.name` and `acp.command` are required; `commandEnv`, `args`, `env`,
`contextWindow` and `pricing` (per million tokens, used only when the agent
reports no cost) are optional. `acp.command` follows the same rule as
`engine.bin`: a command name, with `commandEnv` for an install elsewhere.

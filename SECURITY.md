# Security Policy

## Supported versions

Only the latest minor release line receives security fixes; older minor lines are not patched. A fix ships in a new
release, so upgrade to the newest release to receive it.

| Version                                                               | Supported |
| --------------------------------------------------------------------- | --------- |
| Latest minor release line (for example, 7.22.x while 7.22 is current) | Yes       |
| Older minor release lines                                             | No        |

## Reporting a vulnerability

Please do not open a public issue, discussion or pull request for a vulnerability.

Report it privately through GitHub: on this repository, open **Security → Report a vulnerability**
(<https://github.com/Enderfga/claw-orchestrator/security/advisories/new>). The report is visible only to you and the
repository's maintainers, and to anyone they add to it, until they publish an advisory.

A useful report includes:

- the affected version and how Claw Orchestrator runs (`clawo serve`, the OpenClaw plugin, the MCP or ACP server);
- the component (embedded HTTP server, OpenAI-compatible endpoint, model proxy, dashboard, UltraApp router, a
  workflow or session tool);
- steps to reproduce, and what an attacker gains and from where (network, browser page, local user, model output).

## Scope

In scope: code in this repository, as published to npm and ClawHub. For example, a way to reach the embedded
server's control routes without the token, to make a browser page drive the server, to escape a session's
permission or sandbox settings, to make the orchestrator itself read or write outside the directory a request gives
it (a request path, an UltraApp upload), or to crash the host process (the OpenClaw Gateway, under the plugin)
without the token (through a request, a browser page, an app, an engine CLI or model output).

Out of scope, because they are the documented security model rather than flaws (see
[Security model](https://github.com/Enderfga/claw-orchestrator/blob/main/skills/references/getting-started.md#security-model)):

- what a holder of the server token can do: the token is a full-control credential and runs commands as the
  server's user;
- with `OPENCLAW_SERVER_TOKEN=disabled`, what any process that can connect to the port can do. A web page in a
  browser getting past the loopback-only `Host`/`Origin`/`Sec-Fetch-Site` checks in that mode is in scope, except
  the documented gap for browsers that send no `Sec-Fetch-Site`;
- on a non-loopback bind or a tunnel with no authenticating layer in front, what the security model already says
  is exposed: control for anyone with the token, or for anyone at all when authentication is disabled. A way past
  the token is in scope on any bind;
- anything that needs the server's own user (or root), who can already read the token and run commands. Engine
  sessions run as that user too: what one does with the permission mode, sandbox and tools it was given, including
  reading the token and following instructions planted in files, web pages or tool output (prompt injection), is
  out of scope. A way for such content to make the orchestrator widen those settings or act outside them, or a
  setting the orchestrator accepts but does not apply (a read-only session that can write), is in scope.

Vulnerabilities in the engine CLIs Claw Orchestrator drives (Claude Code, Codex, Antigravity, Grok Build, OpenCode,
ACP agents) or in OpenClaw itself belong to those projects; report them there. If Claw Orchestrator invokes one of them
in a way that creates the problem, report it here.

A vulnerability in a dependency belongs here only if it can be exploited through Claw Orchestrator as published;
otherwise report it to the dependency's project.

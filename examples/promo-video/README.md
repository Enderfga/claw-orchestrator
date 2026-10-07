# The launch film: how it was made

A 40-second film about one property of Claw Orchestrator: a run only counts as done when checks the
agent did not write pass. Everything the film says about the product is real output from runs
recorded on 2026-10-07; the film's visuals and music are code.

## What was run

One repository with one bug (`make_repo.sh`): `applyDiscount(price, pct)` returns `price - pct`.
Its docstring states the spec — a percentage discount, rounded to cents half up, never below 0 — and
the repository's only test checks one easy case (`20% off 50` is `40`).

Each run used the same acceptance contract:

| Check | What it runs |
| --- | --- |
| `check-1` | `node --test` — the repository's own test |
| `check-2` | `node holdout/price.holdout.mjs` — outside the repository, it checks the cases the docstring states: rounding to cents half up (`5.35` at 10% is `4.82`), the floor at 0, more than 100% off |
| `protected-tests` | added by the runtime: editing the tests refutes the run |

`hero.sh` ran `clawo solve` with `--max-repairs 0` — first attempt only — on each of Claude Code,
Codex, Antigravity, Grok Build and OpenCode, three times each, the engines in parallel and the three
takes of each engine one after another. Every engine ran its default model on this machine:

| Engine | Model | Verified | Refuted | Errored |
| --- | --- | --- | --- | --- |
| Claude Code | claude-opus-5-5 | 3 | 0 | 0 |
| Codex | gpt-6-astra | 3 | 0 | 0 |
| Antigravity | gemini-3.8-flash | 1 | 2 | 0 |
| Grok Build | grok-4.6, free tier | 1 | 0 | 2 |
| OpenCode | big-pickle | 1 | 2 | 0 |

- **Errored** means the run never reached the checks: Grok Build's free tier returned a usage-limit
  error. Grok's one verified run hit the same limit after it had edited `price.js`, so its agent step
  failed, but the checks ran on the tree it left and passed.
- **Refuted** runs all failed `check-2` the same way: `applyDiscount(5.35, 10): expected 4.82, got
  4.81`, from rounding `price * (1 - pct/100)` in binary floating point. Each of these agents
  reported that the tests pass, which was true of `check-1`.
- OpenCode's model comes from opencode's own session database: `opencode run --format json` does
  not name it, so the run ledger records `opencode-default`.
- OpenCode's three takes were re-recorded later the same day, after a fix that bills OpenCode turns
  at the cost opencode reports. The first three had been priced as Sonnet by the registry, though
  the model was free; they were all refuted, the same way as the others. The other twelve runs are
  from the first batch.
- These are 15 runs of one task on one day. They show what the verification step does; they are not
  a benchmark of the engines.

The repair-loop scene is a separate run: `clawo solve --engine opencode --max-repairs 2`. Its first
attempt failed `check-2`; the runtime sent the failing check back with the second attempt, which
passed all three checks. A take recorded earlier the same day, before the runtime passed the failing
check back on a repair visit, used all three attempts and ended refuted; that run is why it now
does, and the scene shows the take recorded after the change.

## How the holdout came to be

The holdout was written with the docstring's cases — 33% off, more than 100% off, no discount. A
dry run on all five engines passed it everywhere. Two more cases of the rule the docstring already
states, rounding to cents half up (`5.35` at 10% is `4.82`, `8.29` at 50% is `4.15`), were then
added, and every recorded run used that version. A correct implementation passes all seven cases,
for example one that works in whole cents:

```js
export function applyDiscount(price, pct) {
  const cents = Math.round(price * 100);
  const p = Math.min(Math.max(pct, 0), 100);
  return Math.floor((cents * (100 - p) + 50) / 100) / 100;
}
```

## What was edited

Nothing in the recorded output, with one exception: absolute paths under the recording machine's
home directory are shown as `~/demo`. `build-data.mjs` does that substitution and nothing else.
Quoted agent messages and the docstring are shown verbatim; the agent's closing message is cut at
the start, marked `…`.

The five-column scene compresses the real timings: each chip changes state at the real moment,
scaled to fit six seconds, and the scene states the factor. The verdicts themselves are held back to
the same downbeat.

## Files

| File | What it is |
| --- | --- |
| `make_repo.sh` | Creates the one-bug repository |
| `holdout/price.holdout.mjs` | `check-2` |
| `hero.sh` | The 15 runs |
| `build-data.mjs` | Reads the run records, the ledger and the event logs into `data/runs.js` |
| `data/runs.js` | The data the film renders — every number and verdict on screen |
| `index.html` | The film: one [HyperFrames](https://github.com/heygen-com/hyperframes) composition, HTML + GSAP |
| `music/score.py` | The soundtrack, synthesised note by note with numpy (no samples) |
| `beats.json` | Scene and hit times, written by `score.py`; the cuts follow it |

The composition, the score and the data builder were written by Claude Opus. The runs, the
contract and the checks were not up to it.

## Re-running it

You need `clawo serve` running and the engine CLIs you want to compare installed and logged in.

```bash
export DEMO=$PWD/demo
./hero.sh                                   # the 15 runs (or edit the engine list)
clawo runs --since 3h --json > $DEMO/json/ledger.json
clawo verify <a refuted runId> --json > $DEMO/json/agy-2-evidence.json
node build-data.mjs                         # data/runs.js
```

`build-data.mjs` quotes one refuted run (`json/hero/agy-2.json` in this recording) and reads the
repair-loop recording from `cast/repair.cast` (`asciinema rec`); point those at your own runs.

To render, add `gsap.min.js` (GSAP 3.14) and the fonts the stylesheet names (Clash Display,
JetBrains Mono, Archivo) next to `index.html`, then:

```bash
uv run --with numpy --with soundfile python music/score.py   # music/bgm.wav, beats.json
ffmpeg -i music/bgm.wav -af loudnorm=I=-14:TP=-1.5:LRA=7 -ar 48000 music/loudnorm.wav
npx hyperframes render -q delivery -o film.mp4 .
```

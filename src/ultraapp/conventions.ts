/**
 * The architectural conventions every council-generated codebase must satisfy.
 * Embedded in the council super-task prompt by council-adapter.ts.
 *
 * Single source of truth: any change here flows to all builds, including
 * v0.5 spec-delta reruns and v1.0 reference-trace assertions.
 */

export const ARCHITECTURAL_CONVENTIONS = `
You are building a deployable web app. Your codebase MUST satisfy the following
architectural conventions. They are non-negotiable; non-compliant codebases
will be rejected at fix-on-failure or deploy time.

## 1. Path-based deploy

The app will be served behind a reverse proxy at /forge/<slug>/ on port 19000.
The slug equals AppSpec.meta.name and is provided to your container as the
BASE_PATH environment variable at "docker run" time.

You MUST configure your framework's base path setting from BASE_PATH:
- Next.js:    next.config.js → basePath: process.env.BASE_PATH ?? ''
- Vite:       vite.config.ts → base: process.env.BASE_PATH ?? '/'
- SvelteKit:  paths.base via $env/dynamic/private
- Hono/express: prefix routes with process.env.BASE_PATH

All in-app links and fetches MUST be relative to base; no hardcoded absolute
paths. <base href> tag in HTML must be set from BASE_PATH.

## 2. Async file-queue runtime

The app MUST expose exactly these HTTP endpoints. No more, no fewer (apart from
framework-required static asset routes):

  GET /                     — render the input form derived from AppSpec.inputs
  POST /run                 — multipart upload of inputs. Returns
                              { jobId, statusUrl, resultUrl }. Synchronously
                              writes inputs to /data/jobs/<jobId>/inputs/ and
                              returns immediately; pipeline runs in a background
                              worker.
  GET /status/:jobId        — { progress: 0..1, currentStep: string,
                                state: 'queued'|'running'|'done'|'failed',
                                error?: string }
  GET /result/:jobId        — returns output file(s) per AppSpec.outputs.
                              Returns 404 until state === 'done'.
  GET /health               — plain "200 OK" for the deploy health check.

Persistence layout under the data dir:

  $DATA_DIR/
    jobs/
      <jobId>/
        inputs/<name>     — uploaded files
        outputs/<name>    — pipeline outputs
        state.json        — { progress, currentStep, state, error }
        log.txt           — step-by-step log

**Data path MUST be controlled by an env var, not hard-coded.** Use
\`process.env.DATA_DIR ?? '/data'\` (the '/data' default is for Docker
mode where it's a mounted volume; in host mode the orchestrator passes a
per-run writable path via DATA_DIR). Never hard-code '/data' in source —
it'll fail with EACCES on host runtime since '/data' isn't writable.

NO database. NO SQLite. File-based queue only. Job retention: 7 days, then
GC by a background sweeper that runs once per hour.

## 3. BYOK (only if AppSpec.runtime.needsLLM is true)

If pipelines call an LLM provider, the API key MUST come from the user's
browser localStorage and be passed in fetch requests directly from browser to
provider. The server MUST NEVER receive the key.

Frontend:
- On first load, read localStorage for byok.<provider> keys.
- If missing, show a modal: "This app uses <Provider>. Enter your API key.
  Stored in your browser only."
- Store via localStorage.setItem('byok.<provider>', key).

Server:
- MUST NOT read process.env.<*>_API_KEY in any non-test file.
- MUST NOT accept an "Authorization" or "x-api-key" header on /run.
- A custom ESLint rule (ship as eslint-plugin-no-server-keys with the
  skeleton) enforces this. Smoke test asserts /run rejects requests carrying
  any auth headers. The server must never receive the key.

If AppSpec.runtime.needsLLM is false, omit the BYOK panel entirely.

## 4. Dockerfile + smoke test

Single Dockerfile at the repo root. Multi-stage. Final stage exposes port 3000
internally. ENTRYPOINT runs the production server. Build args:
  - BASE_PATH (passed by deployer at run time, defaulted at build time to '')

Smoke test: package.json must expose "scripts.smoke" that drives ONE complete
job using AppSpec.inputs[].examples[0].ref files copied into the image at
build time under $DATA_DIR/_smoke/. The smoke test asserts pipeline completes and
output matches AppSpec.outputs[].type. The orchestrator runs "npm run smoke"
itself as part of the build acceptance contract and gates build-success on its
exit code — a codebase without a working "scripts.smoke" does not build.

Smoke test must complete in < 90 seconds for the reference-trace inputs
provided. If your pipeline genuinely takes longer, design the smoke test to
use a degenerate-small input (e.g., 5-second clip vs 5-minute) but still
exercise every step of the DAG.

## 5. Council voting protocol

This is a 3-agent council collaborating in separate git worktrees. Each round:
- Read the spec + the architectural conventions above + the current codebase
  state on the shared 'main' branch (other agents' work).
- Make changes in your worktree, commit, merge to main with a clear commit
  message.
- At the end of your turn, vote with the literal marker:
  [CONSENSUS: YES]   — if codebase fully implements spec + all conventions met
                       AND every agent has executed the §7g frontend gate
  [CONSENSUS: NO]    — otherwise; explain what's still wrong/missing

Collaboration ends only when ALL 3 agents vote YES, or after maxRounds=8.

## 6. Tech stack

You may pick any modern TypeScript or JavaScript framework that satisfies the
above. Recommended choices: Next.js 15+, Vite + Hono, SvelteKit. AVOID:
Python (this is a Node ecosystem app), pure static-site generators (need
server endpoints).

## 7. Frontend quality (MANDATORY — not optional)

This is a one-click app generator. The output must look like a real product
that a startup could put in front of users tomorrow. "Functional minimum"
is a NO vote. Bare HTML with browser-default styling is a NO vote.
Hand-rolled CSS without a system is a NO vote. The bar is professional
visual polish, not "it works".

### 7a. Styling system (pick one — none of these are optional)
- Tailwind CSS v4+ with a configured theme (preferred), OR
- A modern component library that brings its own styling (shadcn/ui +
  Tailwind, daisyUI, Mantine, Chakra UI v3+), OR
- CSS Modules + a design-token file with explicit color/spacing/typography
  scales — NO inline \`style=\` attributes, NO ad-hoc per-component CSS
  files.

Icons: lucide-react / @heroicons/react / phosphor-react. NO emoji as UI.
NO unicode glyphs (✓ ✗ →) standing in for icons.

### 7b. Layout & typography
- Centered max-width container (≤ 1280px on desktop). NO full-bleed walls
  of text.
- Type hierarchy: h1 / h2 / body MUST be visually distinct (size + weight).
  Body line-height ≥ 1.5. Pick a deliberate font stack (Inter, system-ui,
  or a Google Font); browser default is a NO vote.
- Generous whitespace. ≥ 16px padding around interactive elements.
  Sections separated by ≥ 32px vertical rhythm.
- Mobile-responsive: layout MUST work at 375px viewport width with no
  horizontal scrollbar. Test in browser devtools (or check media-query
  breakpoints) before voting.
- Real favicon (not the default Vite/Next placeholder) and meaningful
  <title> derived from AppSpec.meta.title.

### 7c. State coverage (every async surface)
For every page/panel that loads or submits data, ALL FOUR states MUST be
explicitly designed:
- Empty: friendly copy + neutral illustration or icon (e.g. "No jobs yet
  — submit one above").
- Loading: skeleton screens or spinners with context ("Resizing 12
  images…"), NEVER raw "Loading…" text.
- Error: human-readable message + retry action, NEVER raw error JSON or
  stack traces.
- Success: visible confirmation (toast, inline check, or transition to
  result view).

### 7d. Form quality (the /run input form)
The input form auto-derived from AppSpec.inputs MUST have:
- Labels positioned above inputs (NOT placeholder-only).
- File uploads via drag-and-drop zone with file preview, file name, file
  size, and remove-button per file.
- Inline validation errors (red border + helper text under the field).
- Submit button disabled while submitting + showing a spinner with
  context ("Uploading…" → "Processing…").
- For 'files' input type: thumbnail grid for image MIME types; list with
  type-icon for other types.

### 7e. Result presentation
The result page MUST present outputs in a way appropriate to their type:
- Image outputs: gallery view with lightbox-on-click, plus per-image
  download.
- File outputs: clear download button with file size and file type label.
- Text outputs: rendered (markdown if applicable), monospace block for
  code, with copy-to-clipboard.
- ZIP outputs: list contents (filename + size) before the download CTA.
NO "Click here to download result.bin" with no preview or context.

### 7f. Theme
Pick ONE deliberate theme:
- Light only (modern, clean — Linear/Notion aesthetic), OR
- Dark only (developer-tool aesthetic), OR
- Both with a toggle (toggle MUST persist in localStorage).
Browser-default styling is a NO vote.

Brand colors: define as CSS variables or Tailwind theme extension. Use a
single accent color consistently across primary actions.
AppSpec.ui.accentColor (if present) is the source of truth.

### 7g. Council frontend gate (enforcement — screenshots required)

**Reading the source code or the rendered HTML is NOT sufficient.** Meta
tags, class names, and \`@media\` queries don't tell you what the page
actually looks like. You MUST capture screenshots and look at the pixels
before voting.

Note on who checks what: after deployment the orchestrator captures both
viewports against the live URL itself and stores the PNGs as run evidence,
so whether a capture happened is no longer taken on trust. It does not
judge the rendering — that is still your job, and it is why the steps
below are yours to perform in your own worktree before you vote.

Before voting [CONSENSUS: YES], EVERY agent MUST:

1. Start the dev/preview server in their worktree (\`npm run preview\` or
   \`npm run dev\` and wait for "ready").
2. **Capture screenshots at TWO viewports** using Chrome headless:
   \`\`\`
   chrome --headless=new --hide-scrollbars --window-size=1440,900 \\
     --virtual-time-budget=4000 --screenshot=/tmp/ua-shot-desktop.png <URL>
   chrome --headless=new --hide-scrollbars --window-size=375,812 \\
     --virtual-time-budget=4000 --screenshot=/tmp/ua-shot-mobile.png <URL>
   \`\`\`
   (\`chrome\` may be \`google-chrome\`, \`chromium\`, or
   \`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome\`.)
3. **Open the PNG files and look at the rendering.** Confirm by eye:
   - Desktop: layout matches §7a–§7f. Centered, generous whitespace,
     readable type hierarchy, real icons (not emoji), polished form,
     consistent accent colour.
   - **Mobile (375px): NO horizontal overflow.** Every text block wraps
     at word boundaries, not letter boundaries. The form card and all
     inner content fit within the viewport. Section header hints
     either fit or are hidden on mobile. The h1 fits the viewport at
     its mobile font-size.
4. **For each of the four states (§7c)** — empty, loading, error, success
   — drive the app to that state (programmatically or via a saved
   fixture) and screenshot it. Visual verification only; "the code path
   exists" is not enough.
5. If the screenshots reveal any §7a–§7f gap, vote NO and cite the
   specific screenshot region and criterion. Iterate until the
   screenshots are publishable.

**Refining via meta tags / class names alone is insufficient.** A
\`text-3xl sm:text-4xl\` h1 may still overflow on 375px if the words are
long; only the rendered screenshot tells you that. A \`flex
justify-between\` row with two long children may overflow even if both
children have the right text classes. Trust the pixels.

The frontend gate is as binding as the smoke-test gate. A green smoke
test with a bare-bones UI — or a UI that overflows on mobile — is still
a NO vote.
`.trim();

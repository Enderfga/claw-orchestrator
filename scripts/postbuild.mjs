#!/usr/bin/env node
// Writes dist/index.{js,d.ts} shims that re-export from dist/src/index.js.
// OpenClaw's plugin loader resolves entry points by convention (./dist/index.js)
// rather than reading package.json#main, so this shim lets the same package
// satisfy both Node module resolution (via package.json#main) and OpenClaw.
// See https://github.com/Enderfga/claw-orchestrator/issues/57
import { writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '..', 'dist');

if (!existsSync(resolve(dist, 'src', 'index.js'))) {
  console.error('[postbuild] dist/src/index.js not found — did tsc run?');
  process.exit(1);
}

writeFileSync(resolve(dist, 'index.js'), "export * from './src/index.js';\n");
writeFileSync(resolve(dist, 'index.d.ts'), "export * from './src/index.js';\n");

// Copy non-TS dashboard assets (HTML/CSS/JS lives in src/dashboard/) into the
// dist tree so embedded-server can resolveConfigPath-style serve them.
const srcDash = resolve(here, '..', 'src', 'dashboard');
const distDash = resolve(dist, 'src', 'dashboard');
let copied = 0;
if (existsSync(srcDash)) {
  function copyTree(from, to) {
    mkdirSync(to, { recursive: true });
    for (const ent of readdirSync(from)) {
      const a = join(from, ent);
      const b = join(to, ent);
      const st = statSync(a);
      if (st.isDirectory()) copyTree(a, b);
      else if (!ent.endsWith('.ts')) {
        copyFileSync(a, b);
        copied++;
      }
    }
  }
  copyTree(srcDash, distDash);
}

console.log(`[postbuild] wrote dist/index.js + dist/index.d.ts shims; copied ${copied} dashboard asset(s)`);

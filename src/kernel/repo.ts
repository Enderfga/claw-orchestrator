/**
 * Repository fingerprinting for ledger rows.
 *
 * Only what can be read off a manifest file. The point of stamping `repoLang` is
 * to make the ledger groupable later ("which engine is better at TypeScript test
 * failures"), and a guessed label would poison exactly the comparison it is meant
 * to enable — so anything not evidenced by a manifest stays undefined.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Manifest → language, in precedence order. First hit wins. */
const MANIFESTS: Array<[string, string]> = [
  ['package.json', 'javascript'],
  ['tsconfig.json', 'typescript'],
  ['pyproject.toml', 'python'],
  ['setup.py', 'python'],
  ['requirements.txt', 'python'],
  ['go.mod', 'go'],
  ['Cargo.toml', 'rust'],
  ['pom.xml', 'java'],
  ['build.gradle', 'java'],
  ['build.gradle.kts', 'kotlin'],
  ['Gemfile', 'ruby'],
  ['composer.json', 'php'],
  ['CMakeLists.txt', 'cpp'],
  ['Package.swift', 'swift'],
];

/**
 * Detect the primary language of a checkout. A JS manifest plus a tsconfig reads
 * as TypeScript, since that is what the code in it actually is.
 */
export function detectRepoLang(cwd: string): string | undefined {
  if (!cwd) return undefined;
  let found: string | undefined;
  for (const [file, lang] of MANIFESTS) {
    let exists = false;
    try {
      exists = fs.existsSync(path.join(cwd, file));
    } catch {
      exists = false;
    }
    if (!exists) continue;
    if (lang === 'typescript') return 'typescript';
    found ??= lang;
  }
  if (found === 'javascript') {
    // package.json with a "types"/"typescript" signal but no tsconfig at the root.
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')) as Record<string, unknown>;
      const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) };
      if ('typescript' in deps) return 'typescript';
    } catch {
      // Unreadable manifest — keep the weaker answer rather than inventing one.
    }
  }
  return found;
}

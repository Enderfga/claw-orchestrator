export interface PatchOp {
  // Only 'add' | 'replace' | 'remove' are implemented; applyOne() throws on any
  // other value at runtime (kept as string here because ops are built from
  // dynamic interview/delta input).
  op: string;
  path: string;
  value?: unknown;
}

export function applyPatch<T>(doc: T, ops: PatchOp[]): T {
  let next: unknown = deepClone(doc);
  for (const op of ops) {
    next = applyOne(next, op);
  }
  return next as T;
}

function applyOne(doc: unknown, op: PatchOp): unknown {
  const tokens = parsePath(op.path);
  if (tokens.length === 0) {
    if (op.op === 'replace' || op.op === 'add') return op.value;
    throw new Error(`unsupported root op ${op.op}`);
  }
  const last = tokens[tokens.length - 1];
  const parent = walk(doc, tokens.slice(0, -1));
  if (op.op === 'add' || op.op === 'replace') {
    setIn(parent, last, op.value);
    return doc;
  }
  if (op.op === 'remove') {
    removeIn(parent, last);
    return doc;
  }
  throw new Error(`unsupported op ${op.op}`);
}

// Segments that reach an object's prototype rather than its own data. Patches
// come from the interview model and from manual edits, and the spec they edit
// lives in the gateway process, so a path through these would change every
// object there.
const PROTOTYPE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function parsePath(path: string): string[] {
  if (path === '') return [];
  if (typeof path !== 'string' || !path.startsWith('/')) throw new Error(`bad path ${String(path)}`);
  const tokens = path
    .slice(1)
    .split('/')
    .map((t) => t.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const t of tokens) {
    if (PROTOTYPE_KEYS.has(t)) throw new Error(`path segment ${t} is not allowed`);
  }
  return tokens;
}

function walk(doc: unknown, tokens: string[]): unknown {
  let cur: unknown = doc;
  for (const t of tokens) {
    if (Array.isArray(cur)) {
      const i = t === '-' ? cur.length : Number(t);
      cur = cur[i];
    } else if (cur && typeof cur === 'object') {
      // Own properties only: an inherited one is not part of the document.
      cur = Object.hasOwn(cur, t) ? (cur as Record<string, unknown>)[t] : undefined;
    } else {
      throw new Error(`cannot walk into ${typeof cur} at ${t}`);
    }
  }
  return cur;
}

function setIn(parent: unknown, key: string, value: unknown): void {
  if (Array.isArray(parent)) {
    if (key === '-') parent.push(value);
    else parent.splice(Number(key), 0, value);
  } else if (parent && typeof parent === 'object') {
    (parent as Record<string, unknown>)[key] = value;
  } else {
    throw new Error(`cannot set into ${typeof parent}`);
  }
}

function removeIn(parent: unknown, key: string): void {
  if (Array.isArray(parent)) {
    parent.splice(Number(key), 1);
  } else if (parent && typeof parent === 'object') {
    delete (parent as Record<string, unknown>)[key];
  }
}

function deepClone<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

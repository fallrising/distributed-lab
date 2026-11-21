import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ADR-0001 D2: the simulation never reads the wall clock or unrecorded randomness.
const FORBIDDEN = ['Date', 'Math.random', 'performance', 'process.hrtime', 'setTimeout', 'setInterval', 'crypto'];
const EXEMPT = new Set([join('src', 'checker', 'clock.ts')]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

test('src/ contains no wall-clock or unrecorded randomness APIs (ADR-0001 D2)', () => {
  const hits: string[] = [];
  for (const file of walk('src')) {
    if (EXEMPT.has(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const word of FORBIDDEN) {
      const re = new RegExp(`\\b${word.replace('.', '\\.')}\\b`);
      if (re.test(text)) hits.push(`${file}: ${word}`);
    }
  }
  assert.deepEqual(hits, []);
});

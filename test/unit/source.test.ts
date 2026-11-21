import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

test('data/scenarios.yaml matches data/SOURCE.json (ADR-0001 D12)', () => {
  const source = JSON.parse(readFileSync('data/SOURCE.json', 'utf8')) as { local_path: string; bytes: number; sha256: string };
  const bytes = readFileSync(source.local_path);
  assert.equal(bytes.length, source.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
});

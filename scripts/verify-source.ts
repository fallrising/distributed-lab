// Byte-for-byte comparison of data/scenarios.yaml against the pinned specs commit (ADR-0001 D12).
// Runs in CI only; it needs network access to raw.githubusercontent.com.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

interface Source {
  repo: string;
  commit: string;
  path: string;
  local_path: string;
  bytes: number;
  sha256: string;
}

const source = JSON.parse(readFileSync('data/SOURCE.json', 'utf8')) as Source;
const local = readFileSync(source.local_path);
const url = `https://raw.githubusercontent.com/${source.repo}/${source.commit}/${source.path}`;
const response = await fetch(url);
if (!response.ok) {
  console.error(`verify-source: GET ${url} -> HTTP ${response.status}`);
  process.exit(1);
}
const remote = Buffer.from(await response.arrayBuffer());
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const problems: string[] = [];
if (!remote.equals(local)) problems.push('local copy differs from upstream bytes');
if (remote.length !== source.bytes) problems.push(`upstream length ${remote.length} != SOURCE.json bytes ${source.bytes}`);
if (sha(remote) !== source.sha256) problems.push(`upstream sha256 ${sha(remote)} != SOURCE.json sha256`);
if (problems.length > 0) {
  for (const p of problems) console.error(`verify-source: ${p}`);
  process.exit(1);
}
console.log(`verify-source: OK ${source.repo}@${source.commit}:${source.path} (${remote.length} bytes, sha256 ${source.sha256})`);

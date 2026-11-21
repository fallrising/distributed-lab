import { readFileSync } from 'node:fs';
import { parseScenarios, type Scenarios } from '../../src/scenarios/data.ts';

let cached: Scenarios | null = null;

/** The pinned specs copy (data/scenarios.yaml). Tests read values only from here. */
export function scenarios(): Scenarios {
  cached ??= parseScenarios(readFileSync('data/scenarios.yaml', 'utf8'));
  return cached;
}

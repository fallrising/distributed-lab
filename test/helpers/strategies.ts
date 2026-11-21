import type { Strategy } from '../../src/chooser.ts';

/**
 * ADR-0001 D5 "證據不只靠推導": min delay, max delay, all 32 fixed per-destination
 * delay combinations (1 or 2 for each of A–E), seed 5105 and 200 further fixed seeds.
 * This is sampled evidence, not an exhaustive proof.
 */
export function timingStrategies(members: readonly string[], replaySeed: number): Strategy[] {
  const out: Strategy[] = [{ type: 'min' }, { type: 'max' }];
  for (let mask = 0; mask < 1 << members.length; mask++) {
    const delays: Record<string, number> = {};
    members.forEach((m, i) => (delays[m] = mask & (1 << i) ? 2 : 1));
    out.push({ type: 'per-destination', delays });
  }
  out.push({ type: 'seed', seed: replaySeed });
  for (let s = 1; s <= 200; s++) out.push({ type: 'seed', seed: s });
  return out;
}

// Regenerates docs/teaching/index.html from the simulation (ADR-0002 E4). The AC-EXP-04 test fails when
// the committed page differs from a fresh render.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseScenarios } from '../src/scenarios/data.ts';
import { buildTeachingModel, renderTeachingHtml } from '../src/teaching/page.ts';

const data = parseScenarios(readFileSync('data/scenarios.yaml', 'utf8'));
writeFileSync('docs/teaching/index.html', renderTeachingHtml(buildTeachingModel(data)));
console.log('teaching: wrote docs/teaching/index.html');

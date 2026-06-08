#!/usr/bin/env node
// Consolidates the per-test root-cause inventory into a worklist of DISTINCT
// fixes, each with the tests it is expected to clear.
//
// Grouping:
//   1. line-cluster: findings in the same file within WINDOW lines = one fix
//      (separates e.g. compiler.ts:517 / :647 / :1571 but merges 165/166).
//   2. curated cross-file merges (CROSS_MERGE) join known shared causes that
//      span files (e.g. the rail-level ctrl contract across 3 drivers).
//
// Output: test-results/fix-list.md (+ .json), sorted by expected test count.
//
// Usage: node scripts/triage/build-fixlist.mjs [--dump]
//   --dump : print every cluster (key, count, sample diagnosis) and exit, for
//            authoring the curated maps below.

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WINDOW = 6;
const DUMP = process.argv.includes('--dump');

// ---- curated maps (authored from root-cause-synthesis.md) -----------------
// Each CROSS_MERGE entry: a canonical id + the member cluster keys (file:line,
// any line inside the cluster works) + a title. Members are merged into one fix.
const CROSS_MERGE = [
  { id: 'composite-leaf-givenness', title: 'Composite-leaf givenness: expandCompositeInstance marks leaf-model DEFAULT params as given (setModelParam) -> use markGiven:false. Agents flagged optocoupler.ts:54 and the diac diode.ts:913 0-step failures as the SAME cause (verify by re-run after the compiler fix).',
    members: ['src/solver/analog/compiler.ts:517', 'src/solver/analog/compiler.ts:295', 'src/components/active/optocoupler.ts:54', 'src/components/semiconductors/diode.ts:913'] },
  { id: 'real-opamp-raillim', title: 'RealOpAmp rail saturation never forms a converged fixed point (Jacobian swap vs railLim bisection)',
    members: ['src/components/active/real-opamp.ts:541', 'src/components/active/real-opamp.ts:485'] },
  { id: 'schmitt-rout-key', title: 'Schmitt netlist maps rOut Resistor with key R (caps with C) but Resistor/Capacitor keys are resistance/capacitance -> mapping never binds, rOut defaults to 1000',
    members: ['src/components/active/schmitt-trigger.ts:83', 'src/components/active/schmitt-trigger.ts:63'] },
  { id: 'driver-ctrl-contract', title: 'Drivers stamp rail-level vTarget onto ctrl_out but DigitalOutputPinLoaded re-applies rail span -> stamp normalized [0,1] level',
    members: ['src/components/active/comparator-driver.ts:193', 'src/components/active/comparator-pushpull-driver.ts:170', 'src/components/active/timer-555-latch-driver.ts:129'] },
  { id: 'comparator-latch-polarity', title: 'Inverted comparator latch polarity (sink when V+>V- instead of V+<V-)',
    members: ['src/components/active/comparator-driver.ts:165', 'src/components/active/comparator-pushpull-driver.ts:146'] },
  { id: 'adc-thresholder-midpoint', title: 'ADC driver treats 0.5V indeterminate clk_result as logic-high; must threshold above 0.5 midpoint',
    members: ['src/components/active/adc-driver.ts:235', 'src/components/active/adc-driver.ts:290'] },
];

// ---------------------------------------------------------------------------
const norm = (s) => (s || '').replace(/\\/g, '/');
const recs = readFileSync('test-results/root-cause-inventory.jsonl', 'utf8')
  .split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const byTest = new Map();
for (const r of recs) byTest.set(norm(r.file) + '::' + r.test, r);
const findings = [...byTest.values()];

// line-cluster each finding -> clusterKey
const fileLines = new Map(); // file -> sorted unique lines
for (const r of findings) {
  if (r.rootCauseLine == null || r.rootCauseFile == null) continue;
  const f = norm(r.rootCauseFile);
  if (!fileLines.has(f)) fileLines.set(f, new Set());
  fileLines.get(f).add(Number(r.rootCauseLine));
}
const clusterOf = new Map(); // `${file}:${line}` -> clusterKey (file:minLineOfCluster)
for (const [f, set] of fileLines) {
  const lines = [...set].sort((a, b) => a - b);
  let anchor = lines[0];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0 && lines[i] - lines[i - 1] > WINDOW) anchor = lines[i];
    clusterOf.set(`${f}:${lines[i]}`, `${f}:${anchor}`);
  }
}

// map a finding -> fix id (apply CROSS_MERGE)
const mergeLookup = new Map(); // clusterKey -> {id,title}
for (const m of CROSS_MERGE) {
  for (const member of m.members) {
    const ck = clusterOf.get(member) || member; // member is file:line -> its cluster
    mergeLookup.set(ck, m);
  }
}

function fixIdFor(r) {
  if (r.rootCauseLine == null || r.rootCauseFile == null) return { id: 'UNRESOLVED', title: 'Unresolved (no line localized)', cluster: null };
  const ck = clusterOf.get(`${norm(r.rootCauseFile)}:${Number(r.rootCauseLine)}`);
  const merged = mergeLookup.get(ck);
  if (merged) return { id: merged.id, title: merged.title, cluster: ck };
  return { id: ck, title: null, cluster: ck };
}

const fixes = new Map();
for (const r of findings) {
  const { id, title, cluster } = fixIdFor(r);
  if (!fixes.has(id)) fixes.set(id, { id, title, clusters: new Set(), tests: [], diagnoses: [], fixHints: [], confidences: [] });
  const fx = fixes.get(id);
  if (cluster) fx.clusters.add(cluster);
  fx.tests.push({ test: r.test, file: norm(r.file), category: r.category });
  if (r.diagnosis) fx.diagnoses.push(r.diagnosis);
  if (r.fixHint) fx.fixHints.push(r.fixHint);
  if (r.confidence) fx.confidences.push(r.confidence);
}

const ranked = [...fixes.values()].sort((a, b) => b.tests.length - a.tests.length);

if (DUMP) {
  for (const fx of ranked) {
    console.log(`${String(fx.tests.length).padStart(3)}  ${fx.id}`);
    console.log(`     dx: ${(fx.diagnoses[0] || '').slice(0, 140)}`);
  }
  console.log(`\nTOTAL fixes: ${ranked.length} | tests: ${findings.length}`);
  process.exit(0);
}

// emit markdown worklist
let md = `# Fix worklist\n\n`;
md += `${ranked.length} distinct fixes covering ${findings.length} failing tests `;
md += `(from root-cause-inventory.jsonl). Sorted by expected test payoff.\n\n`;

let n = 0;
for (const fx of ranked) {
  n++;
  const conf = mode(fx.confidences);
  const locs = [...fx.clusters].join(', ') || fx.id;
  md += `## ${n}. ${fx.title || (fx.diagnoses[0] || fx.id).slice(0, 110)}\n\n`;
  md += `- **Root cause:** \`${locs}\`\n`;
  md += `- **Expected to fix:** ${fx.tests.length} test(s) · confidence ${conf}\n`;
  if (fx.title) md += `- **Diagnosis:** ${(fx.diagnoses[0] || '').slice(0, 240)}\n`;
  md += `- **Fix hint:** ${(fx.fixHints[0] || '').slice(0, 240)}\n`;
  md += `- **Tests:**\n`;
  for (const t of fx.tests.sort((a, b) => a.file.localeCompare(b.file))) {
    md += `  - [ ] \`${t.file}\` — ${t.test}\n`;
  }
  md += `\n`;
}

writeFileSync(resolve('test-results/fix-list.md'), md);
writeFileSync(resolve('test-results/fix-list.json'), JSON.stringify(
  ranked.map((f) => ({ id: f.id, title: f.title, locations: [...f.clusters], testCount: f.tests.length, tests: f.tests, fixHint: f.fixHints[0] || '', diagnosis: f.diagnoses[0] || '' })), null, 2));
console.log(`wrote ${ranked.length} fixes -> test-results/fix-list.md`);

function mode(arr) {
  if (!arr.length) return '?';
  const c = {}; for (const x of arr) c[x] = (c[x] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
}

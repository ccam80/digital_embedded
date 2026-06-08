// Clustering pass over docs/triage/fix-list.json.
//
// Goal: collapse the 72 nominal engine-fix items into the actual number of
// shared-root HUBS, so we can see the real size of the problem before fanning
// out. Read-only analysis — writes a markdown report, changes no source.
//
// Method: union-find connected components over three edge types between items:
//   (1) share a source file   (locations, line stripped)
//   (2) share a NON-generic test file (the cross-cutting comparison-session*
//       harness files are excluded — they touch ~everything and would merge all)
//   (3) share a root-cause THEME keyword AND a source directory
// Connected components ≈ candidate hubs.

import { readFileSync, writeFileSync } from 'node:fs';

const items = JSON.parse(readFileSync('docs/triage/fix-list.json', 'utf8'));

// current failing set (keyed file::test) so we can score REMAINING work, not
// the stale pre-fix test counts. An item with 0 still-failing tests is resolved.
const norm = (s) => (s || '').replace(/\\/g, '/');
const failing = new Set(readFileSync('docs/triage/vitest-baseline.txt', 'utf8')
  .split('\n').filter((l) => l.trim()));
const openCount = (it) => (it.tests || [])
  .filter((t) => failing.has(norm(t.file) + '::' + t.test)).length;
for (const it of items) it._open = openCount(it);

// --- generic test files that must NOT create edges (cross-cutting parity hubs)
const GENERIC_TEST = /comparison-session(-asserts)?\.ts$/;

// --- engine-substrate source files: cited by MANY unrelated roots, so a shared
// substrate file alone is NOT a root link. It only bridges when the two items
// ALSO share a theme (e.g. both opamp-convergence in analog-engine.ts).
const SUBSTRATE = new Set([
  'src/solver/analog/analog-engine.ts',
  'src/solver/analog/compiler.ts',
  'src/solver/coordinator.ts',
  'src/solver/analog/dc-operating-point.ts',
  'src/solver/analog/timestep.ts',
  'src/solver/analog/sparse-solver.ts',
  'src/solver/analog/ckt-context.ts',
  'src/solver/analog/ckt-terr.ts',
  'src/solver/analog/ckt-load.ts',
]);

// --- root-cause theme keywords (signal terms, not prose). Order = priority.
const THEMES = [
  ['param-instantiation', /\b(given(ness)?|setModelParam|markGiven|isModelParamGiven|default param|hasModelParam|modelEntryDefaults|paramDef)/i],
  ['digital-level-contract', /\b(normalized|\[0,?1\]|rail-level|vTarget|logic level|stamp.*(level|ctrl)|ctrl_out)/i],
  ['digital-threshold', /\b(threshold|dead-?band|vIH|vIL|midpoint|classif)/i],
  ['opamp-convergence', /\b(rail saturation|railLim|Jacobian|bisection|converge|fixed point|discontinu)/i],
  ['temperature', /\b(TEMP|TNOM|REFTEMP|thermal|CONSTCtoK|kelvin|temperature)/i],
  ['deck-emission', /\b(deck|\.model|emit|emission|instance line|spiceConverter|netlist-generator)/i],
  ['numeric-ulp', /\b(1-?ULP|ulp|accumulation order|stamp order|shared diagonal|bit-exact|truncated)/i],
  ['node-mapping', /\b(node[- ]?mapping|topology|nan|node id|allocation order|TSTALLOC)/i],
  ['schema-partial', /\b(schema|partial|subset|variant|superset)/i],
  ['state-pool', /\b(state pool|slot|StatePool|SLOT_|accept\(\)|history)/i],
  ['integration-tran', /\b(integration|trapezoidal|gear|predictor|LTE|timestep|dt collapse|transient)/i],
];

function srcFiles(it) {
  return [...new Set((it.locations || []).map((l) => l.replace(/:\d+.*$/, '')))];
}
function srcDirs(it) {
  return [...new Set(srcFiles(it).map((f) => f.split('/').slice(0, -1).join('/')))];
}
function testFiles(it) {
  return [...new Set((it.tests || []).map((t) => t.file).filter((f) => f && !GENERIC_TEST.test(f)))];
}
function themesOf(it) {
  const hay = `${it.title || ''} ${it.diagnosis || ''} ${it.fixHint || ''} ${(it.locations || []).join(' ')}`;
  return THEMES.filter(([, re]) => re.test(hay)).map(([name]) => name);
}
function categories(it) {
  return [...new Set((it.tests || []).map((t) => t.category).filter(Boolean))];
}

// annotate
for (const it of items) {
  it._src = srcFiles(it);
  it._dirs = srcDirs(it);
  it._tests = testFiles(it);
  it._themes = themesOf(it);
  it._cats = categories(it);
}

// cluster all fix-list items (no disposition split — that field was scrubbed)
const engine = items;

// union-find
const parent = new Map(engine.map((it) => [it.id, it.id]));
const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };

// test-file frequency across engine items: a test file shared by exactly 2
// items is a specific co-occurrence (likely same root); shared by >2 it is a
// multi-root test file (noise).
const testFreq = {};
for (const it of engine) for (const f of it._tests) testFreq[f] = (testFreq[f] || 0) + 1;

for (let i = 0; i < engine.length; i++) {
  for (let j = i + 1; j < engine.length; j++) {
    const a = engine[i], b = engine[j];
    const sharedSrc = a._src.filter((f) => b._src.includes(f));
    // non-substrate source file shared -> real component-family link
    const shareCompFile = sharedSrc.some((f) => !SUBSTRATE.has(f));
    // substrate file shared -> link only if a theme is also shared
    const shareSubstrateTheme = sharedSrc.some((f) => SUBSTRATE.has(f))
      && a._themes.some((t) => b._themes.includes(t));
    // specific test co-occurrence (exactly 2 items touch that test file)
    const shareSpecificTest = a._tests.some((f) => b._tests.includes(f) && testFreq[f] === 2);
    if (shareCompFile || shareSubstrateTheme || shareSpecificTest) union(a.id, b.id);
  }
}

// gather components
const comps = new Map();
for (const it of engine) {
  const r = find(it.id);
  if (!comps.has(r)) comps.set(r, []);
  comps.get(r).push(it);
}
const sumOpen = (c) => c.reduce((s, i) => s + i._open, 0);
const clusters = [...comps.values()].sort((a, b) => sumOpen(b) - sumOpen(a));

// theme tally for a cluster
function clusterThemes(c) {
  const t = {};
  for (const it of c) for (const th of it._themes) t[th] = (t[th] || 0) + 1;
  return Object.entries(t).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`);
}
function clusterDirs(c) {
  const d = {};
  for (const it of c) for (const dir of it._dirs) d[dir] = (d[dir] || 0) + 1;
  return Object.entries(d).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} (${v})`);
}

// --- report
const out = [];
out.push('# Fix-list clustering — shared-root hubs\n');
out.push(`${engine.length} fix-list items → **${clusters.length} connected-component clusters**.\n`);
out.push('Edges: shared source file · shared theme + substrate file · shared 2-item test file.');
out.push('Clusters sorted by remaining (open) test payoff.\n');

const multi = clusters.filter((c) => c.length > 1);
const singles = clusters.filter((c) => c.length === 1);
out.push(`**${multi.length} multi-item hubs**, **${singles.length} singletons**.\n`);

let n = 0;
for (const c of clusters) {
  n++;
  const tests = c.reduce((s, i) => s + i.testCount, 0);
  const open = sumOpen(c);
  const openItems = c.filter((i) => i._open > 0).length;
  const tag = c.length > 1 ? 'HUB' : 'singleton';
  out.push(`\n## Cluster ${n} [${tag}] — ${openItems}/${c.length} item(s) open · ${open}/${tests} tests still failing`);
  out.push(`- themes: ${clusterThemes(c).join(', ') || '(none matched)'}`);
  out.push(`- dirs: ${clusterDirs(c).join(', ')}`);
  for (const it of c.sort((a, b) => b._open - a._open || b.testCount - a.testCount)) {
    const st = it._open === 0 ? 'DONE' : it._open < it.testCount ? 'PARTIAL' : 'OPEN';
    const hint = (it.fixHint || it.title || '').replace(/\s+/g, ' ').slice(0, 140);
    out.push(`  - **[${st}] (${it._open}/${it.testCount}t)** \`${it.id}\``);
    out.push(`    - ${hint}`);
  }
}

writeFileSync('docs/triage/fix-clusters.md', out.join('\n') + '\n');

// console summary (REMAINING work — open tests against the live baseline)
const openClusters = clusters.filter((c) => sumOpen(c) > 0);
const totalOpen = engine.reduce((s, i) => s + i._open, 0);
const doneItems = engine.filter((i) => i._open === 0).length;
console.log(`fix-list items: ${engine.length}  (resolved: ${doneItems}, still-open: ${engine.length - doneItems})`);
console.log(`total open tests: ${totalOpen}`);
console.log(`clusters with open work: ${openClusters.length}  (of ${clusters.length} total)`);
console.log('\nOpen hubs/singletons by REMAINING test payoff:');
for (const c of openClusters.slice(0, 16)) {
  const tag = c.length > 1 ? `HUB×${c.length}` : 'single';
  console.log(`  ${String(sumOpen(c)).padStart(2)} tests  ${tag.padEnd(7)}  [${clusterThemes(c).slice(0, 2).join(', ') || '—'}]  ${clusterDirs(c)[0] || ''}`);
}
console.log('\nwrote docs/triage/fix-clusters.md');

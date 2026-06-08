#!/usr/bin/env node
// Failure triage classifier.
//
// Reads the vitest failure dump and buckets every failure into a category from
// an ordered ruleset (first match wins). Each category carries a remedy-class
// tag (the shared vocabulary) and an investigation entrypoint, so the report is
// both an inventory and a routing table for the root-cause workflow.
//
// Usage:
//   node scripts/triage/classify-failures.mjs [path-to-failures.json]
// Defaults to .vitest-failures.json. Writes:
//   test-results/failure-triage.json   (machine-readable buckets)
//   test-results/failure-triage.md     (human report)
//
// Coverage is self-checking: any failure that matches no rule lands in
// UNCATEGORIZED, which the report surfaces loudly. The taxonomy cannot silently
// under-count.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Remedy-class vocabulary (the "language"). Every category maps to exactly one.
// ---------------------------------------------------------------------------
const REMEDY = {
  INFRA:      'Test-harness / generator gap. Fix the harness or test scaffold, not the engine.',
  SCHEMA:     'Pin / topology / registry drift. Reconcile the component schema (pinLayout vs getPins vs netlist).',
  BINDING:    'Hot-load setParam not threaded to stamp/state. Wire the param through; verify observable in transient.',
  ENGINE_NUM: 'Genuine numerical divergence vs ngspice (arithmetic-order or structural). Drive to bit-exact via harness; escalate if architectural.',
  ENGINE_NAN: 'NaN / Inf produced in solve or seeding. Trace first non-finite via harness; fix the producing stamp.',
  BEHAV:      'Behavioral driver stamp / loaded-pin voltage model. Fix the driver control-stamp or divider math.',
  DIGITAL:    'Digital component logic / sequential state (LFSR, PLD, memory, flip-flop, bus).',
  STATE:      'StatePool s0/s1 invariant or rollback-state invariant. Fix history capture at bottom of load().',
  TESTBUG:    'Assertion or fixture itself is suspect. Confirm against documented behaviour before weakening (never weaken to go green).',
};

// ---------------------------------------------------------------------------
// Ordered ruleset. First match wins, so put specific signatures before general.
// `m` matches the failure message; `f` matches the (forward-slashed) file path.
// Both, if present, must match. `min`/`max` gate on parsed absDelta when present.
// ---------------------------------------------------------------------------
const RULES = [
  // --- Schema / registry drift -------------------------------------------
  { code: 'SCHEMA-DIODE-TJ', remedy: 'SCHEMA',
    f: /registry\.test\.ts$/, m: /to be 3|'Tj'/,
    why: 'Diode pinLayout declares a thermal pin (A,K,Tj) but getPins returns 2 — schema source-of-truth split. Likely upstream of several diode-family parity failures.',
    entry: 'src/core/__tests__/registry.test.ts:891; reconcile Diode pinLayout vs getPins vs model registry.' },

  // --- Harness / generator infra (T3 suite-setup gaps) -------------------
  { code: 'INFRA-NETLISTGEN', remedy: 'INFRA',
    f: /netlist-generator\.ts$/,
    why: 'T3 SPICE-deck generator cannot emit a device/subcircuit (missing ELEMENT_SPECS entry, unmapped subcircuit port, non-linear E/F/G/H). Suite-setup aborts before any comparison runs.',
    entry: 'src/solver/analog/__tests__/harness/netlist-generator.ts — add the spec/port mapping.' },
  { code: 'INFRA-NOSTEPS', remedy: 'INFRA',
    m: /Step out of range: 0/,
    why: 'DCOP comparison produced zero steps to index — the harness ran but captured nothing.',
    entry: 'src/solver/analog/__tests__/harness/comparison-session.ts:1383 — why did the run yield 0 steps.' },
  { code: 'INFRA-PAIRED-DISABLED', remedy: 'INFRA',
    m: /pairedSpiceEquivalent: false/,
    why: 'Test requests a paired-vs-ngspice run on a component that declares pairedSpiceEquivalent:false. Either the declaration or the test tier is wrong.',
    entry: 'comparison-session.ts:814 — reconcile component flag with test intent (AnalogFuse).' },
  { code: 'CRASH-MUTUAL-IND', remedy: 'INFRA',
    f: /mutual-inductor\.ts$/, m: /reading 'inductance'/,
    why: "Transformer temp-sweep T3 dereferences undefined coupled-inductor state — a crash in setup, not a numerical gap.",
    entry: 'src/components/passives/mutual-inductor.ts:250.' },
  { code: 'CRASH-BUILDER', remedy: 'INFRA',
    f: /headless\/builder\.ts$/,
    why: 'Embedded/external Testcase path or multi-output pin addressing throws during build (labelSignalMap undefined; Pin not found).',
    entry: 'src/headless/builder.ts:345/448.' },
  { code: 'PARSE-TESTCASE', remedy: 'INFRA',
    f: /testing\/parser\.ts$/,
    why: 'Multi-Testcase vector parser rejects a header value.',
    entry: 'src/testing/parser.ts:586.' },
  { code: 'MCP-SURFACE', remedy: 'INFRA',
    f: /scripts\\mcp\\__tests__|scripts\/mcp\/__tests__/,
    why: 'MCP formatter / export contract regression (category undefined; export size 0).',
    entry: 'scripts/mcp/__tests__/*.test.ts.' },

  // --- Structural matrix divergence (topology, not arithmetic) -----------
  { code: 'STRUCT-MATRIX-EQCOUNT', remedy: 'ENGINE_NUM',
    m: /Matrix structural divergence \(A1\)|equation counts differ/,
    why: 'Composite device emits a different number of MNA equations than the ngspice deck — node/branch allocation count mismatch.',
    entry: 'harness_topology_diff on the failing fixture; compare composite-internal node allocation vs ngspice deck order.' },
  { code: 'STRUCT-MATRIX-ENTRY', remedy: 'ENGINE_NUM',
    m: /Matrix-entry (structural|value) divergence/,
    why: 'Jacobian cell set or value diverges at iter 0 — per-device setup TSTALLOC order or stamp target.',
    entry: 'harness_matrix_diff -> firstDivergentStep; check the device setup() allocElement order vs ngspice <dev>setup.c.' },

  // --- NaN / non-finite ---------------------------------------------------
  { code: 'NAN-OURS', remedy: 'ENGINE_NAN',
    m: /ours=NaN/,
    why: 'digiTS produced NaN at a node/branch — a non-finite stamp or seed on our side.',
    entry: 'harness_first_divergence -> voltage; harness_get_attempt at that (step,iter) sliced to the NaN row.' },
  { code: 'NAN-NGSPICE-STATE', remedy: 'INFRA',
    m: /ngspice=NaN/,
    why: 'ngspice-side state slot reads NaN where ours is finite (e.g. QTH thermal slot, CLOSED, VD) — usually an unmapped/uninstrumented ngspice state, i.e. a harness mapping gap rather than an engine bug.',
    entry: 'harness_describe state map; confirm the slot is actually populated on the ngspice side.' },
  { code: 'NAN-GENERIC', remedy: 'ENGINE_NAN',
    m: /\bNaN\b/,
    why: 'Assertion saw NaN/Inf (init, limiting, or DCOP) without an explicit ours=/ngspice= tag.',
    entry: 'Reproduce headless; locate the first non-finite in the named quantity.' },
  { code: 'INF-VALUE', remedy: 'ENGINE_NAN',
    m: /\bInfinity\b/,
    why: 'Infinity in a computed quantity (timestep, scaled current).',
    entry: 'Trace the divide-by-zero / unbounded term.' },

  // --- Per-iteration parity divergence vs ngspice (split by magnitude) ----
  { code: 'PAIR-ITER-LARGE', remedy: 'ENGINE_NUM',
    m: /per-iteration divergence/, min: 1e-6,
    why: 'Per-NR-iteration node/branch value diverges from ngspice by a large margin — a genuine model/stamp/limiting bug.',
    entry: 'harness_first_divergence then harness_get_attempt at step0/iter0 on the named node.' },
  { code: 'PAIR-ITER-SMALL', remedy: 'ENGINE_NUM',
    m: /per-iteration divergence/,
    why: 'Per-iteration divergence at small magnitude (<1e-6). Per project policy the libm shim removed ULP noise, so this is arithmetic-order or accumulation order, not tolerance.',
    entry: 'Check load() accumulation order on shared diagonal vs ngspice (CLAUDE.md sparse-solver note).' },

  // --- transient_step_end paired asserts (non-NaN) -----------------------
  { code: 'PAIR-STEPEND', remedy: 'ENGINE_NUM',
    f: /comparison-session-asserts\.ts$/, m: /^step \d/,
    why: 'transient step-end node/dt/state assert diverges from ngspice (NaN cases already split out above).',
    entry: 'harness_first_divergence on the fixture; identify the divergent class.' },

  // --- Hot-load param produced ZERO observable delta ---------------------
  { code: 'BINDING-HOTLOAD-NOOP', remedy: 'BINDING',
    m: /to not be close to .*difference is 0,/,
    why: 'setParam on a model param produced no change in the observed quantity — the param is not threaded to the stamp/state (hot-load binding gap).',
    entry: 'Component model: confirm the param is read in load()/stamp each step, not cached at setup().' },

  // --- Behavioral drivers / loaded-pin voltage ---------------------------
  { code: 'BEHAV-DRIVER', remedy: 'BEHAV',
    f: /behavioral-(combinational|gate|sequential|flipflop)\.test\.ts$|(component-local|gate)-driver-ctrl-stamp\.test\.ts$/,
    why: 'Behavioral driver control-stamp or loaded-pin divider voltage is wrong (vOH/vOL/rOut/threshold).',
    entry: 'src/solver/analog/behavioral-drivers/* control-stamp; check vOH/rOut divider and threshold handling.' },

  // --- LTE / timestep numerics -------------------------------------------
  { code: 'LTE-CKTTERR', remedy: 'ENGINE_NUM',
    f: /ckt-terr\.test\.ts$/,
    why: 'LTE timestep (cktTerr) formula mismatch — last-digit and Infinity cases against ngspice CKTterr.',
    entry: 'src/solver/analog/* cktTerr vs ref/ngspice CKTtrunc / CKTterr.' },
  { code: 'RLC-TRANSIENT', remedy: 'ENGINE_NUM',
    f: /rlc-lte-path\.test\.ts$|mna-end-to-end\.test\.ts$/,
    why: 'RC/RL transient or DC steady-state accuracy outside bound.',
    entry: 'Reproduce headless; compare against analytic + ngspice.' },

  // --- State pool / rollback invariants ----------------------------------
  { code: 'STATE-POOL', remedy: 'STATE',
    f: /state-pool\.test\.ts$/,
    why: 'StatePool s0/s1 slot-for-slot invariant after accepted step (last-ULP).',
    entry: 'Bottom-of-load() history copy: s0[X]=... reading s1[X].' },
  { code: 'STATE-ROLLBACK', remedy: 'STATE',
    m: /lte_rollback|to be defined/,
    why: 'LTE-rollback state invariant or seeded op-point slot missing/undefined after rejection.',
    entry: 'Component rollback path + pool slot schema.' },
  { code: 'STATE-CONVREG', remedy: 'STATE',
    f: /convergence-regression\.test\.ts$/,
    why: 'statePool state1 not updated / RC stability regression.',
    entry: 'src/solver/analog/__tests__/convergence-regression.test.ts.' },

  // --- Newton-Raphson harness / nodeset ----------------------------------
  { code: 'NR-SUITE-CRASH', remedy: 'INFRA',
    m: /No test found in suite/,
    why: 'NR suite-setup threw, so the suite registered zero tests.',
    entry: 'src/solver/analog/__tests__/newton-raphson.test.ts suite-setup.' },
  { code: 'NR-NODESET', remedy: 'ENGINE_NUM',
    f: /nr-nodeset-parity\.test\.ts$/,
    why: 'digiTS ignores .nodeset; ngspice honours it and settles a different (latch) operating point.',
    entry: 'NR nodeset / .ic application path vs ngspice.' },
  { code: 'NR-CONVERGE', remedy: 'ENGINE_NUM',
    f: /newton-raphson\.test\.ts$/,
    why: 'NR iteration-count / convergence expectation off.',
    entry: 'newton-raphson.test.ts.' },

  // --- Digital component logic -------------------------------------------
  { code: 'DIGITAL-LFSR', remedy: 'DIGITAL',
    f: /arithmetic-utils\.test\.ts$/,
    why: 'LFSR seed/shift (se/ne) does not seed or advance R as expected.',
    entry: 'src/components/arithmetic/* LFSR seed path.' },
  { code: 'DIGITAL-PLD', remedy: 'DIGITAL',
    f: /pld\.test\.ts$/,
    why: 'PLD diode array digital drive / blown-fuse behaviour wrong.',
    entry: 'src/components/pld/*.' },
  { code: 'DIGITAL-MEM', remedy: 'DIGITAL',
    f: /program-counter\.test\.ts$|two-phase-memory\.test\.ts$|bus-resolution\.ts$|graphic-card\.test\.ts$/,
    why: 'Memory / program-counter / bus-resolution / graphics digital state.',
    entry: 'respective component under src/components.' },

  // --- Timing diagram / runtime ------------------------------------------
  { code: 'RUNTIME-TIMING', remedy: 'DIGITAL',
    f: /timing-diagram\.test\.ts$/,
    why: 'Timing-diagram snapshot id / closest-snapshot restoration.',
    entry: 'src/runtime/__tests__/timing-diagram.test.ts.' },
  { code: 'WIRE-CURRENT', remedy: 'BEHAV',
    f: /wire-current-resolver\.test\.ts$/,
    why: 'Wire current split at junction / KCL not satisfied.',
    entry: 'src/editor/* wire current resolver.' },

  // --- Monte Carlo / RNG -------------------------------------------------
  { code: 'MC-RNG', remedy: 'ENGINE_NUM',
    f: /monte-carlo\.test\.ts$/,
    why: 'Monte Carlo sweep / RNG distribution / output statistics.',
    entry: 'src/solver/analog/__tests__/monte-carlo.test.ts.' },

  // --- Sources -----------------------------------------------------------
  { code: 'SOURCE-NOISE', remedy: 'BEHAV',
    f: /ac-voltage-source\.ts$/,
    why: 'TRNOISE deterministic-waveform path vs extension noise engine.',
    entry: 'src/components/sources/ac-voltage-source.ts:513.' },
  { code: 'SPICE-IMPORT', remedy: 'INFRA',
    f: /spice-model-builder\.test\.ts$|spice-import-roundtrip-mcp\.test\.ts$/,
    why: 'SPICE import pin naming (A/B vs pos/neg) / param effect on import.',
    entry: 'src/io/* spice model builder.' },

  // --- Active / sensor component value (rail, threshold, near-voh) --------
  { code: 'ACTIVE-VALUE', remedy: 'BEHAV',
    f: /(comparator|comparator-rollback|schmitt-trigger|real-opamp|real-opamp-raillim|timer-555|timer-555-debug|opamp|ota|ccvs|vccs|dac|adc|analog-clock)\.test\.ts$/,
    why: 'Active-device output value wrong (rail clamp / near-VOH / threshold / divider) — value present but off.',
    entry: 'respective component model; many are rail/threshold or divider math.' },
  { code: 'SENSOR-STATE', remedy: 'BEHAV',
    f: /(spark-gap|spark-gap-rollback|adc|ntc-thermistor-rollback|monoflop)\.test\.ts$/,
    why: 'Sensor / mono-stable state machine (fire/extinguish/trigger) wrong.',
    entry: 'respective component under src/components/sensors|flipflops.' },

  // --- Generic paired DCOP false (catch remaining component parity) -------
  { code: 'PAIR-DCOP-FALSE', remedy: 'ENGINE_NUM',
    m: /expected false to be true/,
    why: 'Component dcop_paired_* / init / limiting boolean assert failed — paired-vs-ngspice DCOP mismatch.',
    entry: 'harness_start on the fixture; harness_first_divergence.' },

  // --- Remaining close-to value mismatches in component tests ------------
  { code: 'COMPONENT-VALUE', remedy: 'BEHAV',
    f: /components\\.*__tests__|components\/.*__tests__|solver\\analog\\__tests__|solver\/analog\/__tests__/,
    why: 'Component/solver value assertion off (not zero-delta, not NaN, not paired-bool). Needs per-case triage.',
    entry: 'Reproduce headless; compare expected vs actual.' },
];

// ---------------------------------------------------------------------------
function parseAbsDelta(msg) {
  const m = msg.match(/absDelta=([0-9.eE+-]+)/);
  if (m) { const v = Number(m[1]); if (Number.isFinite(v)) return v; }
  // "difference is X" form
  const d = msg.match(/difference is ([0-9.eE+-]+)/);
  if (d) { const v = Number(d[1]); if (Number.isFinite(v)) return v; }
  return null;
}

function classify(failure) {
  const msg = failure.message || '';
  const file = (failure.locations?.[0]?.file || '').replace(/\\/g, '/');
  const absDelta = parseAbsDelta(msg);
  for (const r of RULES) {
    if (r.m && !r.m.test(msg)) continue;
    if (r.f && !r.f.test(file) && !r.f.test(failure.locations?.[0]?.file || '')) continue;
    if (r.min != null) { if (absDelta == null || absDelta < r.min) continue; }
    if (r.max != null) { if (absDelta == null || absDelta > r.max) continue; }
    return r;
  }
  return null;
}

// ---------------------------------------------------------------------------
const inPath = resolve(process.argv[2] || '.vitest-failures.json');
const data = JSON.parse(readFileSync(inPath, 'utf8'));
const failures = data.failures || [];

const buckets = new Map();
let totalCount = 0;
const uncategorized = [];

for (const fl of failures) {
  const n = fl.count || fl.locations?.length || 1;
  totalCount += n;
  const rule = classify(fl);
  if (!rule) { uncategorized.push(fl); continue; }
  if (!buckets.has(rule.code)) buckets.set(rule.code, { rule, count: 0, groups: 0, items: [] });
  const b = buckets.get(rule.code);
  b.count += n; b.groups += 1;
  b.items.push({ message: fl.message, count: n, files: [...new Set((fl.locations || []).map(l => l.file))] });
}
for (const fl of uncategorized) {
  if (!buckets.has('UNCATEGORIZED')) buckets.set('UNCATEGORIZED', { rule: { code: 'UNCATEGORIZED', remedy: '?', why: 'No rule matched.', entry: 'Add a rule.' }, count: 0, groups: 0, items: [] });
  const b = buckets.get('UNCATEGORIZED');
  const n = fl.count || 1;
  b.count += n; b.groups += 1;
  b.items.push({ message: fl.message, count: n, files: [...new Set((fl.locations || []).map(l => l.file))] });
}

const sorted = [...buckets.values()].sort((a, b) => b.count - a.count);

// Roll up by remedy class
const byRemedy = new Map();
for (const b of sorted) {
  const k = b.rule.remedy;
  byRemedy.set(k, (byRemedy.get(k) || 0) + b.count);
}

// ---------------------------------------------------------------------------
mkdirSync(resolve('test-results'), { recursive: true });
writeFileSync(resolve('test-results/failure-triage.json'),
  JSON.stringify({ source: inPath, summary: data.summary, totalClassified: totalCount,
    byRemedy: Object.fromEntries(byRemedy),
    categories: sorted.map(b => ({ code: b.rule.code, remedy: b.rule.remedy, count: b.count, groups: b.groups, why: b.rule.why, entry: b.rule.entry, items: b.items })) }, null, 2));

let md = `# Failure triage\n\n`;
md += `Source: \`${inPath}\`\n`;
if (data.summary) md += `Suite: ${data.summary.failed} failed / ${data.summary.passed} passed across ${data.summary.totalFiles} files (${data.summary.durationSeconds}s)\n`;
md += `Classified failures (sum of counts): **${totalCount}**\n\n`;

md += `## By remedy class\n\n| Remedy | Count | Meaning |\n|---|---:|---|\n`;
for (const [k, v] of [...byRemedy.entries()].sort((a,b)=>b[1]-a[1])) {
  md += `| \`${k}\` | ${v} | ${REMEDY[k] || ''} |\n`;
}

md += `\n## By category (first-match-wins ruleset order)\n\n`;
md += `| # | Code | Remedy | Count | Groups |\n|---:|---|---|---:|---:|\n`;
sorted.forEach((b, i) => {
  md += `| ${i+1} | \`${b.rule.code}\` | \`${b.rule.remedy}\` | ${b.count} | ${b.groups} |\n`;
});

md += `\n## Category detail\n\n`;
for (const b of sorted) {
  md += `### \`${b.rule.code}\` — ${b.count} failures (${b.groups} signatures) · remedy \`${b.rule.remedy}\`\n\n`;
  md += `**Hypothesis:** ${b.rule.why}\n\n`;
  md += `**Investigation entrypoint:** ${b.rule.entry}\n\n`;
  md += `Files: ${[...new Set(b.items.flatMap(it => it.files))].map(f => '`'+f+'`').join(', ')}\n\n`;
  md += `<details><summary>${b.items.length} message signatures</summary>\n\n`;
  for (const it of b.items.sort((a,c)=>c.count-a.count)) {
    md += `- (${it.count}) ${it.message.slice(0, 160).replace(/\n/g,' ')}\n`;
  }
  md += `\n</details>\n\n`;
}

writeFileSync(resolve('test-results/failure-triage.md'), md);
console.log(`Classified ${totalCount} failures into ${sorted.length} categories.`);
console.log(`Uncategorized: ${buckets.get('UNCATEGORIZED')?.count || 0}`);
console.log('\nBy remedy class:');
for (const [k, v] of [...byRemedy.entries()].sort((a,b)=>b[1]-a[1])) console.log(`  ${k.padEnd(11)} ${v}`);
console.log('\nTop categories:');
sorted.slice(0, 40).forEach(b => console.log(`  ${String(b.count).padStart(4)}  ${b.rule.code.padEnd(24)} ${b.rule.remedy}`));
console.log('\nWrote test-results/failure-triage.md and .json');

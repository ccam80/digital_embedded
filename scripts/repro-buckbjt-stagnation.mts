/**
 * Scratch reproducer: buckbjt.dts transient stagnation with convergence log.
 * DO NOT COMMIT. Run: npx tsx scripts/repro-buckbjt-stagnation.mts
 *
 * Enables the convergence log BEFORE stepping, then runs until the
 * coordinator throws the stagnation error (or until we hit N steps).
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { DefaultSimulatorFacade } from '../src/headless/default-facade.js';
import { createDefaultRegistry } from '../src/components/register-all.js';
import { DefaultSimulationCoordinator } from '../src/solver/coordinator.js';
import { MNAEngine } from '../src/solver/analog/analog-engine.js';
import { EngineState } from '../src/core/engine-interface.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const registry = createDefaultRegistry();
const facade = new DefaultSimulatorFacade(registry);
const json = readFileSync(resolve(__dirname, '../fixtures/buckbjt.dts'), 'utf-8');
const circuit = facade.deserialize(json);
const coordinator = facade.compile(circuit) as DefaultSimulationCoordinator;

const analog = coordinator.getAnalogEngine() as MNAEngine;
if (!analog) {
  console.error('No analog engine');
  process.exit(1);
}

// Enable convergence log BEFORE any stepping per CLAUDE.md
// Replace internal log with a larger ring for post-mortem.
const { ConvergenceLog } = await import('../src/solver/analog/convergence-log.js');
(analog as any)._convergenceLog = new ConvergenceLog(4096);
analog.convergenceLog.enabled = true;

const dcOp = facade.getDcOpResult();
console.log('DC-OP converged:', dcOp?.converged, 'iters:', dcOp?.iterations);
console.log('initial currentDt=', (analog as any).currentDt, 'simTime=', analog.simTime);
console.log('nodeCount=', (analog as any).compiled?.nodeCount, 'elementCount=', (analog as any).compiled?.elements?.length);

// Capture deltaOld + per-element charge slots after step 0, and the LTE inputs at step 1.
const timestep = (analog as any)._timestep;
const statePool = (analog as any).compiled.statePool;

const maxSteps = 2200;
let lastErr: Error | null = null;
let stepIdx = 0;
let snappedAfterStep0 = false;
try {
  for (stepIdx = 0; stepIdx < maxSteps; stepIdx++) {
    coordinator.step();
    if (!snappedAfterStep0) {
      snappedAfterStep0 = true;
      console.log('\nAfter step 0 accept:');
      console.log('  deltaOld=', timestep.deltaOld.slice(0, 4).map((x: number) => x.toExponential(3)).join(','));
      console.log('  currentDt(next proposed)=', timestep.currentDt.toExponential(3));
      console.log('  currentMethod=', timestep.currentMethod, 'order=', timestep.currentOrder);
      console.log('  simTime=', analog.simTime.toExponential(3));
      // Dump BJT element 1 state slots if present
      const el1 = (analog as any).compiled.elements[1];
      if (el1 && typeof el1.stateBaseOffset === 'number' && statePool) {
        const base = el1.stateBaseOffset;
        console.log(`  elem[1] base=${base} schema owner=${el1.stateSchema?.owner}`);
        console.log(`  elem[1] schema slots: ${el1.stateSchema?.slots?.slice?.(0, 40).map((s: any) => s.name).join(',')}`);
        // Dump charges if we recognize them
        const slots: any[] = el1.stateSchema?.slots ?? [];
        const nameIdx = (n: string) => slots.findIndex((s: any) => s.name === n);
        for (const name of ['Q_BE', 'Q_BC', 'CCAP_BE', 'CCAP_BC', 'V_BE', 'V_BC', 'CTOT_BE', 'CTOT_BC']) {
          const i = nameIdx(name);
          if (i >= 0) {
            const s0 = statePool.states[0][base + i];
            const s1 = statePool.states[1][base + i];
            const s2 = statePool.states[2][base + i];
            const s3 = statePool.states[3][base + i];
            console.log(`    ${name}: s0=${s0?.toExponential?.(4)} s1=${s1?.toExponential?.(4)} s2=${s2?.toExponential?.(4)} s3=${s3?.toExponential?.(4)}`);
          }
        }
      }
      console.log('  firsttime flag (internal)=', (analog as any)._firsttime);
    }
    if (analog.getState() === EngineState.ERROR) {
      console.log(`Engine ERROR state at step ${stepIdx + 1}, simTime=${analog.simTime.toExponential(4)}`);
      break;
    }
  }
} catch (e) {
  lastErr = e as Error;
  console.log(`THROW at step ${stepIdx + 1}: ${lastErr.message}`);
}

console.log('Final simTime=', analog.simTime.toExponential(4), 'lastDt=', analog.lastDt.toExponential(4));
console.log('Engine state=', analog.getState());

// Dump last N convergence log records
const records = analog.convergenceLog.getAll();
const N = Math.min(records.length, 25);
console.log(`\nConvergence log: ${records.length} records. Dumping last ${N}:`);
for (let i = records.length - N; i < records.length; i++) {
  const r = records[i];
  const atts = r.attempts.map((a) => {
    return `{dt=${a.dt.toExponential(3)} ${a.method} iters=${a.iterations} conv=${a.converged} trig=${a.trigger} blame=${a.blameElement}/${a.blameNode}}`;
  }).join(', ');
  console.log(
    `step#${r.stepNumber} t=${r.simTime.toExponential(4)} entryDt=${r.entryDt.toExponential(3)} ` +
    `acceptDt=${r.acceptedDt.toExponential(3)} LTE=${r.lteWorstRatio.toFixed(2)} ` +
    `proposed=${r.lteProposedDt.toExponential(3)} rej=${r.lteRejected} outcome=${r.outcome} ` +
    `attempts=${r.attempts.length} [${atts}]`,
  );
}

// Element identity for blame indices
const elems2 = (analog as any).compiled.elements;
const blameCounts = new Map<number, number>();
for (const r of records) {
  for (const a of r.attempts) {
    if (a.blameElement >= 0) blameCounts.set(a.blameElement, (blameCounts.get(a.blameElement) ?? 0) + 1);
  }
}
console.log('\nBlame frequency (top 10):');
const sorted = [...blameCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
for (const [idx, count] of sorted) {
  const el = elems2[idx];
  console.log(`  elem[${idx}] ${el?.constructor?.name ?? '?'} pins=${el?.pinNodeIds?.join?.(',')} refDes=${el?.refDes ?? '?'} count=${count}`);
}

if (lastErr) process.exit(2);

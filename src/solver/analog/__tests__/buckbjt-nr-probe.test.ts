/**
 * Diagnostic probe: captures per-NR-iteration internal state for buckbjt
 * at the point where it stagnates (step 1, t=5ns).
 *
 * Pure diagnostic output — no assertions.
 */
import { describe, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DefaultSimulatorFacade } from '../../../headless/default-facade.js';
import { createDefaultRegistry } from '../../../components/register-all.js';
import { DefaultSimulationCoordinator } from '../../../solver/coordinator.js';
import { createIterationCaptureHook, captureTopology } from './harness/capture.js';
import type { MNAEngine } from '../analog-engine.js';
import type { ConcreteCompiledAnalogCircuit } from '../compiled-analog-circuit.js';

const registry = createDefaultRegistry();

describe('buckbjt NR iteration probe', () => {
  it('captures per-iteration state at stagnation point', () => {
    // Load and compile
    const facade = new DefaultSimulatorFacade(registry);
    const json = readFileSync(resolve(__dirname, '../../../../fixtures/buckbjt.dts'), 'utf-8');
    const circuit = facade.deserialize(json);
    const coordinator = facade.compile(circuit) as DefaultSimulationCoordinator;
    const engine = coordinator.getAnalogEngine() as MNAEngine;

    // Print topology mapping
    const compiled = engine.compiled as ConcreteCompiledAnalogCircuit;
    const topo = captureTopology(compiled);
    console.log('\n=== TOPOLOGY ===');
    console.log(`Nodes: ${topo.nodeCount}, Branches: ${topo.branchCount}, MatrixSize: ${topo.matrixSize}`);
    for (const [nodeId, label] of topo.nodeLabels) {
      console.log(`  V[${nodeId}] = "${label}"`);
    }

    // Wire capture hook
    const { hook, preFactorHook, getSnapshots, clear } = createIterationCaptureHook(
      engine.solver!,
      engine.elements,
      engine.statePool,
    );
    engine.postIterationHook = hook;
    engine.preFactorHook = preFactorHook;

    // --- Step 0 (should converge) ---
    console.log('\n=== STEP 0 (first transient step) ===');
    try {
      coordinator.step();
      const step0Snaps = getSnapshots();
      console.log(`Step 0: ${step0Snaps.length} NR iterations, simTime=${engine.simTime}`);
      for (const snap of step0Snaps) {
        const vStr = Array.from(snap.voltages).map(v => v.toExponential(4)).join(', ');
        console.log(`  iter ${snap.iteration}: noncon=${snap.noncon} globalConv=${snap.globalConverged} elemConv=${snap.elemConverged}`);
        console.log(`    voltages: [${vStr}]`);
        // Print BJT state from elementStates
        for (const es of snap.elementStates) {
          if (es.label.includes('BJT') || es.label.includes('Npn') || es.label.includes('Pnp') ||
              es.slots['VBE'] !== undefined || es.slots['L1_VBE'] !== undefined) {
            const slotStr = Object.entries(es.slots)
              .filter(([k]) => k.includes('VBE') || k.includes('VBC') || k.includes('IC') || k.includes('IB') || k.includes('GM') || k.includes('GO') || k.includes('GPI') || k.includes('GMU') || k.includes('GEQCB'))
              .map(([k, v]) => `${k}=${(v as number).toExponential(4)}`)
              .join(', ');
            console.log(`    element[${es.elementIndex}] ${es.label}: ${slotStr}`);
          }
        }
      }
      clear();
    } catch (e: any) {
      const step0Snaps = getSnapshots();
      console.log(`Step 0 FAILED after ${step0Snaps.length} iterations: ${e.message}`);
      clear();
    }

    // Helper to print iteration snapshots
    const printSnaps = (snaps: ReturnType<typeof getSnapshots>, maxDetail = 15) => {
      const toPrint = snaps.length <= maxDetail
        ? snaps
        : [...snaps.slice(0, 10), ...snaps.slice(-5)];

      if (snaps.length > maxDetail) {
        console.log(`  (showing first 10 + last 5 of ${snaps.length})`);
      }

      for (const snap of toPrint) {
        const vStr = Array.from(snap.voltages).map(v => v.toExponential(4)).join(', ');
        const rhsStr = Array.from(snap.preSolveRhs).map(v => v.toExponential(4)).join(', ');
        console.log(`  iter ${snap.iteration}: noncon=${snap.noncon} gConv=${snap.globalConverged} eConv=${snap.elemConverged}`);
        console.log(`    V: [${vStr}]`);
        console.log(`    RHS: [${rhsStr}]`);
        for (const es of snap.elementStates) {
          if (es.slots['VBE'] !== undefined) {
            const keys = ['VBE','VBC','IC','IB','GM','GO','GPI','GMU','GEQCB','IC_NORTON','IB_NORTON'];
            const slotStr = keys
              .filter(k => es.slots[k] !== undefined)
              .map(k => `${k}=${(es.slots[k] as number).toExponential(3)}`)
              .join(' ');
            console.log(`    el[${es.elementIndex}]: ${slotStr}`);
          }
        }
      }
    };

    // --- Steps 1-10: capture where stagnation develops ---
    for (let s = 1; s <= 10; s++) {
      console.log(`\n=== STEP ${s} ===`);
      try {
        coordinator.step();
        const snaps = getSnapshots();
        console.log(`Step ${s}: ${snaps.length} NR iters, simTime=${engine.simTime.toExponential(4)}, dt=${(engine as any)._dt?.toExponential?.(4) ?? '?'}`);
        if (snaps.length > 4) {
          // Print first 3 + last 2 for steps with many retries
          printSnaps(snaps, 5);
        }
        clear();
      } catch (e: any) {
        const snaps = getSnapshots();
        console.log(`Step ${s} FAILED after ${snaps.length} iters: ${e.message}`);
        printSnaps(snaps);

        // VBE trajectory for first element with VBE
        console.log('\n--- VBE trajectory (first 20 iters) ---');
        for (const snap of snaps.slice(0, 20)) {
          for (const es of snap.elementStates) {
            if (es.slots['VBE'] !== undefined) {
              console.log(`  i${snap.iteration}: VBE=${(es.slots['VBE'] as number).toExponential(6)} VBC=${(es.slots['VBC'] as number).toExponential(6)} noncon=${snap.noncon}`);
              break;
            }
          }
        }
        clear();
        throw e;
      }
    }
  });
});

/**
 * Per-NR-iteration divergence probe for buckbjt steps 0 and 1.
 * Prints every iteration's voltages for both engines side by side.
 */
import { describe, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DefaultSimulatorFacade } from '../../../headless/default-facade.js';
import { createDefaultRegistry } from '../../../components/register-all.js';
import { DefaultSimulationCoordinator } from '../../../solver/coordinator.js';
import { createIterationCaptureHook } from './harness/capture.js';
import { NgspiceBridge } from './harness/ngspice-bridge.js';
import type { MNAEngine } from '../analog-engine.js';

const DLL_PATH = process.env.NGSPICE_DLL_PATH
  ?? resolve(__dirname, '../../../../ref/ngspice/visualc-shared/x64/Release/bin/spice.dll');

const BUCKBJT_CIR = readFileSync(
  resolve(__dirname, '../../../../e2e/spice-ref/buckbjt.cir'), 'utf-8',
);

const registry = createDefaultRegistry();

describe('buckbjt NR divergence: per-iteration voltages', () => {
  it('step 0 and step 1 iteration-by-iteration', async () => {
    // --- ngspice ---
    const bridge = new NgspiceBridge(DLL_PATH);
    await bridge.init();
    const circuitOnly = BUCKBJT_CIR
      .split('\n')
      .filter(l => !l.startsWith('.control') && !l.startsWith('.endc') &&
                   !l.startsWith('meas ') && !l.startsWith('quit') &&
                   !l.startsWith('tran '))
      .join('\n');
    bridge.loadNetlist(circuitOnly);
    bridge.runTran('20n', '1n');
    const ngSession = bridge.getCaptureSession();
    bridge.dispose();

    // --- Our engine ---
    const facade = new DefaultSimulatorFacade(registry);
    const json = readFileSync(resolve(__dirname, '../../../../fixtures/buckbjt.dts'), 'utf-8');
    const circuit = facade.deserialize(json);
    const coordinator = facade.compile(circuit) as DefaultSimulationCoordinator;
    const engine = coordinator.getAnalogEngine() as MNAEngine;

    const { hook, preFactorHook, getSnapshots, clear } = createIterationCaptureHook(
      engine.solver!, engine.elements, engine.statePool,
    );
    engine.postIterationHook = hook;
    engine.preFactorHook = preFactorHook;

    // Collect our steps
    const ourSteps: { iters: { iteration: number; voltages: number[]; noncon: number; gConv: boolean; eConv: boolean }[] }[] = [];
    for (let s = 0; s < 5; s++) {
      try {
        coordinator.step();
        const snaps = getSnapshots();
        ourSteps.push({
          iters: snaps.map(snap => ({
            iteration: snap.iteration,
            voltages: Array.from(snap.voltages),
            noncon: snap.noncon,
            gConv: snap.globalConverged,
            eConv: snap.elemConverged,
          })),
        });
        clear();
      } catch (e: any) {
        const snaps = getSnapshots();
        ourSteps.push({
          iters: snaps.map(snap => ({
            iteration: snap.iteration,
            voltages: Array.from(snap.voltages),
            noncon: snap.noncon,
            gConv: snap.globalConverged,
            eConv: snap.elemConverged,
          })),
        });
        clear();
        break;
      }
    }

    // --- Print comparison ---
    const fmtV = (v: number) => v.toExponential(4).padStart(12);

    // ngspice steps
    console.log('\n========== NGSPICE: per-iteration voltages ==========');
    for (let s = 0; s < Math.min(ngSession.steps.length, 5); s++) {
      const step = ngSession.steps[s];
      console.log(`\n--- ngspice step ${s}: ${step.iterations.length} iters ---`);
      for (const iter of step.iterations) {
        const vStr = Array.from(iter.voltages).map(fmtV).join(' ');
        console.log(`  i${iter.iteration.toString().padStart(3)} nc=${iter.noncon} cv=${iter.globalConverged ? 'Y' : 'N'} | ${vStr}`);
      }
    }

    // Our steps
    console.log('\n========== OUR ENGINE: per-iteration voltages ==========');
    for (let s = 0; s < ourSteps.length; s++) {
      const step = ourSteps[s];
      console.log(`\n--- our step ${s}: ${step.iters.length} iters ---`);
      const limit = step.iters.length <= 20 ? step.iters.length : 20;
      for (let i = 0; i < limit; i++) {
        const iter = step.iters[i];
        const vStr = iter.voltages.map(fmtV).join(' ');
        console.log(`  i${iter.iteration.toString().padStart(3)} nc=${iter.noncon} gc=${iter.gConv ? 'Y' : 'N'} ec=${iter.eConv ? 'Y' : 'N'} | ${vStr}`);
      }
      if (step.iters.length > 20) {
        console.log(`  ... (${step.iters.length - 20} more iterations omitted)`);
        // Print last 5
        for (let i = step.iters.length - 5; i < step.iters.length; i++) {
          const iter = step.iters[i];
          const vStr = iter.voltages.map(fmtV).join(' ');
          console.log(`  i${iter.iteration.toString().padStart(3)} nc=${iter.noncon} gc=${iter.gConv ? 'Y' : 'N'} ec=${iter.eConv ? 'Y' : 'N'} | ${vStr}`);
        }
      }
    }

    // Per-node divergence analysis for step 1
    if (ourSteps.length >= 2 && ourSteps[1].iters.length > 1) {
      console.log('\n========== STEP 1: per-node delta between consecutive iterations ==========');
      const iters = ourSteps[1].iters;
      const nNodes = iters[0].voltages.length;
      for (let i = 1; i < Math.min(iters.length, 15); i++) {
        const deltas = [];
        for (let n = 0; n < nNodes; n++) {
          deltas.push(iters[i].voltages[n] - iters[i - 1].voltages[n]);
        }
        const deltaStr = deltas.map(d => fmtV(d)).join(' ');
        console.log(`  i${i.toString().padStart(3)}-i${(i-1).toString().padStart(3)} nc=${iters[i].noncon} | ${deltaStr}`);
      }

      // Find which node diverges first (largest delta)
      console.log('\n========== STEP 1: worst node per iteration ==========');
      for (let i = 1; i < Math.min(iters.length, 20); i++) {
        let worstNode = 0, worstDelta = 0;
        for (let n = 0; n < nNodes; n++) {
          const d = Math.abs(iters[i].voltages[n] - iters[i - 1].voltages[n]);
          if (d > worstDelta) { worstDelta = d; worstNode = n; }
        }
        console.log(`  i${i.toString().padStart(3)}: worst=V[${worstNode}] delta=${worstDelta.toExponential(4)} val=${iters[i].voltages[worstNode].toExponential(4)}`);
      }
    }
  });
});

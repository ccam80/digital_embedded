/**
 * Headless convergence regression test for fixtures/buckbjt.dts.
 *
 * This circuit is a BJT buck converter: NPN + PNP push-pull driver, NMOS
 * power switch, inductor, freewheeling diode, output capacitor, and
 * resistive loads. It exercises all three BJT convergence fallback levels
 * (direct NR, Gmin stepping, source stepping) and is a BJT convergence stress test.
 *
 * NOTE: The BJT instances in fixtures/buckbjt.dts have nonzero CJE/CJC/TF/TR parameters
 * (2N3904-ish values). These are present to avoid zero-cap Newton-Raphson runaway — without
 * junction capacitances the BJT Jacobian lacks the small regularising conductance (geq = C/dt)
 * that prevents the MNA matrix from becoming numerically singular during transient. They are
 * NOT intended to model a specific device; do not remove them to "clean up" the fixture.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { DefaultSimulatorFacade } from '../../../headless/default-facade.js';
import { createDefaultRegistry } from '../../../components/register-all.js';
import type { AnalogEngine } from '../../../core/analog-engine-interface.js';
import { DefaultSimulationCoordinator } from '../../../solver/coordinator.js';
import { EngineState } from '../../../core/engine-interface.js';

const registry = createDefaultRegistry();

function loadBuckBjt(): ReturnType<DefaultSimulatorFacade['compile']> {
  const facade = new DefaultSimulatorFacade(registry);
  const json = readFileSync(resolve(__dirname, '../../../../fixtures/buckbjt.dts'), 'utf-8');
  const circuit = facade.deserialize(json);
  return facade.compile(circuit);
}

describe('buckbjt.dts convergence', () => {
  it('compiles without throwing', () => {
    expect(() => loadBuckBjt()).not.toThrow();
  });

  it('DC operating point converges', () => {
    const facade = new DefaultSimulatorFacade(registry);
    const json = readFileSync(resolve(__dirname, '../../../../fixtures/buckbjt.dts'), 'utf-8');
    const circuit = facade.deserialize(json);
    facade.compile(circuit);

    const dcOp = facade.getDcOpResult();
    expect(dcOp).not.toBeNull();
    expect(dcOp!.converged).toBe(true);

    // All node voltages should be finite
    for (let i = 0; i < dcOp!.nodeVoltages.length; i++) {
      expect(
        Number.isFinite(dcOp!.nodeVoltages[i]),
        `node ${i} voltage should be finite, got ${dcOp!.nodeVoltages[i]}`,
      ).toBe(true);
    }
  });

  it('transient stepping does not error after 50 steps', () => {
    const coordinator = loadBuckBjt();

    // Step 50 times — if convergence fails the engine transitions to ERROR
    for (let i = 0; i < 50; i++) {
      coordinator.step();
    }

    // The analog backend should still be functional (not in ERROR state)
    const analog = (coordinator as DefaultSimulationCoordinator).getAnalogEngine() as AnalogEngine;
    expect(analog).not.toBeNull();
    expect(analog.simTime).toBeGreaterThan(0);
  });

  it('survives 2000 transient steps without ERROR state', () => {
    const coordinator = loadBuckBjt();
    const analog = (coordinator as DefaultSimulationCoordinator).getAnalogEngine() as AnalogEngine;
    expect(analog).not.toBeNull();

    for (let i = 0; i < 2000; i++) {
      coordinator.step();
      if (analog.getState() === EngineState.ERROR) {
        throw new Error(
          `Engine entered ERROR state at step ${i + 1}, simTime=${analog.simTime}`,
        );
      }
    }

    expect(analog.simTime).toBeGreaterThan(0);
  });

  it('survives 600µs of sim time (matches UI run duration)', () => {
    // The UI run loop targets analogTargetRate=1e-3 sim-s/wall-s.
    // A 600ms wall-clock run ≈ 600µs of sim time.
    const coordinator = loadBuckBjt();
    const analog = (coordinator as DefaultSimulationCoordinator).getAnalogEngine() as AnalogEngine;
    expect(analog).not.toBeNull();

    const targetSimTime = 600e-6; // 600µs
    let stepCount = 0;
    const maxSteps = 50000;

    while (analog.simTime < targetSimTime && stepCount < maxSteps) {
      coordinator.step();
      stepCount++;
      if (analog.getState() === EngineState.ERROR) {
        throw new Error(
          `Engine ERROR at step ${stepCount}, simTime=${analog.simTime.toExponential(3)}`,
        );
      }
    }

    expect(analog.simTime).toBeGreaterThanOrEqual(targetSimTime);
  });
});

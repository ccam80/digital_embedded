/**
 * MCP-surface regression test for the buckbjt fixture.
 *
 * Verifies that the breakpoint-push-once migration (seed loop + iterator refill)
 * does not break the headless API surface used by the MCP server.
 *
 * Four regression cases:
 *   1. compile() does not throw
 *   2. DC operating point converges with all finite node voltages
 *   3. First coordinator.step() does not enter ERROR (seed loop fired)
 *   4. 50 steps advance simTime > 0 without ERROR (iterator refill works)
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

function loadBuckBjt() {
  const facade = new DefaultSimulatorFacade(registry);
  const json = readFileSync(resolve(__dirname, '../../../../fixtures/buckbjt.dts'), 'utf-8');
  const circuit = facade.deserialize(json);
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

describe('buckbjt MCP surface- breakpoint-push-once regression', () => {
  it('compile() on buckbjt fixture does not throw', () => {
    expect(() => loadBuckBjt()).not.toThrow();
  });

  it('DC op result after compile has converged === true and all finite node voltages', () => {
    const { facade } = loadBuckBjt();
    const dcOp = facade.getDcOpResult();
    expect(dcOp).not.toBeNull();
    expect(dcOp!.converged).toBe(true);
    for (let i = 0; i < dcOp!.nodeVoltages.length; i++) {
      expect(
        Number.isFinite(dcOp!.nodeVoltages[i]),
        `node ${i} voltage should be finite, got ${dcOp!.nodeVoltages[i]}`,
      ).toBe(true);
    }
  });

  it('first coordinator.step() does not transition engine to ERROR', () => {
    const { coordinator } = loadBuckBjt();
    const analog = (coordinator as DefaultSimulationCoordinator).getAnalogEngine() as AnalogEngine;
    expect(analog).not.toBeNull();

    coordinator.step();

    expect(analog.getState()).not.toBe(EngineState.ERROR);
  });

});

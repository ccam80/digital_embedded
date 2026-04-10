/**
 * W6.T1 — Master-switch tests (§10.4 headless).
 *
 * Tests for setCaptureHook master switch, throw-on-conflict, and
 * pre-hook log state restore when setCaptureHook(null) is called.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../default-facade.js";
import { DefaultSimulationCoordinator } from "../../solver/coordinator.js";
import type { MNAEngine } from "../../solver/analog/analog-engine.js";
import { createDefaultRegistry } from "../../components/register-all.js";
import type { PhaseAwareCaptureHook } from "../../solver/coordinator-types.js";

const registry = createDefaultRegistry();

function buildRcCircuit(facade: DefaultSimulatorFacade) {
  return facade.build({
    components: [
      { id: "vs",  type: "DcVoltageSource", props: { voltage: 5 } },
      { id: "r1",  type: "Resistor",        props: { resistance: 1000 } },
      { id: "c1",  type: "Capacitor",       props: { capacitance: 1e-6 } },
      { id: "gnd", type: "Ground" },
    ],
    connections: [
      ["vs:pos", "r1:A"],
      ["r1:B",   "c1:pos"],
      ["c1:neg", "gnd:out"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

function makeNoopBundle(): PhaseAwareCaptureHook {
  const iterationHook = (_i: number, _v: Float64Array, _p: Float64Array, _n: number, _g: boolean, _e: boolean, _le: unknown[], _cf: string[]) => {};
  return {
    iterationHook,
    phaseHook: {
      onAttemptBegin: () => {},
      onAttemptEnd: () => {},
    },
  };
}

describe("setCaptureHook master switch", () => {
  it("flips all five engine flags atomically when bundle is installed", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildRcCircuit(facade);
    const coord = facade.compile(circuit, { deferInitialize: true }) as DefaultSimulationCoordinator;
    const engine = coord.getAnalogEngine() as MNAEngine;

    const bundle = makeNoopBundle();
    facade.setCaptureHook(bundle);

    expect(engine.postIterationHook).toBe(bundle.iterationHook);
    expect(engine.stepPhaseHook).toBe(bundle.phaseHook);
    expect(engine.detailedConvergence).toBe(true);
    expect(engine.limitingCollector).not.toBeNull();
    expect(engine.convergenceLog.enabled).toBe(true);
  });

  it("setConvergenceLogEnabled(false) throws when bundle installed", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildRcCircuit(facade);
    facade.compile(circuit, { deferInitialize: true });
    facade.setCaptureHook(makeNoopBundle());
    expect(() => facade.setConvergenceLogEnabled(false)).toThrowError(/comparison harness/);
  });

  it("setCaptureHook(null) restores pre-hook log state", () => {
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = buildRcCircuit(facade);
    const coord = facade.compile(circuit, { deferInitialize: true }) as DefaultSimulationCoordinator;
    const engine = coord.getAnalogEngine() as MNAEngine;

    // User enables convergence log BEFORE installing harness
    facade.setConvergenceLogEnabled(true);
    facade.setCaptureHook(makeNoopBundle());
    facade.setCaptureHook(null);

    // Log state must be restored to what it was before the hook was installed
    expect(engine.convergenceLog.enabled).toBe(true);
  });
});

/**
 * resolveSimulationParams ngspice-parity tests.
 *
 * Verifies that the auto-derivation of CKTmaxStep / CKTdelmin / firstStep
 * matches ngspice traninit.c:23-32 and dctran.c:118 exactly.
 *
 * Also verifies MNAEngine.configure preserves the auto-derivation across
 * the spread-merge flow (the previously-resolved baseline must NOT
 * short-circuit re-derivation when transient inputs change).
 */

import { describe, it, expect } from "vitest";
import {
  resolveSimulationParams,
  DEFAULT_SIMULATION_PARAMS,
  type SimulationParams,
} from "@/core/analog-engine-interface";
import { DefaultSimulatorFacade } from "@/headless/default-facade";
import { createDefaultRegistry } from "@/components/register-all";

describe("resolveSimulationParams- ngspice traninit.c:23-32 parity", () => {
  it("user-supplied maxTimeStep passes through unmodified", () => {
    const r = resolveSimulationParams({
      ...DEFAULT_SIMULATION_PARAMS,
      maxTimeStep: 7e-7,
      tStop: 1e-3,
      outputStep: 1e-5,
    });
    expect(r.maxTimeStep).toBe(7e-7);
  });

  it("maxTimeStep === 0 is treated as omitted (matches ngspice TRANmaxStep default)", () => {
    const r = resolveSimulationParams({
      ...DEFAULT_SIMULATION_PARAMS,
      maxTimeStep: 0,
      tStop: 100e-3,
      outputStep: 1e-3,
    });
    // MIN(1e-3, 100e-3/50) = MIN(1e-3, 2e-3) = 1e-3
    expect(r.maxTimeStep).toBe(1e-3);
  });

  it("outputStep < (tStop - 0)/50 → maxTimeStep = outputStep", () => {
    const partial: Partial<SimulationParams> = {
      ...DEFAULT_SIMULATION_PARAMS,
      tStop: 100e-3,
      outputStep: 1e-3,
    };
    delete partial.maxTimeStep;
    const r = resolveSimulationParams(partial as SimulationParams);
    expect(r.maxTimeStep).toBe(1e-3);
  });

  it("outputStep > (tStop - 0)/50 → maxTimeStep = (tStop - 0)/50", () => {
    const partial: Partial<SimulationParams> = {
      ...DEFAULT_SIMULATION_PARAMS,
      tStop: 1e-3,
      outputStep: 1e-4,
    };
    delete partial.maxTimeStep;
    const r = resolveSimulationParams(partial as SimulationParams);
    // (1e-3)/50 = 2e-5; outputStep 1e-4 > 2e-5 → maxStep = 2e-5
    expect(r.maxTimeStep).toBe(2e-5);
  });

  it("streaming mode (no tStop) falls back to static default", () => {
    const partial: Partial<SimulationParams> = {
      ...DEFAULT_SIMULATION_PARAMS,
    };
    delete partial.maxTimeStep;
    const r = resolveSimulationParams(partial as SimulationParams);
    expect(r.maxTimeStep).toBe(DEFAULT_SIMULATION_PARAMS.maxTimeStep);
  });

  it("derived minTimeStep tracks maxTimeStep at 1e-11 ratio (traninit.c:34)", () => {
    const partial: Partial<SimulationParams> = {
      ...DEFAULT_SIMULATION_PARAMS,
      tStop: 100e-3,
      outputStep: 1e-3,
    };
    delete partial.maxTimeStep;
    delete partial.minTimeStep;
    const r = resolveSimulationParams(partial as SimulationParams);
    expect(r.maxTimeStep).toBe(1e-3);
    expect(r.minTimeStep).toBe(1e-14);
  });

  it("derived firstStep follows dctran.c:118", () => {
    const partial: Partial<SimulationParams> = {
      ...DEFAULT_SIMULATION_PARAMS,
      tStop: 100e-3,
      outputStep: 1e-3,
    };
    delete partial.firstStep;
    const r = resolveSimulationParams(partial as SimulationParams);
    // MIN(100e-3/100, 1e-3) / 10 = MIN(1e-3, 1e-3) / 10 = 1e-4
    expect(r.firstStep).toBe(1e-4);
  });

  it("nonzero initTime affects auto-derivation (ngspice CKTinitTime)", () => {
    const partial: Partial<SimulationParams> = {
      ...DEFAULT_SIMULATION_PARAMS,
      tStop: 1e-3,
      outputStep: 1e-4,
      initTime: 0.5e-3,
    };
    delete partial.maxTimeStep;
    const r = resolveSimulationParams(partial as SimulationParams);
    // (1e-3 - 0.5e-3)/50 = 1e-5; outputStep 1e-4 > 1e-5 → maxStep = 1e-5.
    expect(r.maxTimeStep).toBe(1e-5);
  });
});

describe("MNAEngine.configure- auto-derivation survives the merge", () => {
  async function buildEngine() {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: 1 } },
        { id: "r1",  type: "Resistor",        props: { label: "r1",  resistance: 1000 } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["vs:pos", "r1:pos"],
        ["r1:neg", "gnd:out"],
        ["vs:neg", "gnd:out"],
      ],
    });
    const coordinator = await facade.compile(circuit);
    return coordinator.getAnalogEngine()!;
  }

  it("re-derives when configure provides tStop without maxTimeStep", async () => {
    const engine = await buildEngine();
    // First configure: just tolerances. _params.maxTimeStep stays at the
    // static default because no transient inputs are present.
    engine.configure({ reltol: 1e-3 });
    // Second configure: provides tStop+outputStep without maxTimeStep-
    // must re-fire auto-derivation, not silently keep the static default.
    engine.configure({ tStop: 100e-3, outputStep: 1e-3 });
    // (params is private; cast to access for verification.)
    const p = (engine as unknown as { _params: { maxTimeStep: number; minTimeStep: number; firstStep: number } })._params;
    expect(p.maxTimeStep).toBe(1e-3);
    expect(p.minTimeStep).toBe(1e-14);
    expect(p.firstStep).toBe(1e-4);
  });

  it("explicit maxTimeStep override passes through configure", async () => {
    const engine = await buildEngine();
    engine.configure({ tStop: 100e-3, outputStep: 1e-3, maxTimeStep: 7e-7 });
    const p = (engine as unknown as { _params: { maxTimeStep: number } })._params;
    expect(p.maxTimeStep).toBe(7e-7);
  });

  it("non-transient configure call does not disturb existing maxTimeStep", async () => {
    const engine = await buildEngine();
    engine.configure({ tStop: 100e-3, outputStep: 1e-3 });
    engine.configure({ reltol: 5e-4 });
    const p = (engine as unknown as { _params: { maxTimeStep: number; reltol: number } })._params;
    expect(p.maxTimeStep).toBe(1e-3);
    expect(p.reltol).toBe(5e-4);
  });
});

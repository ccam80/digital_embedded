/**
 * resolveSimulationParams ngspice-parity tests.
 *
 * Verifies that the auto-derivation of CKTmaxStep / CKTdelmin / firstStep
 * matches ngspice traninit.c:23-32 and dctran.c:118 exactly.
 *
 * Also verifies that the spread-merge flow used by configure() preserves
 * auto-derivation across sequential calls (the previously-resolved baseline
 * must NOT short-circuit re-derivation when transient inputs change).
 */

import { describe, it, expect } from "vitest";
import {
  resolveSimulationParams,
  DEFAULT_SIMULATION_PARAMS,
  type SimulationParams,
} from "@/core/analog-engine-interface";

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

describe("resolveSimulationParams- spread-merge flow (configure() contract)", () => {
  it("re-derives when configure provides tStop without maxTimeStep", () => {
    // Simulates: configure({reltol}) then configure({tStop, outputStep}).
    // The merge accumulates partial updates; resolveSimulationParams must
    // re-fire auto-derivation from the merged input, not keep the static default.
    const base: SimulationParams = { ...DEFAULT_SIMULATION_PARAMS };
    // First merge: reltol only — no transient inputs, maxTimeStep stays static.
    const after1 = resolveSimulationParams({ ...base, reltol: 1e-3 });
    expect(after1.maxTimeStep).toBe(DEFAULT_SIMULATION_PARAMS.maxTimeStep);
    // Second merge: add tStop+outputStep (no maxTimeStep, minTimeStep, firstStep) —
    // all three must be re-derived from the new transient inputs.
    const merged2: Partial<SimulationParams> = {
      ...after1,
      tStop: 100e-3,
      outputStep: 1e-3,
    };
    delete merged2.maxTimeStep;   // omit to trigger auto-derivation
    delete merged2.minTimeStep;   // omit so minTimeStep re-derives from new maxTimeStep
    delete merged2.firstStep;     // omit so firstStep re-derives from tStop
    const after2 = resolveSimulationParams(merged2 as SimulationParams);
    expect(after2.maxTimeStep).toBe(1e-3);
    expect(after2.minTimeStep).toBe(1e-14);
    expect(after2.firstStep).toBe(1e-4);
  });

  it("explicit maxTimeStep override passes through configure", () => {
    // Simulates: configure({tStop, outputStep, maxTimeStep: 7e-7}).
    const r = resolveSimulationParams({
      ...DEFAULT_SIMULATION_PARAMS,
      tStop: 100e-3,
      outputStep: 1e-3,
      maxTimeStep: 7e-7,
    });
    expect(r.maxTimeStep).toBe(7e-7);
  });

  it("non-transient configure call does not disturb existing maxTimeStep", () => {
    // Simulates: configure({tStop, outputStep}) then configure({reltol}).
    // The second merge must not lose the derived maxTimeStep from the first.
    // maxTimeStep omitted so auto-derivation runs from tStop/outputStep.
    const partial: Partial<SimulationParams> = {
      ...DEFAULT_SIMULATION_PARAMS,
      tStop: 100e-3,
      outputStep: 1e-3,
    };
    delete partial.maxTimeStep;
    const after1 = resolveSimulationParams(partial as SimulationParams);
    expect(after1.maxTimeStep).toBe(1e-3);
    // Second merge: reltol only — carry the already-resolved maxTimeStep forward.
    const after2 = resolveSimulationParams({
      ...after1,
      reltol: 5e-4,
    });
    expect(after2.maxTimeStep).toBe(1e-3);
    expect(after2.reltol).toBe(5e-4);
  });
});

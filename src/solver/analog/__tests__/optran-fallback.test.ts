/**
 * OPtran operating-point pseudo-transient fallback — Surface 1 (headless API).
 *
 * Covers the ngspice optran.c / cktop.c:101-108 port:
 *   - option plumbing: optran / opstepsize / opfinaltime / opramptime on
 *     SimulationParams, default-ON to match ngspice's frontend init
 *     (init.c:77-94 calls com_optran with "1 1 1 100n 10u 0" to "make optran
 *     the standard", clearing the optran.c:117 nooptran gate), hot-loadable via
 *     coordinator.configure (project requirement).
 *   - static-ladder invariant: with optran explicitly disabled, the DC-OP
 *     ladder is the direct NR + gmin + source stepping path with no fallback —
 *     solveDcOperatingPoint only invokes ctx.opTranFallback when params.optran
 *     is set.
 *
 * The bit-exact-vs-ngspice OPtran convergence gate is the T3 paired-harness
 * surface (ngspice-parity); see optran-fallback-parity.test.ts for that gate
 * and the escalation it documents.
 */

import { describe, it, expect } from "vitest";
import { resolve } from "path";
import { readFileSync } from "fs";
import { createDefaultRegistry } from "../../../components/register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { DefaultSimulationCoordinator } from "../../coordinator.js";
import type { MNAEngine } from "../analog-engine.js";
import {
  DEFAULT_SIMULATION_PARAMS,
  resolveSimulationParams,
} from "../../../core/analog-engine-interface.js";

const DTS_PATH = resolve(
  process.cwd(),
  "src/solver/analog/__tests__/ngspice-parity/fixtures/optran-inductor-singular.dts",
);

function loadFixture() {
  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.deserialize(readFileSync(DTS_PATH, "utf-8"));
  const coordinator = facade.compile(circuit) as DefaultSimulationCoordinator;
  const engine = coordinator.getAnalogEngine() as MNAEngine;
  return { coordinator, engine };
}

/** Read a source's positive-pin node voltage by element label. */
function sourcePinVoltage(engine: MNAEngine, label: string): number {
  for (let i = 0; i < engine.elements.length; i++) {
    const el = engine.elements[i]!;
    if (el.label === label) {
      const node = el.pinNodes.get("pos");
      if (node === undefined) return NaN;
      return engine.getNodeVoltage(node);
    }
  }
  return NaN;
}

describe("OPtran option plumbing — Surface 1 (headless)", () => {
  it("defaults optran on with the init.c:82 command defaults (1 1 1 100n 10u 0)", () => {
    // ngspice init.c:77-94 calls com_optran with "1 1 1 100n 10u 0" at frontend
    // init to "make optran the standard", clearing the nooptran gate
    // (optran.c:117). OPtran is therefore the always-on last-resort OP rung that
    // CKTop runs after direct NR + gmin + source stepping fail (cktop.c:104).
    expect(DEFAULT_SIMULATION_PARAMS.optran).toBe(true);
    // init.c:82 command defaults: opstepsize=100n, opfinaltime=10u, opramptime=0.
    expect(DEFAULT_SIMULATION_PARAMS.opstepsize).toBe(1e-7);
    expect(DEFAULT_SIMULATION_PARAMS.opfinaltime).toBe(1e-5);
    expect(DEFAULT_SIMULATION_PARAMS.opramptime).toBe(0);
  });

  it("resolveSimulationParams carries the optran fields through unchanged", () => {
    const resolved = resolveSimulationParams({
      reltol: 1e-3,
      voltTol: 1e-6,
      abstol: 1e-12,
      chargeTol: 1e-14,
      trtol: 7,
      maxIterations: 100,
      transientMaxIterations: 10,
      integrationMethod: "trapezoidal",
      dcTrcvMaxIter: 50,
      gmin: 1e-12,
      nodeDamping: false,
      optran: true,
      opstepsize: 5e-9,
      opfinaltime: 2e-6,
      opramptime: 1e-7,
    });
    expect(resolved.optran).toBe(true);
    expect(resolved.opstepsize).toBe(5e-9);
    expect(resolved.opfinaltime).toBe(2e-6);
    expect(resolved.opramptime).toBe(1e-7);
  });

  it("hot-loads the optran option via configure (project requirement)", () => {
    const { coordinator } = loadFixture();
    // Hot-load the optran option set after compile- the setParam/configure
    // path every model param must satisfy. Must not throw and must take effect
    // on the next dcOperatingPoint().
    coordinator.configure({
      optran: true,
      opstepsize: 1e-8,
      opfinaltime: 1e-6,
      opramptime: 0,
    });
    // A second configure flips it back off- also hot.
    coordinator.configure({ optran: false });
    expect(() => coordinator.dcOperatingPoint()).not.toThrow();
  });
});

describe("OPtran static-ladder invariant — Surface 1 (headless)", () => {
  it("with optran explicitly disabled, the singular circuit fails the static ladder and never reaches OPtran", () => {
    // The inductor-short fixture has no DC operating point: an ideal inductor
    // bridging two source-pinned nodes is a DC branch-current singularity that
    // gmin (a node-to-ground conductance) cannot resolve. OPtran is on by
    // default (init.c:77-94); disabling it isolates the static ladder, which
    // exhausts direct NR + gmin + source stepping and returns non-converged.
    // The fallback never runs, so the reported method is the last static
    // strategy, gillespie-src.
    const { coordinator } = loadFixture();
    coordinator.configure({ optran: false });
    const result = coordinator.dcOperatingPoint();
    expect(result).not.toBeNull();
    expect(result!.converged).toBe(false);
    expect(result!.method).not.toBe("optran");
    expect(result!.method).toBe("gillespie-src");
  });

  it("enabling optran resolves the singular circuit the static ladder cannot", () => {
    // optran-OFF: the static ladder fails (above). optran-ON: CKTop invokes the
    // OPtran pseudo-transient only after the static ladder fails (cktop.c:104),
    // and it settles the circuit to its source-pinned node voltages. This is the
    // fallback's entire purpose- it runs exactly when, and only when, the static
    // ladder cannot resolve the operating point.
    const base = loadFixture();
    base.coordinator.configure({ optran: false });
    const baseResult = base.coordinator.dcOperatingPoint();
    expect(baseResult).not.toBeNull();
    expect(baseResult!.converged).toBe(false);

    const withOpt = loadFixture();
    withOpt.coordinator.configure({
      optran: true,
      opstepsize: 1e-8,
      opfinaltime: 1e-6,
      opramptime: 0,
    });
    const optResult = withOpt.coordinator.dcOperatingPoint();
    expect(optResult).not.toBeNull();
    expect(optResult!.converged).toBe(true);
    expect(optResult!.method).toBe("optran");
    expect(sourcePinVoltage(withOpt.engine, "V1")).toBeCloseTo(3, 6);
    expect(sourcePinVoltage(withOpt.engine, "V2")).toBeCloseTo(5, 6);
  });
});

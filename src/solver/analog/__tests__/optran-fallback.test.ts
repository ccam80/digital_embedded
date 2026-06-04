/**
 * OPtran operating-point pseudo-transient fallback — Surface 1 (headless API).
 *
 * Covers the ngspice optran.c / cktop.c:101-108 port:
 *   - option plumbing: optran / opstepsize / opfinaltime / opramptime on
 *     SimulationParams, default-off (nooptran=true equivalent, optran.c:51),
 *     hot-loadable via coordinator.configure (project requirement).
 *   - default-off invariant: with optran unset, the DC-OP ladder is the same
 *     direct NR + gmin + source stepping path as before — the OPtran fallback
 *     never runs (solveDcOperatingPoint only invokes ctx.opTranFallback when
 *     params.optran is set).
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
  it("defaults optran off with the optran.c:48-50 static defaults", () => {
    // optran.c:51 nooptran = TRUE: the fallback is opt-in.
    expect(DEFAULT_SIMULATION_PARAMS.optran).toBe(false);
    // optran.c:48-50 opfinaltime=1e-6, opstepsize=1e-8, opramptime=0.
    expect(DEFAULT_SIMULATION_PARAMS.opstepsize).toBe(1e-8);
    expect(DEFAULT_SIMULATION_PARAMS.opfinaltime).toBe(1e-6);
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

describe("OPtran default-off invariant — Surface 1 (headless)", () => {
  it("with optran unset, the singular circuit fails the static ladder and never reaches OPtran", () => {
    // The inductor-short fixture has no DC operating point: an ideal inductor
    // bridging two source-pinned nodes is a DC branch-current singularity that
    // gmin (a node-to-ground conductance) cannot resolve. With optran unset,
    // ngspice's CKTop exhausts direct NR + gmin + source stepping and returns
    // non-converged- OPtran is opt-in (cktop.c:101-108, optran.c:51 nooptran).
    // digiTS matches: the static ladder fails and the fallback never runs, so
    // the reported method is the last static strategy, gillespie-src.
    const { coordinator } = loadFixture();
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

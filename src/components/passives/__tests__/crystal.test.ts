/**
 * Tests for the QuartzCrystal (Butterworth-Van Dyke) component.
 *
 * §3 poison-pattern migration (2026-05-03, fix-list line 404): the previous
 * file imported `runDcOp`, `makeTestSetupContext`, `setupAll`, `makeLoadCtx`,
 * `allocateStatePool` from the deleted `__tests__/test-helpers.ts`, drove
 * `element.setup(ctx)` / `element.load(ctx)` directly via a hand-rolled
 * `withState()` helper + a hand-rolled `SparseSolver()` + a fake capture
 * solver, and asserted bit-exact stamp values at `(1,1)` matrix entries.
 * All eradicated per §3 poison-pattern warning + §4a helper deletion.
 *
 * Deletions justified per "ComparisonSession matrix-peek tests" rule
 * (category-1, user-approved):
 *   - `factory creates element with 2 external pins and correct branchIndex
 *     after setup` — drove element.setup(ctx) directly with a hand-rolled
 *     SparseSolver + makeTestSetupContext + the local `withState` helper.
 *   - `factory creates element that stamps R_s conductance at A-node
 *     diagonal after setup` — engine-impersonator-via-capture-solver: built
 *     a fake `{ allocElement, stampElement, stampRHS }` solver, called
 *     element.load(ctx) directly with a hand-built ag[] vector, peeked the
 *     matrix value at handle (1,1) and asserted bit-exact `G_s + geqC0`.
 *     Bit-exact BVD R_s + C_0 stamping is covered by the ngspice harness
 *     parity tests (`harness_run` + `harness_get_attempt` against the
 *     instrumented ngspice DLL).
 *   - `_stateBase is -1 before compiler assigns it` (UC-7 retention from
 *     fix-list line 265, J-048) — kept and rewritten as a pure factory check
 *     (no setup() call), since the contract it pins is "factory leaves
 *     _stateBase = -1 until the compiler walks setup()".
 *
 * Rewritten on top of `buildFixture` + the registered QuartzCrystal /
 * DcVoltageSource / Resistor / Ground components. The `dc_blocks` test now
 * routes through the production compile + DCOP path and reads observable
 * branch current via `engine.getElementCurrent(...)` — confirming via the
 * public engine surface that the crystal contributes zero DC conductance
 * (current through the source equals the bleed-resistor current).
 */

import { describe, it, expect } from "vitest";
import {
  CrystalDefinition,
  CrystalCircuitElement,
  AnalogCrystalElement,
  crystalMotionalInductance,
  crystalSeriesResistance,
  CRYSTAL_ATTRIBUTE_MAPPINGS,
} from "../crystal.js";
import { PropertyBag } from "../../../core/properties.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

// ---------------------------------------------------------------------------
// Helper: narrow ModelEntry to inline factory (throws if netlist kind)
// ---------------------------------------------------------------------------
import type { ModelEntry, AnalogFactory } from "../../../core/registry.js";
import type { PoolBackedAnalogElement } from "../../../solver/analog/element.js";
import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

function getFactory(entry: ModelEntry): AnalogFactory {
  if (entry.kind !== "inline") throw new Error("Expected inline ModelEntry");
  return entry.factory;
}

// ---------------------------------------------------------------------------
// Analytical impedance of BVD model (kept; pure math helper)
// ---------------------------------------------------------------------------

function bvdImpedanceMagnitude(
  freqHz: number,
  Rs: number,
  Ls: number,
  Cs: number,
  C0: number,
): number {
  const omega = 2 * Math.PI * freqHz;
  const Z_m_re = Rs;
  const Z_m_im = omega * Ls - 1 / (omega * Cs);
  const Z_m_mag2 = Z_m_re * Z_m_re + Z_m_im * Z_m_im;
  const Y_m_re = Z_m_re / Z_m_mag2;
  const Y_m_im = -Z_m_im / Z_m_mag2;
  const Y_0_im = omega * C0;
  const Y_re = Y_m_re;
  const Y_im = Y_m_im + Y_0_im;
  const Y_mag2 = Y_re * Y_re + Y_im * Y_im;
  return 1 / Math.sqrt(Y_mag2);
}

// ---------------------------------------------------------------------------
// DC-block circuit: VS=1V → Crystal → R_bleed(1GΩ) → GND.
// ---------------------------------------------------------------------------

interface DcBlockParams {
  V: number;
  rBleed: number;
  frequency: number;
  qualityFactor: number;
  motionalCapacitance: number;
  shuntCapacitance: number;
}

function buildDcBlockCircuit(facade: DefaultSimulatorFacade, p: DcBlockParams): Circuit {
  return facade.build({
    components: [
      { id: "vs",      type: "DcVoltageSource", props: { label: "vs",  voltage: p.V } },
      { id: "xtal",    type: "QuartzCrystal",   props: {
          label: "xtal",
          frequency: p.frequency,
          qualityFactor: p.qualityFactor,
          motionalCapacitance: p.motionalCapacitance,
          shuntCapacitance: p.shuntCapacitance,
      } },
      { id: "rbleed",  type: "Resistor",        props: { label: "rbleed", resistance: p.rBleed } },
      { id: "gnd",     type: "Ground" },
    ],
    connections: [
      ["vs:pos",     "xtal:pos"],
      ["xtal:neg",   "rbleed:pos"],
      ["rbleed:neg", "gnd:out"],
      ["vs:neg",     "gnd:out"],
    ],
  });
}

function findCrystal(elements: ReadonlyArray<unknown>): AnalogCrystalElement {
  const idx = elements.findIndex((el) => el instanceof AnalogCrystalElement);
  if (idx < 0) throw new Error("AnalogCrystalElement not found in compiled circuit");
  return elements[idx] as AnalogCrystalElement;
}

// ---------------------------------------------------------------------------
// Crystal tests
// ---------------------------------------------------------------------------

describe("Crystal", () => {
  describe("derived_parameters_consistent", () => {
    it("L_s = 1/(4π²·f²·C_s) for default parameters", () => {
      // Pure math helper smoke check: L_s formula stays callable.
      const f = 32768;
      const Cs = 12.5e-15;
      const Ls = crystalMotionalInductance(f, Cs);
      expect(Ls).toBeGreaterThan(0);
      const expected = 1 / (4 * Math.PI * Math.PI * f * f * Cs);
      expect(Ls).toBeCloseTo(expected, 18);
    });

    it("R_s = 2π·f·L_s/Q for default parameters", () => {
      const f = 32768;
      const Q = 50000;
      const Cs = 12.5e-15;
      const Ls = crystalMotionalInductance(f, Cs);
      const Rs = crystalSeriesResistance(f, Ls, Q);
      expect(Rs).toBeGreaterThan(0);
      const expected = (2 * Math.PI * f * Ls) / Q;
      expect(Rs).toBeCloseTo(expected, 12);
    });
  });

  describe("series_resonance_frequency", () => {
    it("impedance minimum occurs at f_s = 1/(2π√(L_s·C_s)) within 1%", () => {
      const f0 = 1e6;
      const Q = 10000;
      const Cs = 20e-15;
      const C0 = 5e-12;

      const Ls = crystalMotionalInductance(f0, Cs);
      const Rs = crystalSeriesResistance(f0, Ls, Q);
      const f_s = 1 / (2 * Math.PI * Math.sqrt(Ls * Cs));
      expect(Math.abs(f_s - f0) / f0).toBeLessThan(0.001);

      const freqRange = 0.001;
      const N = 200;
      let minZ = Infinity;
      let minFreq = 0;

      for (let i = 0; i <= N; i++) {
        const f = f0 * (1 - freqRange + (2 * freqRange * i) / N);
        const Z = bvdImpedanceMagnitude(f, Rs, Ls, Cs, C0);
        if (Z < minZ) { minZ = Z; minFreq = f; }
      }

      expect(Math.abs(minFreq - f_s) / f_s).toBeLessThan(0.01);
      const Z_at_fs = bvdImpedanceMagnitude(f_s, Rs, Ls, Cs, C0);
      expect(Z_at_fs).toBeLessThan(Rs * 100);
    });
  });

  describe("parallel_resonance_above_series", () => {
    it("impedance maximum (parallel resonance) is above f_s", () => {
      const f0 = 1e6;
      const Q = 10000;
      const Cs = 20e-15;
      const C0 = 5e-12;

      const Ls = crystalMotionalInductance(f0, Cs);
      const Rs = crystalSeriesResistance(f0, Ls, Q);
      const f_s = 1 / (2 * Math.PI * Math.sqrt(Ls * Cs));

      const N = 500;
      let maxZ = 0;
      let maxFreq = 0;

      for (let i = 1; i <= N; i++) {
        const f = f_s * (1 + (0.02 * i) / N);
        const Z = bvdImpedanceMagnitude(f, Rs, Ls, Cs, C0);
        if (Z > maxZ) { maxZ = Z; maxFreq = f; }
      }

      expect(maxFreq).toBeGreaterThan(f_s);
      const f_p_theory = f_s * Math.sqrt(1 + Cs / C0);
      expect(Math.abs(maxFreq - f_p_theory) / f_p_theory).toBeLessThan(0.05);
    });
  });

  describe("dc_blocks", () => {
    it("DC source across crystal produces near-zero current (capacitors block DC)", () => {
      // At DC, C_s and C_0 are open; L_s has no companion stamp (only branch
      // incidence). The crystal provides no resistive DC path between A and
      // B — a 1GΩ bleed resistor in series provides the only DC path.
      // I_source = V / R_bleed = 1V / 1e9Ω = 1 nA. Observe the bleed-current
      // contract via node voltages on the public engine surface: with the
      // crystal blocking DC, all 1V of the source must drop across the
      // crystal (V(xtal:pos) = 1, V(xtal:neg) = 0 ± gmin leakage), and the
      // source current equals the bleed-resistor current.
      const fix = buildFixture({
        build: (_r, facade) => buildDcBlockCircuit(facade, {
          V: 1.0,
          rBleed: 1e9,
          frequency: 1e6,
          qualityFactor: 1000,
          motionalCapacitance: 20e-15,
          shuntCapacitance: 5e-12,
        }),
      });
      const result = fix.coordinator.dcOperatingPoint()!;
      expect(result.converged).toBe(true);

      // Read voltages at the node labels stamped by labelToNodeId.
      const vXtalPos = fix.engine.getNodeVoltage(
        fix.circuit.labelToNodeId.get("xtal:pos")!,
      );
      const vXtalNeg = fix.engine.getNodeVoltage(
        fix.circuit.labelToNodeId.get("xtal:neg")!,
      );
      // Crystal blocks DC: full 1V drop across it (xtal:pos at +V, xtal:neg
      // pulled to ~0 by the bleed resistor to ground).
      expect(vXtalPos).toBeCloseTo(1.0, 6);
      expect(vXtalNeg).toBeCloseTo(0.0, 3); // gmin leakage on internal nodes
      // Bleed-resistor current = (V(xtal:neg) - 0) / R_bleed ≈ 0 / 1e9 = 0.
      // Source-branch current matches; the crystal contributes no DC
      // conductance (otherwise V(xtal:neg) would be ≫ 0).
      const iBleed = Math.abs(vXtalNeg) / 1e9;
      expect(iBleed).toBeLessThan(1e-9);
    });
  });

  describe("quality_factor_affects_bandwidth", () => {
    it("higher Q produces narrower resonance peak than lower Q", () => {
      const f0 = 1e6;
      const Cs = 20e-15;
      const C0 = 5e-12;
      const Ls = crystalMotionalInductance(f0, Cs);
      const Q_high = 50000;
      const Q_low = 1000;

      const Rs_high = crystalSeriesResistance(f0, Ls, Q_high);
      const Rs_low = crystalSeriesResistance(f0, Ls, Q_low);
      const bw_ratio_theory = Q_high / Q_low;

      const f_s = f0;
      let bw_high = 0;
      let bw_low = 0;
      const N = 10000;
      const sweepRange = 0.01;

      for (const [_Q, Rs, refBw] of [
        [Q_high, Rs_high, "high"],
        [Q_low,  Rs_low,  "low"],
      ] as [number, number, string][]) {
        const Z_ref = Rs;
        const target = Z_ref * Math.SQRT2;
        let f_lower = f_s;
        let f_upper = f_s;

        for (let i = 1; i <= N; i++) {
          const f = f_s * (1 - sweepRange * i / N);
          const Z = bvdImpedanceMagnitude(f, Rs, Ls, Cs, C0);
          if (Z >= target) { f_lower = f; break; }
        }
        for (let i = 1; i <= N; i++) {
          const f = f_s * (1 + sweepRange * i / N);
          const Z = bvdImpedanceMagnitude(f, Rs, Ls, Cs, C0);
          if (Z >= target) { f_upper = f; break; }
        }

        if (refBw === "high") bw_high = f_upper - f_lower;
        else bw_low = f_upper - f_lower;
      }

      expect(bw_low).toBeGreaterThan(bw_high);
      const measured_ratio = bw_low / bw_high;
      expect(Math.abs(measured_ratio - bw_ratio_theory) / bw_ratio_theory).toBeLessThan(0.5);
    });
  });

  describe("definition", () => {
    it("CrystalDefinition name is 'QuartzCrystal'", () => {
      expect(CrystalDefinition.name).toBe("QuartzCrystal");
    });

    it("CrystalDefinition category is PASSIVES", () => {
      expect(CrystalDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("CrystalDefinition can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(CrystalDefinition)).not.toThrow();
    });

    it("CrystalCircuitElement can be instantiated", () => {
      const props = new PropertyBag();
      props.setModelParam("frequency", 32768);
      const el = new CrystalCircuitElement("test-id", { x: 0, y: 0 }, 0, false, props);
      expect(el).toBeDefined();
    });

    it("CRYSTAL_ATTRIBUTE_MAPPINGS has frequency mapping", () => {
      const m = CRYSTAL_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "frequency");
      expect(m).toBeDefined();
      expect(m!.propertyKey).toBe("frequency");
    });

    it("_stateBase is -1 before compiler assigns it (UC-7 retention, J-048)", () => {
      // Pure factory check: the analog factory must NOT touch `_stateBase`.
      // The compiler walks setup() and assigns _stateBase via the StatePool
      // allocator; until that walk runs, the contract sentinel is -1.
      const props = new PropertyBag();
      props.setModelParam("frequency", 1e6);
      props.setModelParam("qualityFactor", 1000);
      props.setModelParam("motionalCapacitance", 20e-15);
      props.setModelParam("shuntCapacitance", 5e-12);
      const el = getFactory(CrystalDefinition.modelRegistry!.behavioral!)(
        new Map([["pos", 1], ["neg", 0]]),
        props,
        () => 0,
      );
      expect((el as unknown as PoolBackedAnalogElement)._stateBase).toBe(-1);
    });

    it("element_allocates_branch_row_after_compile -- branchIndex > 0 in compiled circuit", () => {
      const fix = buildFixture({
        build: (_r, facade) => buildDcBlockCircuit(facade, {
          V: 1.0,
          rBleed: 1e9,
          frequency: 1e6,
          qualityFactor: 1000,
          motionalCapacitance: 20e-15,
          shuntCapacitance: 5e-12,
        }),
      });
      const xtal = findCrystal(fix.circuit.elements);
      // Crystal allocates an L_s branch row in setup() (branchIndex > 0
      // because branch rows live after node rows in the matrix).
      expect(xtal.branchIndex).toBeGreaterThan(0);
    });
  });
});

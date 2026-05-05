/**
 * Tests for the dcopInitJct junction-priming phase.
 *
 * The MODEINITJCT priming behavior is observable via DC-OP convergence from
 * cold-start: if priming is broken, Newton-Raphson fails to converge.
 * Internal flag-transition assertions are deleted per §3 disposition rule
 * (no convergence consequence, §3 POISON-PATTERN, §4c J-121).
 */

import { describe, it, expect } from "vitest";
import { resolve } from "path";

import { buildFixture } from "./fixtures/build-fixture.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("dcopInitJct", () => {

  // ── BJT priming tests ──────────────────────────────────────────────────

  // Deleted: BJT simple (L0) primeJunctions — NPN: arms Vbe=tVcrit, Vbc=0 as per-device local override.
  // Coverage: ngspice-parity/bjt-common-emitter.test.ts (dc_op_match)
  // Reason: asserts internal MODEINITJCT flag transition with no convergence consequence; §3 POISON (direct element.load + hand-rolled LoadContext).

  // Deleted: BJT simple (L0) primeJunctions — PNP: arms Vbe=+tVcrit, Vbc=0.
  // Coverage: ngspice-parity/bjt-common-emitter.test.ts (dc_op_match)
  // Reason: asserts internal MODEINITJCT flag transition; §3 POISON (direct element.load + initElement).

  // Deleted: BJT simple (L0) primeJunctions — grounded collector (nodeC=0): priming is independent of node topology.
  // Coverage: ngspice-parity/bjt-common-emitter.test.ts (dc_op_match)
  // Reason: asserts internal MODEINITJCT flag transition; §3 POISON (direct element.load + initElement).

  // ── BJT SPICE L1 priming tests ─────────────────────────────────────────

  // Deleted: BJT SPICE L1 primeJunctions — NPN L1: arms Vbe=tVcrit, Vbc=0 as per-device local override.
  // Coverage: ngspice-parity/bjt-common-emitter.test.ts (dc_op_match)
  // Reason: asserts internal MODEINITJCT flag transition; §3 POISON (direct element.load + initElement).

  // ── Diode priming tests ────────────────────────────────────────────────

  // Deleted: Diode primeJunctions — arms Vd=tVcrit as per-device local override.
  // Coverage: ngspice-parity/diode-resistor.test.ts (dc_op_pnjlim_match)
  // Reason: asserts internal MODEINITJCT flag transition; §3 POISON (direct element.load + initElement).

  // Deleted: Diode primeJunctions — grounded cathode: priming is independent of node topology.
  // Coverage: ngspice-parity/diode-resistor.test.ts (dc_op_pnjlim_match)
  // Reason: asserts internal MODEINITJCT flag transition; §3 POISON (direct element.load + initElement).

  // ── dcopInitJct phase marker and iteration reduction ───────────────────

  // Deleted: solveDcOperatingPoint phase — emits dcopInitJct phase marker before dcopInitFloat.
  // Coverage: ngspice-parity/bjt-common-emitter.test.ts (dc_op_match), ngspice-parity/diode-resistor.test.ts (dc_op_pnjlim_match)
  // Reason: calls makeSimpleCtx + solveDcOperatingPoint directly; §3 POISON (fake coordinator + direct solver-stage entry point).

  describe("solveDcOperatingPoint phase", () => {
    it("NPN CE circuit (fixtures/npn-ce-harness.dts): DC OP converges with priming", () => {
      // Load the same fixture used by the ngspice comparison harness. This
      // exercises the full compile path (deserialize → compile → DC OP) so we
      // cover the real element/node wiring rather than a hand-rolled stamp.
      // The expected operating point is known from prior harness runs:
      //   Rb:B/Q1:B ≈ 1.4713 V   (base)
      //   Rc:B/Q1:C ≈ 6.7130 V   (collector)
      //   Re:A/Q1:E ≈ 0.7063 V   (emitter)
      // At t=0 the square wave source evaluates to V1 = dcOffset - amplitude
      // = 1.9 - 0.1 = 1.8 V under the ngspice PULSE convention.
      const fix = buildFixture({
        dtsPath: resolve(process.cwd(), "fixtures/npn-ce-harness.dts"),
      });

      const dcOp = fix.coordinator.dcOperatingPoint();
      expect(dcOp).not.toBeNull();
      expect(dcOp!.converged).toBe(true);

      // All node voltages finite.
      for (let i = 0; i < dcOp!.nodeVoltages.length; i++) {
        expect(
          Number.isFinite(dcOp!.nodeVoltages[i]),
          `node ${i} voltage should be finite, got ${dcOp!.nodeVoltages[i]}`,
        ).toBe(true);
      }

      // Locate BJT terminal nodes by scanning the result for voltages in the
      // expected physical ranges. (The facade doesn't expose a label→index
      // map from here, and we only need to assert the circuit is in the
      // active region — not hit exact values.)
      const voltages = Array.from(dcOp!.nodeVoltages);
      const inRange = (lo: number, hi: number) =>
        voltages.some((v) => v >= lo && v <= hi);

      // Base in active-region band (1.3 V … 1.6 V — harness observed 1.4713 V)
      expect(
        inRange(1.3, 1.6),
        `no node in base band [1.3, 1.6] V; voltages=${voltages.map((v) => v.toFixed(4)).join(", ")}`,
      ).toBe(true);

      // Collector pulled down from 10 V supply (6.0 V … 7.5 V — observed 6.7130 V)
      expect(
        inRange(6.0, 7.5),
        `no node in collector band [6.0, 7.5] V; voltages=${voltages.map((v) => v.toFixed(4)).join(", ")}`,
      ).toBe(true);

      // Emitter above ground, below base (0.6 V … 0.8 V — observed 0.7063 V)
      expect(
        inRange(0.6, 0.8),
        `no node in emitter band [0.6, 0.8] V; voltages=${voltages.map((v) => v.toFixed(4)).join(", ")}`,
      ).toBe(true);

      // Supply rail still at 10 V.
      expect(
        voltages.some((v) => v > 9.99 && v < 10.01),
        `no node at ~10 V supply; voltages=${voltages.map((v) => v.toFixed(4)).join(", ")}`,
      ).toBe(true);

      // Vin source terminal at 1.8 V (V1 = dcOffset - amplitude at t=0).
      expect(
        voltages.some((v) => v > 1.79 && v < 1.81),
        `no node at ~1.8 V Vin; voltages=${voltages.map((v) => v.toFixed(4)).join(", ")}`,
      ).toBe(true);
    });
  });
});

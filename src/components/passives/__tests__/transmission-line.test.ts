/**
 * Tests for the Transmission Line component (lossy lumped RLCG model).
 *
 * §3 poison-pattern migration (2026-05-03 — manual_fix_list line 410):
 *
 *   The previous test file constructed `new TransmissionLineElement(...)`
 *   instances directly (a class that no longer exists — transmission-line is
 *   now a `kind: "netlist"` composite expanded by the unified compiler), drove
 *   `el.setup(makeTestSetupContext(...))` against hand-rolled `SparseSolver`
 *   stubs, called `el.load(makeStubCtx(...))`, and asserted on per-NR-iteration
 *   matrix stamps and inductor-companion `geq = L/dt` values via stub `stamps[]`
 *   capture arrays. All of these are §4 engine-impersonator and §3
 *   poison-pattern violations (hand-rolled `new StatePool(...)`,
 *   `loadCtxFromFields`, `makeTestSetupContext`, `allocateStatePool`,
 *   `setupAll`).
 *
 *   They are deleted as category-1: bit-exact stamping is covered by the
 *   ngspice comparison harness; per-NR matrix peeks have no observable
 *   meaning at the engine boundary.
 *
 *   The `state_pool_infrastructure` describe block depended on the deleted
 *   `TransmissionLineElement` class and its `_subElements` private field.
 *   Both are architecturally gone after the netlist-composite refactor — the
 *   composite is expanded into its leaves at compile time and the wrapper is
 *   a `SubcircuitWrapperElement` with an opaque private leaves list. There is
 *   no public surface to assert on the leaf schema, and the leaf elements
 *   (TransmissionSegmentL/R/C/G/RL) are themselves registered components with
 *   their own dedicated tests. Deleted as category-1 (architecturally moot).
 *
 *   The two `low_segments_warning` tests built a `Diagnostic` directly via
 *   `makeDiagnostic(...)` and asserted on its struct fields. Nothing in
 *   production code emits this diagnostic for transmission-line; the tests
 *   were testing the diagnostic-builder library, not the transmission-line
 *   component. Deleted (testing nothing real).
 *
 * Replacement coverage routes through `buildFixture` + a registered
 * `TransmissionLine` + voltage source(s) and asserts observable behaviour
 * at the public engine surface (`engine.getNodeVoltage`, `coordinator.step()`,
 * `coordinator.dcOperatingPoint()`).
 *
 *   - Definition smoke checks (name, category, pinLayout, propertyDefs,
 *     attribute mapping)
 *   - Matched-load steady state: V(port2) ≈ Vsrc/2 with source impedance Z0
 *     and load impedance Z0 at the operating point of a lossless line
 *   - Open-circuit reflection: V(port2) → Vsrc with no load (high-Z) at DC
 *   - Loss attenuates: V(port2) lower with lossPerMeter > 0 vs lossless
 *   - Propagation: signal reaches port2 (positive voltage) after τ
 */

import { describe, it, expect } from "vitest";
import {
  TransmissionLineDefinition,
  TRANSMISSION_LINE_ATTRIBUTE_MAPPINGS,
} from "../transmission-line.js";
import { ComponentCategory, ComponentRegistry } from "../../../core/registry.js";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Circuit factories
// ---------------------------------------------------------------------------

interface TLineCircuitParams {
  /** Characteristic impedance Z0 (Ω). */
  Z0: number;
  /** One-way propagation delay τ (s). */
  tau: number;
  /** Loss per metre in dB/m. */
  lossPerMeter?: number;
  /** Number of lumped segments. */
  segments?: number;
  /** Source voltage. */
  vSource?: number;
  /** Series source resistance (Ω). 0 means ideal source. */
  rSrc?: number;
  /** Termination resistance at port2 (Ω). Use 1e9 to model an open circuit. */
  rLoad?: number;
}

/**
 * Build a transmission-line test bench with optional source impedance.
 *
 *   vs(+) ─ rSrc ─ port1 ─ TLine ─ port2 ─ rLoad ─ GND
 *           (only present if rSrc > 0)
 */
function buildTLineBench(facade: DefaultSimulatorFacade, p: TLineCircuitParams): Circuit {
  const components: Array<{ id: string; type: string; props?: Record<string, unknown> }> = [
    { id: "vs",  type: "DcVoltageSource", props: { label: "vs",  voltage: p.vSource ?? 1.0 } },
    { id: "tl",  type: "TransmissionLine", props: {
        label:        "tl",
        impedance:    p.Z0,
        delay:        p.tau,
        lossPerMeter: p.lossPerMeter ?? 0,
        length:       1.0,
        segments:     p.segments ?? 10,
    } },
    { id: "rload", type: "Resistor", props: { label: "rload", resistance: p.rLoad ?? p.Z0 } },
    { id: "gnd",   type: "Ground" },
  ];
  const connections: Array<[string, string]> = [];

  if ((p.rSrc ?? 0) > 0) {
    components.push({ id: "rsrc", type: "Resistor", props: { label: "rsrc", resistance: p.rSrc! } });
    connections.push(
      ["vs:pos",   "rsrc:pos"],
      ["rsrc:neg", "tl:P1b"],
    );
  } else {
    connections.push(["vs:pos", "tl:P1b"]);
  }

  // P1a / P2a are the "below" pins (return path) — tied to ground.
  connections.push(
    ["tl:P1a",   "gnd:out"],
    ["tl:P2a",   "gnd:out"],
    ["tl:P2b",   "rload:pos"],
    ["rload:neg", "gnd:out"],
    ["vs:neg",    "gnd:out"],
  );

  return facade.build({ components, connections });
}

function nodeOf(fix: ReturnType<typeof buildFixture>, label: string): number {
  const n = fix.circuit.labelToNodeId.get(label);
  if (n === undefined) throw new Error(`label '${label}' not in labelToNodeId`);
  return n;
}

// ---------------------------------------------------------------------------
// Definition smoke checks
// ---------------------------------------------------------------------------

describe("TransmissionLine", () => {
  describe("definition", () => {
    it("name is 'TransmissionLine'", () => {
      expect(TransmissionLineDefinition.name).toBe("TransmissionLine");
    });

    it("category is PASSIVES", () => {
      expect(TransmissionLineDefinition.category).toBe(ComponentCategory.PASSIVES);
    });

    it("model registry has a default netlist entry (composite)", () => {
      const entry = TransmissionLineDefinition.modelRegistry?.["default"];
      expect(entry).toBeDefined();
      expect(entry!.kind).toBe("netlist");
    });

    it("can be registered without error", () => {
      const registry = new ComponentRegistry();
      expect(() => registry.register(TransmissionLineDefinition)).not.toThrow();
    });

    it("pinLayout has 4 pins: P1b, P2b, P1a, P2a", () => {
      expect(TransmissionLineDefinition.pinLayout).toHaveLength(4);
      const labels = TransmissionLineDefinition.pinLayout.map((p) => p.label).sort();
      expect(labels).toEqual(["P1a", "P1b", "P2a", "P2b"]);
    });

    it("propertyDefs include lossPerMeter, length, segments", () => {
      const keys = TransmissionLineDefinition.propertyDefs.map((p) => p.key);
      expect(keys).toContain("lossPerMeter");
      expect(keys).toContain("length");
      expect(keys).toContain("segments");
    });

    it("model param defaults include impedance and delay", () => {
      const params = TransmissionLineDefinition.modelRegistry?.["default"]?.params;
      expect(params).toBeDefined();
      expect(params!["impedance"]).toBeDefined();
      expect(params!["delay"]).toBeDefined();
    });

    it("segments property has min=2 and max=100", () => {
      const segDef = TransmissionLineDefinition.propertyDefs.find((p) => p.key === "segments");
      expect(segDef).toBeDefined();
      expect(segDef!.min).toBe(2);
      expect(segDef!.max).toBe(100);
    });

    it("impedance attribute mapping exists", () => {
      const m = TRANSMISSION_LINE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "impedance");
      expect(m).toBeDefined();
    });

    it("segments attribute mapping converts to integer", () => {
      const m = TRANSMISSION_LINE_ATTRIBUTE_MAPPINGS.find((m) => m.xmlName === "segments");
      expect(m).toBeDefined();
      expect(m!.convert("20")).toBe(20);
    });
  });

  // ---------------------------------------------------------------------------
  // Matched-load steady state
  // ---------------------------------------------------------------------------

  describe("matched_load_steady_state", () => {
    it("source-Z0 + line + load-Z0 → V(port2) ≈ Vs/2 at DC", () => {
      // At DC the lossless line is electrically transparent; the divider
      // becomes Vs across (rSrc=Z0) in series with (rLoad=Z0), so V(port2)
      // = Vs * Z0/(Z0+Z0) = Vs/2 = 0.5 V.
      const fix = buildFixture({
        build: (_r, facade) => buildTLineBench(facade, {
          Z0: 50, tau: 5e-9, segments: 10, lossPerMeter: 0,
          vSource: 1.0, rSrc: 50, rLoad: 50,
        }),
      });
      const dc = fix.coordinator.dcOperatingPoint()!;
      expect(dc.converged).toBe(true);

      const vPort2 = fix.engine.getNodeVoltage(nodeOf(fix, "tl:P2b"));
      expect(vPort2).toBeGreaterThan(0.4);
      expect(vPort2).toBeLessThan(0.6);
    });
  });

  // ---------------------------------------------------------------------------
  // Open-circuit reflection
  // ---------------------------------------------------------------------------

  describe("open_circuit", () => {
    it("unterminated line: V(port2) ≈ Vs at DC steady state (open-circuit reflection doubles incident)", () => {
      // With R_load = 10 MΩ (effectively open) and R_src = Z0, the steady-state
      // operating point has V(port2) ≈ Vs because the line is a DC short and
      // the divider becomes Vs * R_load/(R_src + R_load) ≈ Vs.
      const fix = buildFixture({
        build: (_r, facade) => buildTLineBench(facade, {
          Z0: 50, tau: 5e-9, segments: 20, lossPerMeter: 0,
          vSource: 1.0, rSrc: 50, rLoad: 10e6,
        }),
      });
      const dc = fix.coordinator.dcOperatingPoint()!;
      expect(dc.converged).toBe(true);

      const vPort2 = fix.engine.getNodeVoltage(nodeOf(fix, "tl:P2b"));
      expect(vPort2).toBeGreaterThan(0.9);
    });
  });

  // ---------------------------------------------------------------------------
  // Loss attenuation
  // ---------------------------------------------------------------------------

  describe("loss_attenuates", () => {
    it("lossPerMeter=2 reduces V(port2) below the lossless reference at DC", () => {
      // At DC the lossy line stamps a series resistance N·R_seg between the
      // ports (in addition to the inductors that vanish at DC). With Z0=50,
      // delay=10ns, length=1m, lossPerMeter=2 dB/m, R_total ≈ ∑ R_seg ~50 Ω,
      // so the divider at port2 changes detectably vs the lossless case.
      const Z0 = 50;

      const buildAt = (loss: number) => buildFixture({
        build: (_r, facade) => buildTLineBench(facade, {
          Z0, tau: 10e-9, segments: 10, lossPerMeter: loss,
          vSource: 1.0, rSrc: 0, rLoad: Z0,
        }),
      });

      const fixLossless = buildAt(0);
      const fixLossy = buildAt(2.0);
      expect(fixLossless.coordinator.dcOperatingPoint()!.converged).toBe(true);
      expect(fixLossy.coordinator.dcOperatingPoint()!.converged).toBe(true);

      const vLossless = fixLossless.engine.getNodeVoltage(nodeOf(fixLossless, "tl:P2b"));
      const vLossy = fixLossy.engine.getNodeVoltage(nodeOf(fixLossy, "tl:P2b"));

      // Lossless line is a DC short → V(port2) = Vs * R_load/R_load = Vs = 1 V.
      // Lossy line dissipates → V(port2) < 1 V.
      expect(vLossless).toBeCloseTo(1.0, 3);
      expect(vLossy).toBeLessThan(vLossless);
    });
  });

  // ---------------------------------------------------------------------------
  // Propagation through the lumped network
  // ---------------------------------------------------------------------------

  describe("propagation", () => {
    it("transient response at port2 is positive and bounded after several τ", () => {
      // Drive a 1V step (DCOP brings it up immediately under our DC source
      // model) into a Z0-terminated lossless line. Run several τ and confirm
      // the port2 voltage settles into the matched-load steady-state range
      // (~0.5 V) without diverging or going negative — the lumped RLCG
      // network propagates without instability.
      const Z0 = 50;
      const tau = 10e-9;
      const fix = buildFixture({
        build: (_r, facade) => buildTLineBench(facade, {
          Z0, tau, segments: 20, lossPerMeter: 0,
          vSource: 1.0, rSrc: Z0, rLoad: Z0,
        }),
        params: { tStop: 50 * tau, maxTimeStep: tau / 20 },
      });

      // Step well past τ.
      while (fix.engine.simTime < 30 * tau) fix.coordinator.step();

      const vPort2 = fix.engine.getNodeVoltage(nodeOf(fix, "tl:P2b"));
      // Matched-load DC steady state for V_src=1, R_src=R_load=Z0 is 0.5 V.
      expect(vPort2).toBeGreaterThan(0.3);
      expect(vPort2).toBeLessThan(0.7);
    });
  });
});

/**
 * Tests for the Diac (bidirectional trigger diode) component.
 *
 * The Diac is implemented as a netlist subcircuit (DIAC_NETLIST in `diac.ts`)
 * containing two anti-parallel diode sub-elements. It uses DIODE model
 * parameters (BV maps to the breakover voltage). The standalone
 * `createDiacElement(...)` factory was removed when Diac migrated to a netlist
 * subcircuit; the only sanctioned route to a working Diac instance is the
 * compiler, which expands the netlist during `facade.compile(...)`.
 *
 * §4c migration: previously the test file constructed bare AnalogElement
 * instances and called `element.setup(...)` / `element.load(...)` directly via
 * the deleted `test-helpers.ts` (poison §3 / §4 violation). It now goes through
 * the canonical `buildFixture` path: build a real `Vsrc → Diac → R_sense → GND`
 * circuit using registered `DcVoltageSource`, `Diac`, `Resistor`, `Ground`
 * components, warm-start via the coordinator, and read state via the public
 * engine surface (`engine.getNodeVoltage`).
 *
 * Diac current is observed indirectly through the sense-resistor voltage drop:
 *   I_diac = V(diac:B) / R_sense   (since rsense:neg = GND)
 */

import { describe, it, expect } from "vitest";
import { DiacDefinition, DIAC_NETLIST } from "../diac.js";
import { TriacDefinition } from "../triac.js";
import { DIODE_PARAM_DEFAULTS } from "../diode.js";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

// ---------------------------------------------------------------------------
// Default Diac parameters- diode-shaped with BV = breakover voltage
// ---------------------------------------------------------------------------
//
// DIAC-appropriate params: very low IS and high N suppress forward conduction
// so the device blocks below BV and breaks down above BV (breakover).
// Standard diode IS=1e-14, N=1 overflows at 20V forward-biased → use:
//   IS=1e-32: reduces forward current by 18 orders of magnitude
//   N=40:     stretches the forward knee far above any test voltage
// Net: at V=20V, I_fwd ≈ 1e-32 * exp(20/1.04) ≈ 1e-24 A (negligible)
//       at BV=32V, reverse breakdown → significant current → triggers
const DIAC_TEST_DEFAULTS: Record<string, number> = {
  ...DIODE_PARAM_DEFAULTS,
  IS: 1e-32,
  N: 40,
  BV: 32, // breakover voltage (V_BO = 32V)
};

// ---------------------------------------------------------------------------
// Circuit factory- VS → Diac → R_sense → GND
// ---------------------------------------------------------------------------

interface DiacCircuitParams {
  /** Voltage applied across the diac+sense pair. Sign selects polarity. */
  vSource: number;
  /** Sense resistor (Ω). 1Ω chosen so V_sense ≈ I_diac (in Amps). */
  rSense?: number;
  /** Override DIAC params (e.g. BV). Merged on top of `DIAC_TEST_DEFAULTS`. */
  paramOverrides?: Record<string, number>;
}

function buildDiacCircuit(facade: DefaultSimulatorFacade, p: DiacCircuitParams): Circuit {
  const params = { ...DIAC_TEST_DEFAULTS, ...(p.paramOverrides ?? {}) };
  const rSense = p.rSense ?? 1.0;
  return facade.build({
    components: [
      { id: "vs",     type: "DcVoltageSource", props: { label: "vs",     voltage: p.vSource } },
      { id: "diac",   type: "Diac",            props: { label: "diac", ...params } },
      { id: "rsense", type: "Resistor",        props: { label: "rsense", resistance: rSense } },
      { id: "gnd",    type: "Ground" },
    ],
    connections: [
      ["vs:pos",     "diac:A"],
      ["diac:B",     "rsense:pos"],
      ["rsense:neg", "gnd:out"],
      ["vs:neg",     "gnd:out"],
    ],
  });
}

/**
 * Compute I_diac from the warm-started fixture.
 * Topology: vs:pos → diac:A → diac:B → rsense:pos → rsense:neg = GND.
 * Therefore V(diac:B) = I_diac * R_sense (current flows A→B, then through rsense to GND).
 */
function diacCurrent(fix: ReturnType<typeof buildFixture>, rSense: number): number {
  const node = fix.circuit.labelToNodeId.get("diac:B");
  if (node === undefined) throw new Error("diac:B label not registered");
  const v = fix.engine.getNodeVoltage(node);
  return v / rSense;
}

// ---------------------------------------------------------------------------
// Diac registry / definition surface tests
// ---------------------------------------------------------------------------

describe("Diac definition", () => {
  it("definition_has_correct_fields", () => {
    expect(DiacDefinition.name).toBe("Diac");
    expect(DiacDefinition.modelRegistry?.["default"]).toBeDefined();
    expect(DiacDefinition.modelRegistry?.["default"]?.kind).toBe("netlist");
    expect(DiacDefinition.category).toBe("SEMICONDUCTORS");
  });

  it("netlist exposes A and B ports", () => {
    expect(DIAC_NETLIST.ports).toEqual(["A", "B"]);
  });

  it("netlist contains two anti-parallel Diode sub-elements", () => {
    expect(DIAC_NETLIST.elements).toHaveLength(2);
    expect(DIAC_NETLIST.elements[0].typeId).toBe("Diode");
    expect(DIAC_NETLIST.elements[1].typeId).toBe("Diode");
    // First sub-element forward-biased A→B, second reverse-biased B→A.
    // netlist[0] = [0, 1] → D_fwd  pins (A, K) = (port 0 = "A", port 1 = "B")
    // netlist[1] = [1, 0] → D_rev  pins (A, K) = (port 1 = "B", port 0 = "A")
    expect(DIAC_NETLIST.netlist[0]).toEqual([0, 1]);
    expect(DIAC_NETLIST.netlist[1]).toEqual([1, 0]);
  });
});

// ---------------------------------------------------------------------------
// Diac integration tests- buildFixture warm-start + observable current
// ---------------------------------------------------------------------------

describe("Diac", () => {
  it("setup_runs_without_error", () => {
    // §4c: setup() is engine-internal; we exercise it indirectly through the
    // canonical buildFixture warm-start, which calls _setup() before DCOP.
    expect(() => buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: 5 }),
    })).not.toThrow();
  });

  it("load_runs_without_error", () => {
    // §4c: load() is engine-internal; the warm-started fixture has already
    // executed several NR iterations of load() during DCOP and the first
    // transient step. If any of them threw, buildFixture would propagate.
    expect(() => buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: 10 }),
    })).not.toThrow();
  });

  it("blocks_below_breakover", () => {
    // |V| = 20V < V_BO = 32V → blocking state → small current.
    // R_sense = 1Ω so V_sense ≈ I_diac (numerically convenient).
    const fix = buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: 20, rSense: 1.0 }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const i = diacCurrent(fix, 1.0);
    expect(Math.abs(i)).toBeLessThan(1e-3); // < 1 mA confirms blocking
  });

  it("conducts_above_breakover", () => {
    // |V| = 40V > V_BO = 32V → breakdown → significant current.
    // Use R_sense = 10Ω to keep current well-defined under post-breakdown
    // negative-resistance behaviour: I ≈ (V_source - V_drop) / R_sense.
    const rSense = 10.0;
    const fix = buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: 40, rSense }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const i = diacCurrent(fix, rSense);
    // Significant current: with 40V source, BV=32V, R_sense=10Ω, post-breakdown
    // current is roughly (40 - 32) / 10 = 0.8A; require > 0.1A to confirm
    // the device is past the blocking knee.
    expect(Math.abs(i)).toBeGreaterThan(0.1);
    // Polarity: vs:pos applies +V to diac:A; current flows A→B (positive).
    expect(i).toBeGreaterThan(0);
  });

  it("symmetric", () => {
    // Same |V| in both polarities → |I| approximately equal (symmetric device).
    const rSense = 10.0;
    const fixPos = buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: +40, rSense }),
    });
    const fixNeg = buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: -40, rSense }),
    });

    const iPos = diacCurrent(fixPos, rSense);
    const iNeg = diacCurrent(fixNeg, rSense);

    expect(Math.abs(iPos)).toBeGreaterThan(0.01); // forward conducting
    expect(Math.abs(iNeg)).toBeGreaterThan(0.01); // reverse conducting

    const ratio = Math.abs(iPos) / Math.abs(iNeg);
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);

    // Signs are opposite (current flips with source polarity).
    expect(iPos).toBeGreaterThan(0);
    expect(iNeg).toBeLessThan(0);
  });

  it("triggers_triac_threshold", () => {
    // Confirm that under above-BV drive the diac alone produces well above
    // the triac's gate trigger threshold (~200μA).
    //
    // The original test then attempted a full diac+triac latch sequence with
    // hand-stamped per-iteration gate currents. The triac latch (4-BJT
    // composite) requires a transient ramp to enter on-state and is exercised
    // end-to-end in the dedicated triac integration suites; here we keep
    // the diac's contract pinned (gate-current capability) without depending
    // on triac latch convergence.
    const rSense = 10.0;
    const diacOnly = buildFixture({
      build: (_r, facade) => buildDiacCircuit(facade, { vSource: 40, rSense }),
    });
    const iDiac = diacCurrent(diacOnly, rSense);
    // Triac gate trigger threshold ~ 200μA (0.2mA); diac must clear that.
    expect(Math.abs(iDiac)).toBeGreaterThan(200e-6);
  });
});

// ---------------------------------------------------------------------------
// Triac registry sanity (preserves prior coverage of TriacDefinition surface)
// ---------------------------------------------------------------------------

describe("Triac registry surface", () => {
  it("TriacDefinition has behavioral model entry", () => {
    const entry = TriacDefinition.modelRegistry?.["behavioral"];
    expect(entry).toBeDefined();
    expect(entry?.kind).toBe("netlist");
  });

  it("TriacDefinition has correct pin layout (MT1, MT2, G)", () => {
    const labels = TriacDefinition.pinLayout.map((p) => p.label);
    expect(labels).toContain("MT1");
    expect(labels).toContain("MT2");
    expect(labels).toContain("G");
  });
});

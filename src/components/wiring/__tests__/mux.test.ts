/**
 * Canonical tests for the Multiplexer (Mux) digital component.
 *
 * Tier: fixture-only (pure-digital, combinational; no analog domain).
 * Driver: facade.build({components, connections}) + facade.compile() +
 *   facade.setSignal / facade.step / facade.readSignal.
 *
 * Canon coverage:
 *   - Cat 9 (bridge / digital interaction): drive labelled In ports for
 *     selector and data inputs, step the engine, observe labelled Out port.
 *     Exercises sel=0 / sel=1 selection on a 1-bit selector mux with multi-bit
 *     data, sel sweep across all 4 inputs of a 2-bit selector mux, and the
 *     pin-width follower behaviour (output value follows the selected input
 *     on the next step after sel changes).
 *   - Cat 13 (port-width clamping on overrun): the `sel` pin is `selectorBits`
 *     wide. Driving a value wider than `selectorBits` from a labelled In sized
 *     to that pin masks via BitVector.fromNumber(value, selectorBits) inside
 *     setSignal — effective_sel = source & ((1 << selectorBits) - 1).
 *
 * Cat 1/2/3/5/6/7/8 do not apply: pure digital component with no analog
 * state pool, no MNA matrix, no DCOP, no junction limiting, no LTE rollback,
 * no breakpoints, no transient analog dynamics.
 * Cat 10 does not apply: MuxDefinition exposes a single digital `models.digital`
 * entry plus a `behavioral` netlist model — there is no second named-preset
 * with a closed-form parameter delta against the default to assert.
 * Cat 11 does not apply: `models.digital.outputSchema = ["out"]` (single output).
 * Cat 12 does not apply: production source documents no spec-mandated forbidden
 * input combinations; the selector indexes the data array directly.
 * Cat 14 does not apply: production source emits no runtime diagnostics keyed
 * on a simulation observable.
 * Cat 15 does not apply: production source registers no _onStateChange
 * writeback subscription back to PropertyBag.
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../register-all.js";
import type { SimulationCoordinator } from "../../../solver/coordinator-types.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Canonical builder for a digital fixture driven by labelled In ports and
// observed via a labelled Out port.
// ---------------------------------------------------------------------------

interface DigitalFixture {
  facade: DefaultSimulatorFacade;
  coordinator: SimulationCoordinator;
}

function buildDigital(spec: {
  components: ReadonlyArray<{ id: string; type: string; props?: Record<string, number | string | boolean> }>;
  connections: ReadonlyArray<readonly [string, string]>;
}): DigitalFixture {
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: spec.components.map((c) =>
      c.props === undefined
        ? { id: c.id, type: c.type }
        : { id: c.id, type: c.type, props: c.props },
    ),
    connections: spec.connections.map((c) => [c[0], c[1]] as [string, string]),
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

function drive(fix: DigitalFixture, values: Record<string, number>): void {
  for (const [label, value] of Object.entries(values)) {
    fix.facade.setSignal(fix.coordinator, label, value);
  }
  fix.facade.step(fix.coordinator);
}

function read(fix: DigitalFixture, label: string): number {
  return fix.facade.readSignal(fix.coordinator, label) as number;
}

// ---------------------------------------------------------------------------
// Mux fixture builders.
// Pin layout (Multiplexer):
//   sel              (input,  selectorBits wide)
//   in_0..in_{N-1}   (inputs, bitWidth      wide), N = 2^selectorBits
//   out              (output, bitWidth      wide)
// ---------------------------------------------------------------------------

function buildMux(opts: { selectorBits: number; bitWidth: number }): DigitalFixture {
  const { selectorBits, bitWidth } = opts;
  const N = 1 << selectorBits;
  const components: Array<{ id: string; type: string; props: Record<string, number | string | boolean> }> = [
    { id: "sel", type: "In", props: { label: "SEL", bitWidth: selectorBits } },
    { id: "mux", type: "Multiplexer", props: { selectorBits, bitWidth } },
    { id: "out", type: "Out", props: { label: "OUT", bitWidth } },
  ];
  const connections: Array<[string, string]> = [
    ["sel:out", "mux:sel"],
    ["mux:out", "out:in"],
  ];
  for (let i = 0; i < N; i++) {
    components.push({
      id: `i${i}`,
      type: "In",
      props: { label: `IN${i}`, bitWidth },
    });
    connections.push([`i${i}:out`, `mux:in_${i}`]);
  }
  return buildDigital({ components, connections });
}

// ===========================================================================
// Cat 9 — Bridge / digital interaction
// ===========================================================================

describe("Mux digital interaction (Cat 9) — 1-bit selector", () => {
  it("sel=0 routes in_0 to out (multi-bit data passes through)", () => {
    // 2-input mux (selectorBits=1), 8-bit data.
    // sel=0 → out = in_0.
    const fix = buildMux({ selectorBits: 1, bitWidth: 8 });
    drive(fix, { SEL: 0, IN0: 0xAA, IN1: 0xBB });
    expect(read(fix, "OUT")).toBe(0xAA);
  });

  it("sel=1 routes in_1 to out (multi-bit data passes through)", () => {
    // 2-input mux (selectorBits=1), 8-bit data.
    // sel=1 → out = in_1.
    const fix = buildMux({ selectorBits: 1, bitWidth: 8 });
    drive(fix, { SEL: 1, IN0: 0xAA, IN1: 0xBB });
    expect(read(fix, "OUT")).toBe(0xBB);
  });

  it("sel toggle 0->1->0 follows the addressed input on each step", () => {
    // Same fixture; sweep sel and assert OUT tracks the selected input
    // after each subsequent step.
    const fix = buildMux({ selectorBits: 1, bitWidth: 8 });
    drive(fix, { SEL: 0, IN0: 0x11, IN1: 0x22 });
    expect(read(fix, "OUT")).toBe(0x11);
    drive(fix, { SEL: 1 });
    expect(read(fix, "OUT")).toBe(0x22);
    drive(fix, { SEL: 0 });
    expect(read(fix, "OUT")).toBe(0x11);
  });

  it("1-bit data: sel=0 selects 0, sel=1 selects 1", () => {
    // 2-input mux (selectorBits=1), 1-bit data — degenerate width.
    const fix = buildMux({ selectorBits: 1, bitWidth: 1 });
    drive(fix, { SEL: 0, IN0: 0, IN1: 1 });
    expect(read(fix, "OUT")).toBe(0);
    drive(fix, { SEL: 1 });
    expect(read(fix, "OUT")).toBe(1);
  });
});

describe("Mux digital interaction (Cat 9) — 2-bit selector", () => {
  it("sel=0 routes in_0 to out (4-input mux)", () => {
    // 4-input mux (selectorBits=2), 8-bit data.
    const fix = buildMux({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 0, IN0: 0x11, IN1: 0x22, IN2: 0x33, IN3: 0x44 });
    expect(read(fix, "OUT")).toBe(0x11);
  });

  it("sel=1 routes in_1 to out (4-input mux)", () => {
    const fix = buildMux({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 1, IN0: 0x11, IN1: 0x22, IN2: 0x33, IN3: 0x44 });
    expect(read(fix, "OUT")).toBe(0x22);
  });

  it("sel=2 routes in_2 to out (4-input mux)", () => {
    const fix = buildMux({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 2, IN0: 0x11, IN1: 0x22, IN2: 0x33, IN3: 0x44 });
    expect(read(fix, "OUT")).toBe(0x33);
  });

  it("sel=3 routes in_3 to out (4-input mux)", () => {
    const fix = buildMux({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 3, IN0: 0x11, IN1: 0x22, IN2: 0x33, IN3: 0x44 });
    expect(read(fix, "OUT")).toBe(0x44);
  });

  it("32-bit data: sel routes wide values without truncation", () => {
    // 4-input mux (selectorBits=2), 32-bit data. Drive widely-spaced
    // patterns and confirm each routes through without bit loss.
    const fix = buildMux({ selectorBits: 2, bitWidth: 32 });
    drive(fix, {
      SEL: 1,
      IN0: 0x00000000,
      IN1: 0xCAFEBABE,
      IN2: 0xDEADBEEF,
      IN3: 0xFFFFFFFF,
    });
    expect(read(fix, "OUT") >>> 0).toBe(0xCAFEBABE);
    drive(fix, { SEL: 2 });
    expect(read(fix, "OUT") >>> 0).toBe(0xDEADBEEF);
    drive(fix, { SEL: 3 });
    expect(read(fix, "OUT") >>> 0).toBe(0xFFFFFFFF);
  });
});

// ===========================================================================
// Cat 13 — Port-width clamping on overrun
//
// The mux `sel` pin is `selectorBits` wide. The labelled In driving SEL is
// declared at the same width, and BitVector.fromNumber(value, selectorBits)
// inside setSignal masks the source value to the port width:
//   effective_sel = source & ((1 << selectorBits) - 1)
// ===========================================================================

describe("Mux Cat 13 — sel port-width clamping (selectorBits=1, 1-bit sel pin)", () => {
  it("sel source 0b10 (=2) masks to 0 → out = in_0", () => {
    // 1-bit sel port: source 2 = 0b10 → masked = 0.
    const fix = buildMux({ selectorBits: 1, bitWidth: 8 });
    drive(fix, { SEL: 2, IN0: 0xAA, IN1: 0xBB });
    expect(read(fix, "OUT")).toBe(0xAA);
  });

  it("sel source 0b11 (=3) masks to 1 → out = in_1", () => {
    // 1-bit sel port: source 3 = 0b11 → masked = 1.
    const fix = buildMux({ selectorBits: 1, bitWidth: 8 });
    drive(fix, { SEL: 3, IN0: 0xAA, IN1: 0xBB });
    expect(read(fix, "OUT")).toBe(0xBB);
  });
});

describe("Mux Cat 13 — sel port-width clamping (selectorBits=2, 2-bit sel pin)", () => {
  it("sel source 0b100 (=4) masks to 0 → out = in_0", () => {
    // 2-bit sel port: source 4 = 0b100 → masked = 0.
    const fix = buildMux({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 4, IN0: 0x11, IN1: 0x22, IN2: 0x33, IN3: 0x44 });
    expect(read(fix, "OUT")).toBe(0x11);
  });

  it("sel source 0b110 (=6) masks to 2 → out = in_2", () => {
    // 2-bit sel port: source 6 = 0b110 → masked = 2.
    const fix = buildMux({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 6, IN0: 0x11, IN1: 0x22, IN2: 0x33, IN3: 0x44 });
    expect(read(fix, "OUT")).toBe(0x33);
  });

  it("sel source 0b111 (=7) masks to 3 → out = in_3", () => {
    // 2-bit sel port: source 7 = 0b111 → masked = 3.
    const fix = buildMux({ selectorBits: 2, bitWidth: 8 });
    drive(fix, { SEL: 7, IN0: 0x11, IN1: 0x22, IN2: 0x33, IN3: 0x44 });
    expect(read(fix, "OUT")).toBe(0x44);
  });
});

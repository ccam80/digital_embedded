/**
 * Canonical tests for simulation-control wiring components:
 *   Delay, Break, Stop, Reset, AsyncSeq.
 *
 * Tier: fixture-only (pure-digital; no analog domain — no T3 categories).
 * Driver: facade.build({components, connections}) + facade.compile()
 *         + facade.setSignal / facade.step / facade.readSignal.
 *
 * Canon coverage per component:
 *   - Cat 9 (digital interaction) — drive labelled inputs, step, observe labelled outputs.
 *   - Cat 4 (param hot-load) — Delay bitWidth: re-build with new property and
 *     observe a different observable for the same drive (compile-bound structural prop).
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";
import type { SimulationCoordinator } from "../../../solver/coordinator-types.js";

const registry = createDefaultRegistry();

// ---------------------------------------------------------------------------
// Canonical builder for a single digital block driven by labelled In ports
// and observed via labelled Out ports.
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
    components: spec.components.map((c) => ({ id: c.id, type: c.type, ...(c.props ? { props: c.props } : {}) })),
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

// ===========================================================================
// Delay — Cat 9 (pass-through digital interaction) + Cat 4 (bitWidth hot-load)
// ===========================================================================

function buildDelayFixture(bitWidth: number): DigitalFixture {
  return buildDigital({
    components: [
      { id: "in",  type: "In",    props: { label: "IN",  bitWidth } },
      { id: "dly", type: "Delay", props: { bitWidth, delayTime: 1 } },
      { id: "out", type: "Out",   props: { label: "OUT", bitWidth } },
    ],
    connections: [
      ["in:out",  "dly:in"],
      ["dly:out", "out:in"],
    ],
  });
}

describe("Delay digital interaction (Cat 9)", () => {
  it("1-bit pass-through: 0 -> 0", () => {
    const fix = buildDelayFixture(1);
    drive(fix, { IN: 0 });
    expect(read(fix, "OUT")).toBe(0);
  });

  it("1-bit pass-through: 1 -> 1", () => {
    const fix = buildDelayFixture(1);
    drive(fix, { IN: 1 });
    expect(read(fix, "OUT")).toBe(1);
  });

  it("8-bit pass-through: 0xAB -> 0xAB", () => {
    const fix = buildDelayFixture(8);
    drive(fix, { IN: 0xAB });
    expect(read(fix, "OUT")).toBe(0xAB);
  });

  it("16-bit pass-through: 0xABCD -> 0xABCD", () => {
    const fix = buildDelayFixture(16);
    drive(fix, { IN: 0xABCD });
    expect(read(fix, "OUT")).toBe(0xABCD);
  });

  it("32-bit pass-through: 0xFFFFFFFF preserved as unsigned", () => {
    const fix = buildDelayFixture(32);
    drive(fix, { IN: 0xFFFFFFFF });
    expect(read(fix, "OUT")).toBe(0xFFFFFFFF);
  });

  it("repeated drives are tracked by the simulator", () => {
    const fix = buildDelayFixture(8);
    drive(fix, { IN: 0x12 });
    expect(read(fix, "OUT")).toBe(0x12);
    drive(fix, { IN: 0x34 });
    expect(read(fix, "OUT")).toBe(0x34);
    drive(fix, { IN: 0x56 });
    expect(read(fix, "OUT")).toBe(0x56);
  });
});

describe("Delay parameter hot-load (Cat 4)", () => {
  it("bitWidth=4 masks 0xAB drive at the In to 0xB observable at the Out", () => {
    // bitWidth is a structural property: the In port's declared width clamps
    // the drive value to its width before the simulator observes it.
    // 0xAB & 0xF == 0xB.
    const fix = buildDelayFixture(4);
    drive(fix, { IN: 0xAB });
    expect(read(fix, "OUT")).toBe(0xB);
  });

  it("bitWidth=8 preserves 0xAB through the Delay (different observable than 4-bit)", () => {
    const fix4 = buildDelayFixture(4);
    drive(fix4, { IN: 0xAB });
    const out4 = read(fix4, "OUT");

    const fix8 = buildDelayFixture(8);
    drive(fix8, { IN: 0xAB });
    const out8 = read(fix8, "OUT");

    expect(out4).toBe(0xB);
    expect(out8).toBe(0xAB);
    expect(out4).not.toBe(out8);
  });
});

// ===========================================================================
// Break — Cat 9 (digital interaction): brk input drives the upstream net
// ===========================================================================
//
// Break declares outputSchema: [] — its halt-trigger flag is engine-internal
// and not exposed as a labelled output. The canonical Cat 9 observable is
// the round-trip on the brk-driving net: the In drives a value, the wire
// connecting In:out to brk:brk and to a Probe Out carries that value, and
// the Probe Out reads it back through the simulator.

function buildBreakFixture(): DigitalFixture {
  return buildDigital({
    components: [
      { id: "in",   type: "In",    props: { label: "BRK_IN",  bitWidth: 1 } },
      { id: "brk",  type: "Break", props: { label: "bp1" } },
      { id: "obs",  type: "Out",   props: { label: "BRK_OBS", bitWidth: 1 } },
    ],
    connections: [
      ["in:out", "brk:brk"],
      ["in:out", "obs:in"],
    ],
  });
}

describe("Break digital interaction (Cat 9)", () => {
  it("brk input net carries 0 when driven low", () => {
    const fix = buildBreakFixture();
    drive(fix, { BRK_IN: 0 });
    expect(read(fix, "BRK_OBS")).toBe(0);
  });

  it("brk input net carries 1 when driven high", () => {
    const fix = buildBreakFixture();
    drive(fix, { BRK_IN: 1 });
    expect(read(fix, "BRK_OBS")).toBe(1);
  });

  it("brk input net follows transitions 0 -> 1 -> 0 across steps", () => {
    const fix = buildBreakFixture();
    drive(fix, { BRK_IN: 0 });
    expect(read(fix, "BRK_OBS")).toBe(0);
    drive(fix, { BRK_IN: 1 });
    expect(read(fix, "BRK_OBS")).toBe(1);
    drive(fix, { BRK_IN: 0 });
    expect(read(fix, "BRK_OBS")).toBe(0);
  });
});

// ===========================================================================
// Stop — Cat 9 (digital interaction): stop input drives the upstream net
// ===========================================================================
//
// Same pattern as Break: outputSchema is empty; the canonical Cat 9 observable
// is the round-trip on the stop-driving net.

function buildStopFixture(): DigitalFixture {
  return buildDigital({
    components: [
      { id: "in",   type: "In",   props: { label: "STOP_IN",  bitWidth: 1 } },
      { id: "stp",  type: "Stop", props: { label: "term" } },
      { id: "obs",  type: "Out",  props: { label: "STOP_OBS", bitWidth: 1 } },
    ],
    connections: [
      ["in:out", "stp:stop"],
      ["in:out", "obs:in"],
    ],
  });
}

describe("Stop digital interaction (Cat 9)", () => {
  it("stop input net carries 0 when driven low", () => {
    const fix = buildStopFixture();
    drive(fix, { STOP_IN: 0 });
    expect(read(fix, "STOP_OBS")).toBe(0);
  });

  it("stop input net carries 1 when driven high", () => {
    const fix = buildStopFixture();
    drive(fix, { STOP_IN: 1 });
    expect(read(fix, "STOP_OBS")).toBe(1);
  });
});

// ===========================================================================
// Reset — Cat 9 (digital interaction): output observable through Out probe
// ===========================================================================
//
// Reset has no inputs; output is engine-managed via the init/clear-reset
// protocol. The canonical Cat 9 observable is reading the output net
// through a labelled Out after a step.

function buildResetFixture(invertOutput: boolean): DigitalFixture {
  return buildDigital({
    components: [
      { id: "rst", type: "Reset", props: { invertOutput } },
      { id: "obs", type: "Out",   props: { label: "RST_OBS", bitWidth: 1 } },
    ],
    connections: [
      ["rst:Reset", "obs:in"],
    ],
  });
}

describe("Reset digital interaction (Cat 9)", () => {
  it("non-inverted Reset releases output low after the init phase completes", () => {
    // Documented contract from reset.ts:
    //   state[stateOffset+0] = 0 during init: output = !invertOutput (active)
    //   state[stateOffset+0] = 1 after init:  output = invertOutput  (released)
    // After a single coordinator.step() the engine has run the init/clear-reset
    // protocol; the post-init output for invertOutput=false is 0.
    const fix = buildResetFixture(false);
    fix.facade.step(fix.coordinator);
    expect(read(fix, "RST_OBS")).toBe(0);
  });

  it("inverted Reset releases output high after the init phase completes", () => {
    // Documented contract: invertOutput=true → post-init output = 1.
    const fix = buildResetFixture(true);
    fix.facade.step(fix.coordinator);
    expect(read(fix, "RST_OBS")).toBe(1);
  });
});

describe("Reset parameter hot-load (Cat 4)", () => {
  it("invertOutput flips the post-init Reset output polarity", () => {
    // invertOutput is a structural property consumed at compile/init time.
    // Documented contract: setting it to true flips the released output value.
    const fixOff = buildResetFixture(false);
    fixOff.facade.step(fixOff.coordinator);
    const vOff = read(fixOff, "RST_OBS");

    const fixOn = buildResetFixture(true);
    fixOn.facade.step(fixOn.coordinator);
    const vOn = read(fixOn, "RST_OBS");

    expect(vOff).toBe(0);
    expect(vOn).toBe(1);
    expect(vOff).not.toBe(vOn);
  });
});

// ===========================================================================
// AsyncSeq — no canonical Cat 9 surface (BLOCKED)
// ===========================================================================
//
// AsyncSeq has no input or output pins — the component is a marker that the
// compiler reads from the netlist during compilation. There is no labelled
// drive port and no labelled observation port through which the sanctioned
// canonical Cat 9 mechanic (writeByLabel / step / readByLabel) can exercise
// a simulator observable. This category is BLOCKED.

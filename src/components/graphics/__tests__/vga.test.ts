import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// VGA canonical test set
// Canon categories: 9 (Bridge / digital interaction — sink-side only)
// File tier: fixture-only (digital-only — facade.build + facade.compile +
// coordinator writeByLabel/step; buildFixture rejects digital-only circuits).
// VGA exposes 6 digital inputs (R, G, B, H, V, C) and 0 outputs; executeVga
// is a no-op (display-only sink), so the simulator-observable canonical
// surface is the engine's acceptance of writes on every documented input pin
// across one coordinator.step().
// ---------------------------------------------------------------------------

interface VgaFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

function buildVgaFixture(opts: {
  colorBits?: number;
  frameWidth?: number;
  frameHeight?: number;
}): VgaFixture {
  const colorBits = opts.colorBits ?? 4;
  const frameWidth = opts.frameWidth ?? 16;
  const frameHeight = opts.frameHeight ?? 8;

  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "rIn", type: "In", props: { label: "R_IN", bitWidth: colorBits } },
    { id: "gIn", type: "In", props: { label: "G_IN", bitWidth: colorBits } },
    { id: "bIn", type: "In", props: { label: "B_IN", bitWidth: colorBits } },
    { id: "hIn", type: "In", props: { label: "H_IN", bitWidth: 1 } },
    { id: "vIn", type: "In", props: { label: "V_IN", bitWidth: 1 } },
    { id: "cIn", type: "In", props: { label: "C_IN", bitWidth: 1 } },
    { id: "vga1", type: "VGA", props: { label: "SCREEN", colorBits, frameWidth, frameHeight } },
  ];

  const connections: Array<[string, string]> = [
    ["rIn:out", "vga1:R"],
    ["gIn:out", "vga1:G"],
    ["bIn:out", "vga1:B"],
    ["hIn:out", "vga1:H"],
    ["vIn:out", "vga1:V"],
    ["cIn:out", "vga1:C"],
  ];

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

describe("VGA — bridge / digital sink (T1)", () => {
  // -------------------------------------------------------------------------
  // Cat 9 — Bridge / digital interaction
  // VGA is a display-only sink (0 outputs). The canonical observable is that
  // the simulator accepts writes on every documented digital input pin and
  // a coordinator.step() completes — i.e. the digital domain wires the VGA
  // executeFn into the schedule and the no-op executeVga returns cleanly.
  // -------------------------------------------------------------------------

  it("accepts_writes_on_all_six_inputs_and_steps", () => {
    // Drive every documented input pin (R, G, B, H, V, C) with a non-zero
    // value at one bit width consistent with the colorBits property, then
    // step the coordinator. The simulator must accept every write and the
    // step must complete (no exception, no stagnation).
    const fix = buildVgaFixture({ colorBits: 4, frameWidth: 16, frameHeight: 8 });
    fix.coordinator.writeByLabel("R_IN", digital(0xF));
    fix.coordinator.writeByLabel("G_IN", digital(0xA));
    fix.coordinator.writeByLabel("B_IN", digital(0x5));
    fix.coordinator.writeByLabel("H_IN", digital(0));
    fix.coordinator.writeByLabel("V_IN", digital(0));
    fix.coordinator.writeByLabel("C_IN", digital(1));
    fix.coordinator.step();
    // Read each driven In's output back through its label — the simulator
    // round-trips the write to the wire bridging the In to the VGA pin,
    // which is the only digital observable for a zero-output sink.
    expect(fix.coordinator.readByLabel("R_IN")).toMatchObject({ type: "digital", value: 0xF });
    expect(fix.coordinator.readByLabel("G_IN")).toMatchObject({ type: "digital", value: 0xA });
    expect(fix.coordinator.readByLabel("B_IN")).toMatchObject({ type: "digital", value: 0x5 });
    expect(fix.coordinator.readByLabel("H_IN")).toMatchObject({ type: "digital", value: 0 });
    expect(fix.coordinator.readByLabel("V_IN")).toMatchObject({ type: "digital", value: 0 });
    expect(fix.coordinator.readByLabel("C_IN")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });

  it("clock_pin_toggle_propagates_through_step", () => {
    // The C pin is documented as clock-capable (isClock=true). Toggle the
    // clock through low → high → low across three steps; the simulator must
    // accept every transition and the wire driving C must reflect the
    // most-recent write at each step boundary.
    const fix = buildVgaFixture({ colorBits: 4, frameWidth: 16, frameHeight: 8 });
    fix.coordinator.writeByLabel("R_IN", digital(0));
    fix.coordinator.writeByLabel("G_IN", digital(0));
    fix.coordinator.writeByLabel("B_IN", digital(0));
    fix.coordinator.writeByLabel("H_IN", digital(0));
    fix.coordinator.writeByLabel("V_IN", digital(0));

    fix.coordinator.writeByLabel("C_IN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("C_IN")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.writeByLabel("C_IN", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("C_IN")).toMatchObject({ type: "digital", value: 1 });

    fix.coordinator.writeByLabel("C_IN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("C_IN")).toMatchObject({ type: "digital", value: 0 });
    fix.coordinator.dispose();
  });

  it("hsync_and_vsync_pins_accept_independent_writes", () => {
    // H and V are 1-bit sync pins. The simulator must accept independent
    // writes to each — driving H high while V stays low and vice versa
    // — across a step, and reflect each at its own label.
    const fix = buildVgaFixture({ colorBits: 4, frameWidth: 16, frameHeight: 8 });
    fix.coordinator.writeByLabel("R_IN", digital(0));
    fix.coordinator.writeByLabel("G_IN", digital(0));
    fix.coordinator.writeByLabel("B_IN", digital(0));
    fix.coordinator.writeByLabel("C_IN", digital(0));

    fix.coordinator.writeByLabel("H_IN", digital(1));
    fix.coordinator.writeByLabel("V_IN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("H_IN")).toMatchObject({ type: "digital", value: 1 });
    expect(fix.coordinator.readByLabel("V_IN")).toMatchObject({ type: "digital", value: 0 });

    fix.coordinator.writeByLabel("H_IN", digital(0));
    fix.coordinator.writeByLabel("V_IN", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("H_IN")).toMatchObject({ type: "digital", value: 0 });
    expect(fix.coordinator.readByLabel("V_IN")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });

  it("rgb_channel_widths_track_colorbits_eight", () => {
    // colorBits=8 widens R/G/B input wires to 8 bits. The simulator must
    // accept the full 8-bit value on each channel and round-trip it.
    const fix = buildVgaFixture({ colorBits: 8, frameWidth: 16, frameHeight: 8 });
    fix.coordinator.writeByLabel("R_IN", digital(0xFF));
    fix.coordinator.writeByLabel("G_IN", digital(0x80));
    fix.coordinator.writeByLabel("B_IN", digital(0x01));
    fix.coordinator.writeByLabel("H_IN", digital(0));
    fix.coordinator.writeByLabel("V_IN", digital(0));
    fix.coordinator.writeByLabel("C_IN", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("R_IN")).toMatchObject({ type: "digital", value: 0xFF });
    expect(fix.coordinator.readByLabel("G_IN")).toMatchObject({ type: "digital", value: 0x80 });
    expect(fix.coordinator.readByLabel("B_IN")).toMatchObject({ type: "digital", value: 0x01 });
    fix.coordinator.dispose();
  });

  it("multiple_steps_with_changing_inputs_complete_without_error", () => {
    // Drive a varying input pattern across many steps. The canonical
    // observable for a zero-output sink is that every coordinator.step()
    // completes (no stagnation, no exception) and the most-recent write
    // on each input is reflected at the matching label.
    const fix = buildVgaFixture({ colorBits: 4, frameWidth: 16, frameHeight: 8 });
    for (let i = 0; i < 16; i++) {
      fix.coordinator.writeByLabel("R_IN", digital(i & 0xF));
      fix.coordinator.writeByLabel("G_IN", digital((i + 4) & 0xF));
      fix.coordinator.writeByLabel("B_IN", digital((i + 8) & 0xF));
      fix.coordinator.writeByLabel("H_IN", digital(i % 8 === 0 ? 1 : 0));
      fix.coordinator.writeByLabel("V_IN", digital(i === 0 ? 1 : 0));
      fix.coordinator.writeByLabel("C_IN", digital(i & 1));
      fix.coordinator.step();
    }
    // Final state reflects the last iteration (i=15).
    expect(fix.coordinator.readByLabel("R_IN")).toMatchObject({ type: "digital", value: 0xF });
    expect(fix.coordinator.readByLabel("C_IN")).toMatchObject({ type: "digital", value: 1 });
    fix.coordinator.dispose();
  });
});

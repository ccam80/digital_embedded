import { describe, it, expect } from "vitest";

import { buildFixture } from "./fixtures/build-fixture.js";

// ---------------------------------------------------------------------------
// Driver — Cat 9 (bridge / digital interaction)
//
// Driver is a digital-default tri-state buffer. Cross-domain bridging
// converts analog rail voltages on the sel/in pins into digital logic via
// the input-pin loading model and the digital executeDriver fn produces an
// analog drive on `out` via the output-pin loading model. The canonical
// observable is the analog voltage at `drv:out` after a converged DCOP.
// ---------------------------------------------------------------------------

describe("Driver — bridge / digital (Cat 9, T1)", () => {
  it("sel_high_in_high_drives_output_above_logic_threshold", () => {
    // sel=HIGH, in=HIGH: driver passes input through. The shared analog net
    // at drv:out is pulled toward vOH (default 5 V) through rOut (default
    // 100 Ω) into a 10 kΩ load to ground. Closed-form DC voltage divider:
    //   v_out = vOH · R_load / (rOut + R_load) = 5 · 10000 / 10100 ≈ 4.95 V.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsIn",  type: "DcVoltageSource", props: { voltage: 3.3 } },
          { id: "vsSel", type: "DcVoltageSource", props: { voltage: 3.3 } },
          { id: "drv",   type: "Driver",          props: { label: "drv", model: "behavioral" } },
          { id: "rLoad", type: "Resistor",        props: { resistance: 10000 } },
          { id: "gnd",   type: "Ground" },
        ],
        connections: [
          ["vsIn:pos",  "drv:in"],
          ["vsSel:pos", "drv:sel"],
          ["drv:out",   "rLoad:pos"],
          ["rLoad:neg", "gnd:out"],
          ["vsIn:neg",  "gnd:out"],
          ["vsSel:neg", "gnd:out"],
        ],
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vOut = fix.facade.readAllSignals(fix.coordinator)["drv:out"];
    expect(vOut).toBeGreaterThan(3.0);
    expect(vOut).toBeLessThan(5.05);
  });

  it("sel_low_in_high_pulls_output_to_high_z_load_ground", () => {
    // sel=LOW: driver enters high-Z. The output-pin loading model collapses
    // to a 1 GΩ Norton conductance — the 10 kΩ load to ground dominates and
    // pulls the shared net to ≈ 0 V. Closed-form upper bound:
    //   v_out ≤ vOH · R_load / (R_HiZ + R_load) ≈ 5 · 1e4 / 1.0001e9 ≈ 5e-5 V,
    // well under the 0.1 V check.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vsIn",  type: "DcVoltageSource", props: { voltage: 3.3 } },
          { id: "vsSel", type: "DcVoltageSource", props: { voltage: 0.0 } },
          { id: "drv",   type: "Driver",          props: { label: "drv", model: "behavioral" } },
          { id: "rLoad", type: "Resistor",        props: { resistance: 10000 } },
          { id: "gnd",   type: "Ground" },
        ],
        connections: [
          ["vsIn:pos",  "drv:in"],
          ["vsSel:pos", "drv:sel"],
          ["drv:out",   "rLoad:pos"],
          ["rLoad:neg", "gnd:out"],
          ["vsIn:neg",  "gnd:out"],
          ["vsSel:neg", "gnd:out"],
        ],
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);
    const vOut = fix.facade.readAllSignals(fix.coordinator)["drv:out"];
    expect(vOut).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// LED — Cat 2 (DCOP, analytical)
//
// Single-port LED with cathode wired to analog ground inside the LED
// adapter. Series resistor and 3.3 V supply: a converged DCOP reports the
// red-LED forward voltage in its conduction band, and the loop current
// through the 330 Ω series resistor sits in the documented forward range.
// ---------------------------------------------------------------------------

describe("LED — DCOP analytical (Cat 2, T1)", () => {
  it("dcop_red_led_forward_voltage_and_current_in_band", () => {
    // 3.3 V supply, 330 Ω series, red LED forward voltage Vf ≈ 1.6–2.5 V at
    // this operating point. Closed-form forward current:
    //   iF = (3.3 − Vf) / 330 ≈ 1–5 mA, well inside the [1 mA, 15 mA] band.
    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "vs",  type: "DcVoltageSource", props: { voltage: 3.3 } },
          { id: "r1",  type: "Resistor",        props: { resistance: 330 } },
          { id: "led", type: "LED",             props: { color: "red", model: "red", label: "led" } },
          { id: "gnd", type: "Ground" },
        ],
        connections: [
          ["vs:pos",  "r1:pos"],
          ["r1:neg",  "led:in"],
          ["vs:neg",  "gnd:out"],
        ],
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const vAnode = fix.facade.readAllSignals(fix.coordinator)["led:in"];
    expect(vAnode).toBeGreaterThan(1.5);
    expect(vAnode).toBeLessThan(2.5);

    const iForward = (3.3 - vAnode) / 330;
    expect(iForward).toBeGreaterThan(1e-3);
    expect(iForward).toBeLessThan(15e-3);
  });
});

// ---------------------------------------------------------------------------
// SevenSeg — Cat 9 (bridge / digital interaction)
//
// SevenSeg is a digital sink with 8 segment inputs (a..g, dp). Driving the
// inputs through analog supplies cross-bridges into the digital domain via
// the input-pin loading model, executeSevenSeg packs the bits, and the
// active analog rails on the segment nets are observable through the
// labelled `seg:<segment>` connector readout.
// ---------------------------------------------------------------------------

describe("SevenSeg — bridge / digital (Cat 9, T1)", () => {
  it("digit_seven_segments_a_b_c_high_d_low_drives_active_rails", () => {
    // Digit "7": segments a, b, c at 3.3 V, d through dp at 0 V. The shared
    // analog nets at seg:a/b/c are forced to the supply rail by the driving
    // DcVoltageSource and seg:d sits at ground — DCOP is converged (the
    // SevenSeg behavioural pin loading does not stamp any non-trivial path
    // between segments).
    const segVoltages: Record<string, number> = {
      a: 3.3, b: 3.3, c: 3.3,
      d: 0.0, e: 0.0, f: 0.0, g: 0.0, dp: 0.0,
    };

    const fix = buildFixture({
      build: (_r, facade) => facade.build({
        components: [
          { id: "seg",  type: "SevenSeg",       props: { label: "seg", model: "behavioral" } },
          { id: "vsA",  type: "DcVoltageSource", props: { voltage: segVoltages.a } },
          { id: "vsB",  type: "DcVoltageSource", props: { voltage: segVoltages.b } },
          { id: "vsC",  type: "DcVoltageSource", props: { voltage: segVoltages.c } },
          { id: "vsD",  type: "DcVoltageSource", props: { voltage: segVoltages.d } },
          { id: "vsE",  type: "DcVoltageSource", props: { voltage: segVoltages.e } },
          { id: "vsF",  type: "DcVoltageSource", props: { voltage: segVoltages.f } },
          { id: "vsG",  type: "DcVoltageSource", props: { voltage: segVoltages.g } },
          { id: "vsDp", type: "DcVoltageSource", props: { voltage: segVoltages.dp } },
          { id: "gnd",  type: "Ground" },
        ],
        connections: [
          ["vsA:pos",  "seg:a"],
          ["vsB:pos",  "seg:b"],
          ["vsC:pos",  "seg:c"],
          ["vsD:pos",  "seg:d"],
          ["vsE:pos",  "seg:e"],
          ["vsF:pos",  "seg:f"],
          ["vsG:pos",  "seg:g"],
          ["vsDp:pos", "seg:dp"],
          ["vsA:neg",  "gnd:out"],
          ["vsB:neg",  "gnd:out"],
          ["vsC:neg",  "gnd:out"],
          ["vsD:neg",  "gnd:out"],
          ["vsE:neg",  "gnd:out"],
          ["vsF:neg",  "gnd:out"],
          ["vsG:neg",  "gnd:out"],
          ["vsDp:neg", "gnd:out"],
        ],
      }),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const signals = fix.facade.readAllSignals(fix.coordinator);
    // Active segments are pinned to the 3.3 V supply rail through the VS.
    expect(signals["seg:a"]).toBeGreaterThan(3.0);
    expect(signals["seg:b"]).toBeGreaterThan(3.0);
    expect(signals["seg:c"]).toBeGreaterThan(3.0);
    // Inactive segments sit at the ground rail (0 V) through the VS.
    expect(signals["seg:d"]).toBeLessThan(0.1);
    expect(signals["seg:e"]).toBeLessThan(0.1);
    expect(signals["seg:f"]).toBeLessThan(0.1);
    expect(signals["seg:g"]).toBeLessThan(0.1);
    expect(signals["seg:dp"]).toBeLessThan(0.1);
  });
});


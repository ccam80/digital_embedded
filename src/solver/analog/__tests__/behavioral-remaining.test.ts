/**
 * Tests for behavioral analog factories in behavioral-remaining.ts.
 *
 * Tests:
 *   - Driver: tri-state high output, Hi-Z mode
 *   - LED: forward current through diode model
 *   - SevenSeg: digit "7" segment drive
 *   - Registration: all "both" components in this task have analogFactory
 *
 * Migration pattern: DefaultSimulatorFacade- build a real circuit spec,
 * compile it, and assert on getDcOpResult() / readAllSignals().
 */

import { describe, it, expect } from "vitest";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import { createDefaultRegistry } from "../../../components/register-all.js";

// ---------------------------------------------------------------------------
// Component definitions imported for registration test
// ---------------------------------------------------------------------------
import { DriverDefinition } from "../../../components/wiring/driver.js";
import { DriverInvSelDefinition } from "../../../components/wiring/driver-inv.js";
import { SplitterDefinition } from "../../../components/wiring/splitter.js";
import { BusSplitterDefinition } from "../../../components/wiring/bus-splitter.js";
import { LedDefinition } from "../../../components/io/led.js";
import { SevenSegDefinition } from "../../../components/io/seven-seg.js";
import { SevenSegHexDefinition } from "../../../components/io/seven-seg-hex.js";
import { RelayDefinition } from "../../../components/switching/relay.js";
import { RelayDTDefinition } from "../../../components/switching/relay-dt.js";
import { SwitchDefinition } from "../../../components/switching/switch.js";
import { SwitchDTDefinition } from "../../../components/switching/switch-dt.js";
import { ButtonLEDDefinition } from "../../../components/io/button-led.js";

// ---------------------------------------------------------------------------
// Driver tests
// ---------------------------------------------------------------------------

describe("Driver", () => {
  /**
   * tri_state_high: enable=1 (sel HIGH), input=1 (HIGH)
   *
   * Circuit: DcVoltageSource(3.3V) → drv:in
   *          DcVoltageSource(3.3V) → drv:sel
   *          drv:out → Resistor(10kΩ) → Ground
   *
   * When sel=HIGH and in=HIGH the driver passes the input to the output.
   * Norton output: vOH through rOut=50Ω into 10kΩ load → vOut ≈ 3.28V > 3.0V.
   */
  it("tri_state_high", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vsIn",  type: "DcVoltageSource", props: { voltage: 3.3 } },
        { id: "vsSel", type: "DcVoltageSource", props: { voltage: 3.3 } },
        { id: "drv",   type: "Driver",          props: { label: "drv" } },
        { id: "rLoad", type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsIn:pos",  "drv:in"],
        ["vsSel:pos", "drv:sel"],
        ["drv:out",   "rLoad:A"],
        ["rLoad:B",   "gnd:out"],
        ["vsIn:neg",  "gnd:out"],
        ["vsSel:neg", "gnd:out"],
      ],
    });
    const coordinator = facade.compile(circuit);
    const dc = facade.getDcOpResult();
    expect(dc!.converged).toBe(true);
    const vOut = facade.readAllSignals(coordinator)["drv:out"];
    expect(vOut).toBeGreaterThan(3.0);
  });

  /**
   * tri_state_hiz: enable=0 (sel LOW) → output in Hi-Z mode
   *
   * Same topology but vsSel = 0V. The driver detects sel=LOW → Hi-Z.
   * Hi-Z mode: R_HiZ (10MΩ) from out to ground, no current source.
   * With 10kΩ load and no source → output ≈ 0V < 0.1V.
   */
  it("tri_state_hiz", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vsIn",  type: "DcVoltageSource", props: { voltage: 3.3 } },
        { id: "vsSel", type: "DcVoltageSource", props: { voltage: 0.0 } },
        { id: "drv",   type: "Driver",          props: { label: "drv" } },
        { id: "rLoad", type: "Resistor",        props: { resistance: 10000 } },
        { id: "gnd",   type: "Ground" },
      ],
      connections: [
        ["vsIn:pos",  "drv:in"],
        ["vsSel:pos", "drv:sel"],
        ["drv:out",   "rLoad:A"],
        ["rLoad:B",   "gnd:out"],
        ["vsIn:neg",  "gnd:out"],
        ["vsSel:neg", "gnd:out"],
      ],
    });
    const coordinator = facade.compile(circuit);
    const dc = facade.getDcOpResult();
    expect(dc!.converged).toBe(true);
    const vOut = facade.readAllSignals(coordinator)["drv:out"];
    expect(vOut).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// LED tests
// ---------------------------------------------------------------------------

describe("LED", () => {
  /**
   * forward_current_lights: 3.3V through 330Ω to LED anode, cathode to ground.
   *
   * Circuit: DcVoltageSource(3.3V) → Resistor(330Ω) → LED(red):in
   *
   * For red LED: Vf ≈ 1.8V at forward current → anode voltage 1.5V..2.5V.
   * Forward current through series resistor: (3.3 - 1.8) / 330 ≈ 4.5mA > 1mA.
   */
  it("forward_current_lights", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);
    const circuit = facade.build({
      components: [
        { id: "vs",  type: "DcVoltageSource", props: { voltage: 3.3 } },
        { id: "r1",  type: "Resistor",        props: { resistance: 330 } },
        { id: "led", type: "LED",             props: { color: "red", label: "led" } },
        { id: "gnd", type: "Ground" },
      ],
      connections: [
        ["vs:pos",  "r1:A"],
        ["r1:B",    "led:in"],
        ["vs:neg",  "gnd:out"],
      ],
    });
    const coordinator = facade.compile(circuit);
    const dc = facade.getDcOpResult();
    expect(dc!.converged).toBe(true);

    // LED anode voltage: readAllSignals returns the analog voltage at the "led:in" net
    const vAnode = facade.readAllSignals(coordinator)["led:in"];
    expect(vAnode).toBeGreaterThan(1.5);
    expect(vAnode).toBeLessThan(2.5);

    // Forward current through series resistor
    const iForward = (3.3 - vAnode) / 330;
    expect(iForward).toBeGreaterThan(1e-3);  // > 1mA
    expect(iForward).toBeLessThan(15e-3);    // < 15mA
  });
});

// ---------------------------------------------------------------------------
// SevenSeg tests
// ---------------------------------------------------------------------------

describe("SevenSeg", () => {
  /**
   * digit_display: drive segments for digit "7" (a, b, c active; rest off).
   *
   * Circuit: 8 DcVoltageSources driving segment pins a–g, dp.
   * Digit "7": a=3.3V, b=3.3V, c=3.3V, d–dp=0V.
   * Assertion: DCOP converges (SevenSeg analog element stamps correctly).
   */
  it("digit_display", () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    // Digit "7": segments a, b, c on; d, e, f, g, dp off
    const segVoltages: Record<string, number> = {
      a: 3.3, b: 3.3, c: 3.3,
      d: 0.0, e: 0.0, f: 0.0, g: 0.0, dp: 0.0,
    };

    const circuit = facade.build({
      components: [
        { id: "seg",  type: "SevenSeg",       props: { label: "seg" } },
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
    });
    const coordinator = facade.compile(circuit);
    const dc = facade.getDcOpResult();
    expect(dc!.converged).toBe(true);
    // Active segments (a, b, c) driven to 3.3V; VS forces node voltages
    const signals = facade.readAllSignals(coordinator);
    expect(signals["seg:a"]).toBeGreaterThan(3.0);
    expect(signals["seg:d"]).toBeLessThan(0.1);
  });
});

// ---------------------------------------------------------------------------
// Registration tests
// ---------------------------------------------------------------------------

describe("Registration", () => {
  /**
   * all_both_components_have_analog_factory:
   * All 12 components from task 6.1.4 must have both digital and analog models.
   */
  it("all_both_components_have_analog_factory", () => {
    const definitions = [
      DriverDefinition,
      DriverInvSelDefinition,
      SplitterDefinition,
      BusSplitterDefinition,
      LedDefinition,
      SevenSegDefinition,
      SevenSegHexDefinition,
      RelayDefinition,
      RelayDTDefinition,
      SwitchDefinition,
      SwitchDTDefinition,
      ButtonLEDDefinition,
    ];

    for (const def of definitions) {
      expect(
        def.models?.digital,
        `${def.name} should have a digital model`,
      ).toBeDefined();
      const registry = def.modelRegistry ?? {};
      expect(
        Object.keys(registry).length > 0,
        `${def.name} should have an analog model`,
      ).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// BLOCKED: remaining_pin_loading_propagates
//
// This test verifies that DigitalInputPinModel.setup() allocates/skips the
// MNA matrix diagonal based on the _pinLoading flag, by spying on
// allocElement calls. There is no public facade API that exposes per-net
// pin-loading overrides or matrix allocation tracking. Migrating this test
// via DefaultSimulatorFacade is not possible without tunneling through
// private APIs. This test requires a design decision:
//   Option A: expose a setPinLoadingOverride() public API on the facade.
//   Option B: delete the test and verify loading behavior at a higher level
//             (e.g., voltage sag under a high-impedance source).
//   Option C: keep as a white-box unit test below the facade boundary in a
//             dedicated internal test file (behavioral-element-internals.test.ts).
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { buildFixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { Circuit } from "../../../core/circuit.js";
import type { SignalValue } from "../../../compile/types.js";
import type { PropertyValue } from "../../../core/properties.js";

// ===========================================================================
// Probe canonical test set
// Canon categories applicable: 1 (init), 2 (DCOP analytical, T1), 9 (bridge).
// File tier: fixture-only.
//
// Probe is a pure measurement element with two registered model entries:
//   - models.digital  (executeFn copies the input slot to an internal
//                      storage slot for the measurement panel)
//   - modelRegistry.behavioral  (analog factory returning an AnalogProbeElement
//                                whose load() / setup() are no-ops; the probe
//                                contributes nothing to the MNA stamp).
//
// Because the probe stamps nothing, no dynamic behaviour exists for Cat 3
// (transient), Cat 5 (matrix parity), Cat 6 (limiting), Cat 7 (LTE),
// Cat 8 (breakpoints) — those categories are non-applicable. Cat 4 hot-load
// is non-applicable because AnalogProbeElement.setParam() is a no-op and
// no probe property scales / shifts a simulation observable. Cat 10 named
// model preset is non-applicable because modelRegistry has only the single
// "behavioral" entry. Probe is therefore a fixture-only file with the
// minimal canonical set { 1, 2-analytical, 9 }.
// ===========================================================================

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Analog circuit: V_S(volts) → probe:in ; V_S:neg → GND.
 *  Probe is a single-pin pure measurement sink, so the voltage at probe:in
 *  equals the source's pos-side voltage (no MNA contribution from the probe). */
function buildAnalogProbeCircuit(facade: DefaultSimulatorFacade, vSource: number): Circuit {
  return facade.build({
    components: [
      { id: "probe", type: "Probe",            props: { label: "probe", model: "behavioral", bitWidth: 1 } },
      { id: "vs",    type: "DcVoltageSource",  props: { label: "vs",    voltage: vSource } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vs:pos", "probe:in"],
      ["vs:neg", "gnd:out"],
    ],
  });
}

interface DigitalProbeFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

/** Digital circuit: DipSwitch(SW) → probe:in.
 *  The probe is a digital sink wrapped on a DipSwitch source so we can drive
 *  a known digital pattern into the probe's input via writeByLabel("SW", ...)
 *  and read the propagated value at the probe's input pin via readByLabel.
 *  A bare-label entry for "probe" is also created in labelSignalMap when the
 *  probe has a single pin, but the canonical mechanic uses the explicit
 *  pin-form address "probe:in". */
function buildDigitalProbeFixture(opts: { bitWidth: number; defaultValue?: number }): DigitalProbeFixture {
  const switchProps: Record<string, PropertyValue> = {
    label: "SW",
    bitCount: opts.bitWidth,
  };
  if (opts.defaultValue !== undefined) switchProps.defaultValue = opts.defaultValue;

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({
    components: [
      { id: "sw",    type: "DipSwitch", props: switchProps },
      { id: "probe", type: "Probe",     props: { label: "probe", bitWidth: opts.bitWidth } },
    ],
    connections: [
      ["sw:out", "probe:in"],
    ],
  });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ===========================================================================
// Probe — Cat 1 (initialization, T1)
// Post-warm-start: the analog probe's input node voltage equals the upstream
// source's pos-side voltage. The probe contributes no MNA stamp, so the
// observable at probe:in is exactly V_S at step 0.
// ===========================================================================

describe("Probe initialization (T1)", () => {
  it("init_analog_probe_node_voltage_equals_source_voltage_at_step_zero", () => {
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogProbeCircuit(facade, 2.5),
    });
    const probeNodeId = fix.circuit.labelToNodeId.get("probe:in")!;
    expect(probeNodeId).not.toBeUndefined();
    const v0 = fix.engine.getNodeVoltage(probeNodeId);
    expect(v0).toBeCloseTo(2.5, 6);
  });
});

// ===========================================================================
// Probe — Cat 2 (DC operating point, T1 analytical)
// Closed-form: voltage at probe:in equals V_S exactly because the probe
// stamps nothing into the MNA matrix. The DCOP converges immediately.
// ===========================================================================

describe("Probe DCOP analytical (T1)", () => {
  it("dcop_analog_probe_reads_source_voltage_at_node", () => {
    // Closed-form expected: V(probe:in) = V_S = 4.72V (probe stamps nothing).
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogProbeCircuit(facade, 4.72),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc).not.toBeNull();
    expect(dc!.converged).toBe(true);

    const probeNodeId = fix.circuit.labelToNodeId.get("probe:in")!;
    const vProbe = fix.engine.getNodeVoltage(probeNodeId);
    expect(vProbe).toBeCloseTo(4.72, 6);
  });

  it("dcop_analog_probe_reads_zero_when_source_is_zero", () => {
    // Closed-form expected: V(probe:in) = 0V when V_S = 0V.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogProbeCircuit(facade, 0),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    const probeNodeId = fix.circuit.labelToNodeId.get("probe:in")!;
    expect(fix.engine.getNodeVoltage(probeNodeId)).toBeCloseTo(0, 6);
  });

  it("dcop_analog_probe_reads_negative_source_voltage", () => {
    // Closed-form expected: V(probe:in) = -3.3V when V_S = -3.3V.
    const fix = buildFixture({
      build: (_r, facade) => buildAnalogProbeCircuit(facade, -3.3),
    });
    const dc = fix.coordinator.dcOperatingPoint();
    expect(dc!.converged).toBe(true);
    const probeNodeId = fix.circuit.labelToNodeId.get("probe:in")!;
    expect(fix.engine.getNodeVoltage(probeNodeId)).toBeCloseTo(-3.3, 6);
  });
});

// ===========================================================================
// Probe — Cat 9 (bridge / digital interaction, T1)
// Probe has a digital model and a single input pin. Drive a known digital
// value upstream via DipSwitch.SW, step, then read the value at probe:in
// via readByLabel. The input pin label is the canonical observable.
// ===========================================================================

describe("Probe bridge / digital (Cat 9, T1)", () => {
  it("digital_one_bit_high_propagates_to_probe_input", () => {
    const fix = buildDigitalProbeFixture({ bitWidth: 1 });
    fix.coordinator.writeByLabel("SW", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("probe:in")).toMatchObject({
      type: "digital",
      value: 1,
    });
    fix.coordinator.dispose();
  });

  it("digital_one_bit_low_propagates_to_probe_input", () => {
    const fix = buildDigitalProbeFixture({ bitWidth: 1 });
    fix.coordinator.writeByLabel("SW", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("probe:in")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("digital_four_bit_pattern_0b1010_propagates_to_probe_input", () => {
    const fix = buildDigitalProbeFixture({ bitWidth: 4 });
    fix.coordinator.writeByLabel("SW", digital(0b1010));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("probe:in")).toMatchObject({
      type: "digital",
      value: 0b1010,
    });
    fix.coordinator.dispose();
  });

  it("digital_eight_bit_pattern_0xA5_propagates_to_probe_input", () => {
    const fix = buildDigitalProbeFixture({ bitWidth: 8 });
    fix.coordinator.writeByLabel("SW", digital(0xA5));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("probe:in")).toMatchObject({
      type: "digital",
      value: 0xA5,
    });
    fix.coordinator.dispose();
  });

  it("digital_eight_bit_pattern_0xFF_propagates_to_probe_input", () => {
    const fix = buildDigitalProbeFixture({ bitWidth: 8 });
    fix.coordinator.writeByLabel("SW", digital(0xFF));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("probe:in")).toMatchObject({
      type: "digital",
      value: 0xFF,
    });
    fix.coordinator.dispose();
  });

  it("digital_rewrite_input_pattern_replaces_previous_value_at_probe_input", () => {
    // Sequence: write 0xF0, step, read 0xF0; then write 0x0F, step, read 0x0F.
    // Asserts the probe's input pin tracks the live driver value, not latched.
    const fix = buildDigitalProbeFixture({ bitWidth: 8 });
    fix.coordinator.writeByLabel("SW", digital(0xF0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("probe:in")).toMatchObject({
      type: "digital",
      value: 0xF0,
    });
    fix.coordinator.writeByLabel("SW", digital(0x0F));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("probe:in")).toMatchObject({
      type: "digital",
      value: 0x0F,
    });
    fix.coordinator.dispose();
  });

  it("digital_default_value_seed_propagates_to_probe_input_after_step", () => {
    // DipSwitch.defaultValue seeds the upstream net at digital init; the
    // probe input observes the seeded value after one step with no
    // intervening writeByLabel.
    const fix = buildDigitalProbeFixture({ bitWidth: 4, defaultValue: 0b1100 });
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("probe:in")).toMatchObject({
      type: "digital",
      value: 0b1100,
    });
    fix.coordinator.dispose();
  });
});

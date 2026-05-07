import { describe, it, expect } from "vitest";
import { createDefaultRegistry } from "../../register-all.js";
import { DefaultSimulatorFacade } from "../../../headless/default-facade.js";
import type { PropertyValue } from "../../../core/properties.js";
import type { SignalValue } from "../../../compile/types.js";

// ---------------------------------------------------------------------------
// Canon set: 9 (Bridge / digital interaction)
// File tier: fixture-only (digital-only — RotEncoder, StepperMotorBipolar,
// StepperMotorUnipolar are pure-digital IO components with only
// models.digital.executeFn; no analog stamping, no setup()/load(), no
// junction limiting, no LTE, no breakpoint registration. buildFixture()
// requires an analog domain, so the canonical mechanic is
// facade.build({components, connections}) + facade.compile() +
// coordinator.writeByLabel/step/readByLabel.
// ---------------------------------------------------------------------------

interface DigitalFixture {
  facade: DefaultSimulatorFacade;
  coordinator: ReturnType<DefaultSimulatorFacade["compile"]>;
}

function digital(value: number): SignalValue {
  return { type: "digital", value };
}

// ---------------------------------------------------------------------------
// RotaryEncoder fixture: stand-alone encoder whose A and B outputs are
// observed via labelled Out components downstream. RotEncoder has zero
// input pins (its position is an internal scratch state slot only mutated
// by user-interaction events; not label-addressable). The canonical
// observable is the power-on output pattern produced by executeRotaryEncoder
// reading the default-zero position scratch slot.
// ---------------------------------------------------------------------------

function buildRotaryEncoderFixture(opts?: { encoderLabel?: string }): DigitalFixture {
  const encoderLabel = opts?.encoderLabel ?? "RE1";

  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "re1", type: "RotEncoder", props: { label: encoderLabel } },
    { id: "outA", type: "Out", props: { label: "OUT_A", bitWidth: 1 } },
    { id: "outB", type: "Out", props: { label: "OUT_B", bitWidth: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["re1:A", "outA:in"],
    ["re1:B", "outB:in"],
  ];

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ---------------------------------------------------------------------------
// StepperMotorBipolar fixture: 4 In sources drive the A+/A-/B+/B- coil
// inputs; S0 and S1 are observed via labelled Out components downstream.
// ---------------------------------------------------------------------------

function buildBipolarFixture(opts?: { motorLabel?: string }): DigitalFixture {
  const motorLabel = opts?.motorLabel ?? "M_BI";

  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "in_ap", type: "In", props: { label: "AP", bitWidth: 1 } },
    { id: "in_an", type: "In", props: { label: "AN", bitWidth: 1 } },
    { id: "in_bp", type: "In", props: { label: "BP", bitWidth: 1 } },
    { id: "in_bn", type: "In", props: { label: "BN", bitWidth: 1 } },
    { id: "m1", type: "StepperMotorBipolar", props: { label: motorLabel } },
    { id: "outS0", type: "Out", props: { label: "OUT_S0", bitWidth: 1 } },
    { id: "outS1", type: "Out", props: { label: "OUT_S1", bitWidth: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["in_ap:out", "m1:A+"],
    ["in_an:out", "m1:A-"],
    ["in_bp:out", "m1:B+"],
    ["in_bn:out", "m1:B-"],
    ["m1:S0", "outS0:in"],
    ["m1:S1", "outS1:in"],
  ];

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ---------------------------------------------------------------------------
// StepperMotorUnipolar fixture: 5 In sources drive P0..P3 + com; S0 and S1
// are observed via labelled Out components downstream.
// ---------------------------------------------------------------------------

function buildUnipolarFixture(opts?: { motorLabel?: string }): DigitalFixture {
  const motorLabel = opts?.motorLabel ?? "M_UNI";

  const components: Array<{ id: string; type: string; props: Record<string, PropertyValue> }> = [
    { id: "in_p0", type: "In", props: { label: "P0_IN", bitWidth: 1 } },
    { id: "in_p1", type: "In", props: { label: "P1_IN", bitWidth: 1 } },
    { id: "in_p2", type: "In", props: { label: "P2_IN", bitWidth: 1 } },
    { id: "in_p3", type: "In", props: { label: "P3_IN", bitWidth: 1 } },
    { id: "in_com", type: "In", props: { label: "COM_IN", bitWidth: 1 } },
    { id: "m1", type: "StepperMotorUnipolar", props: { label: motorLabel } },
    { id: "outS0", type: "Out", props: { label: "OUT_S0", bitWidth: 1 } },
    { id: "outS1", type: "Out", props: { label: "OUT_S1", bitWidth: 1 } },
  ];
  const connections: Array<[string, string]> = [
    ["in_p0:out", "m1:P0"],
    ["in_p1:out", "m1:P1"],
    ["in_p2:out", "m1:P2"],
    ["in_p3:out", "m1:P3"],
    ["in_com:out", "m1:com"],
    ["m1:S0", "outS0:in"],
    ["m1:S1", "outS1:in"],
  ];

  const registry = createDefaultRegistry();
  const facade = new DefaultSimulatorFacade(registry);
  const circuit = facade.build({ components, connections });
  const coordinator = facade.compile(circuit);
  return { facade, coordinator };
}

// ===========================================================================
// RotEncoder — bridge / digital (Cat 9, T1)
// ===========================================================================

describe("RotEncoder — bridge / digital (Cat 9, T1)", () => {
  it("power_on_position_zero_drives_A_low_and_B_low", () => {
    // Documented contract: position 0 maps to QUADRATURE_TABLE[0] = [0, 0].
    // RotEncoder has no input pins; the position scratch slot defaults to 0
    // at construction, so executeRotaryEncoder publishes [A=0, B=0] on the
    // first coordinator.step().
    const fix = buildRotaryEncoderFixture();
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_A")).toMatchObject({
      type: "digital",
      value: 0,
    });
    expect(fix.coordinator.readByLabel("OUT_B")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("default_outputs_are_stable_across_repeated_steps", () => {
    // Documented contract: with no interaction (position scratch slot
    // unchanged), repeated coordinator.step() calls keep both outputs at
    // the QUADRATURE_TABLE[0] pattern.
    const fix = buildRotaryEncoderFixture();
    for (let i = 0; i < 4; i++) {
      fix.coordinator.step();
      expect(fix.coordinator.readByLabel("OUT_A")).toMatchObject({
        type: "digital",
        value: 0,
      });
      expect(fix.coordinator.readByLabel("OUT_B")).toMatchObject({
        type: "digital",
        value: 0,
      });
    }
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// StepperMotorBipolar — bridge / digital (Cat 9, T1)
// ===========================================================================

describe("StepperMotorBipolar — bridge / digital (Cat 9, T1)", () => {
  it("step_0_coil_pattern_drives_S0_low_S1_low", () => {
    // BIPOLAR_STEP_SEQUENCE[0] = [A+=1, A-=0, B+=1, B-=0] → stepIndex = 0
    // Documented contract: S0 = stepIndex & 0x3 = 0, S1 = (stepIndex >> 2) & 0x3 = 0.
    const fix = buildBipolarFixture();
    fix.coordinator.writeByLabel("AP", digital(1));
    fix.coordinator.writeByLabel("AN", digital(0));
    fix.coordinator.writeByLabel("BP", digital(1));
    fix.coordinator.writeByLabel("BN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 0,
    });
    expect(fix.coordinator.readByLabel("OUT_S1")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("step_1_coil_pattern_drives_S0_high_S1_low", () => {
    // BIPOLAR_STEP_SEQUENCE[1] = [A+=0, A-=1, B+=1, B-=0] → stepIndex = 1
    // Documented contract: S0 = 1 & 0x3 = 1, S1 = (1 >> 2) & 0x3 = 0.
    const fix = buildBipolarFixture();
    fix.coordinator.writeByLabel("AP", digital(0));
    fix.coordinator.writeByLabel("AN", digital(1));
    fix.coordinator.writeByLabel("BP", digital(1));
    fix.coordinator.writeByLabel("BN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 1,
    });
    expect(fix.coordinator.readByLabel("OUT_S1")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("step_2_coil_pattern_drives_S0_to_documented_index_value", () => {
    // BIPOLAR_STEP_SEQUENCE[2] = [A+=0, A-=1, B+=0, B-=1] → stepIndex = 2.
    // Documented contract per executeStepperMotorBipolar:
    //   state[wt[outBase]]     = stepIndex & 0x3  → S0 = 2
    //   state[wt[outBase + 1]] = (stepIndex >> 2) & 0x3  → S1 = 0
    const fix = buildBipolarFixture();
    fix.coordinator.writeByLabel("AP", digital(0));
    fix.coordinator.writeByLabel("AN", digital(1));
    fix.coordinator.writeByLabel("BP", digital(0));
    fix.coordinator.writeByLabel("BN", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 2,
    });
    expect(fix.coordinator.readByLabel("OUT_S1")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("step_3_coil_pattern_drives_S0_to_documented_index_value", () => {
    // BIPOLAR_STEP_SEQUENCE[3] = [A+=1, A-=0, B+=0, B-=1] → stepIndex = 3.
    // Documented contract: S0 = 3 & 0x3 = 3, S1 = (3 >> 2) & 0x3 = 0.
    const fix = buildBipolarFixture();
    fix.coordinator.writeByLabel("AP", digital(1));
    fix.coordinator.writeByLabel("AN", digital(0));
    fix.coordinator.writeByLabel("BP", digital(0));
    fix.coordinator.writeByLabel("BN", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 3,
    });
    expect(fix.coordinator.readByLabel("OUT_S1")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("changing_coil_pattern_updates_S0_after_a_single_step", () => {
    // Documented contract: outputs are the live readout of the coil-pattern
    // detector, not latched. Drive step 0, observe S0=0; drive step 1,
    // observe S0=1.
    const fix = buildBipolarFixture();
    fix.coordinator.writeByLabel("AP", digital(1));
    fix.coordinator.writeByLabel("AN", digital(0));
    fix.coordinator.writeByLabel("BP", digital(1));
    fix.coordinator.writeByLabel("BN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 0,
    });

    fix.coordinator.writeByLabel("AP", digital(0));
    fix.coordinator.writeByLabel("AN", digital(1));
    fix.coordinator.writeByLabel("BP", digital(1));
    fix.coordinator.writeByLabel("BN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 1,
    });
    fix.coordinator.dispose();
  });
});

// ===========================================================================
// StepperMotorUnipolar — bridge / digital (Cat 9, T1)
// ===========================================================================

describe("StepperMotorUnipolar — bridge / digital (Cat 9, T1)", () => {
  it("step_0_coil_pattern_drives_S0_low_S1_low", () => {
    // UNIPOLAR_STEP_SEQUENCE[0] = [P0=1, P1=0, P2=0, P3=0] → stepIndex = 0
    // (com is not used in step detection per executeStepperMotorUnipolar).
    const fix = buildUnipolarFixture();
    fix.coordinator.writeByLabel("P0_IN", digital(1));
    fix.coordinator.writeByLabel("P1_IN", digital(0));
    fix.coordinator.writeByLabel("P2_IN", digital(0));
    fix.coordinator.writeByLabel("P3_IN", digital(0));
    fix.coordinator.writeByLabel("COM_IN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 0,
    });
    expect(fix.coordinator.readByLabel("OUT_S1")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("step_1_coil_pattern_drives_S0_high_S1_low", () => {
    // UNIPOLAR_STEP_SEQUENCE[1] = [P0=0, P1=1, P2=0, P3=0] → stepIndex = 1
    const fix = buildUnipolarFixture();
    fix.coordinator.writeByLabel("P0_IN", digital(0));
    fix.coordinator.writeByLabel("P1_IN", digital(1));
    fix.coordinator.writeByLabel("P2_IN", digital(0));
    fix.coordinator.writeByLabel("P3_IN", digital(0));
    fix.coordinator.writeByLabel("COM_IN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 1,
    });
    expect(fix.coordinator.readByLabel("OUT_S1")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("step_2_coil_pattern_drives_S0_to_documented_index_value", () => {
    // UNIPOLAR_STEP_SEQUENCE[2] = [P0=0, P1=0, P2=1, P3=0] → stepIndex = 2.
    // Documented contract per executeStepperMotorUnipolar:
    //   state[wt[outBase]]     = stepIndex & 0x3  → S0 = 2
    //   state[wt[outBase + 1]] = (stepIndex >> 2) & 0x3  → S1 = 0
    const fix = buildUnipolarFixture();
    fix.coordinator.writeByLabel("P0_IN", digital(0));
    fix.coordinator.writeByLabel("P1_IN", digital(0));
    fix.coordinator.writeByLabel("P2_IN", digital(1));
    fix.coordinator.writeByLabel("P3_IN", digital(0));
    fix.coordinator.writeByLabel("COM_IN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 2,
    });
    expect(fix.coordinator.readByLabel("OUT_S1")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("step_3_coil_pattern_drives_S0_to_documented_index_value", () => {
    // UNIPOLAR_STEP_SEQUENCE[3] = [P0=0, P1=0, P2=0, P3=1] → stepIndex = 3.
    // Documented contract: S0 = 3 & 0x3 = 3, S1 = (3 >> 2) & 0x3 = 0.
    const fix = buildUnipolarFixture();
    fix.coordinator.writeByLabel("P0_IN", digital(0));
    fix.coordinator.writeByLabel("P1_IN", digital(0));
    fix.coordinator.writeByLabel("P2_IN", digital(0));
    fix.coordinator.writeByLabel("P3_IN", digital(1));
    fix.coordinator.writeByLabel("COM_IN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 3,
    });
    expect(fix.coordinator.readByLabel("OUT_S1")).toMatchObject({
      type: "digital",
      value: 0,
    });
    fix.coordinator.dispose();
  });

  it("com_pin_value_does_not_alter_step_detection", () => {
    // executeStepperMotorUnipolar reads only P0..P3 for step detection;
    // com (inputStart+4) is the common line, ignored. Drive step-1 coil
    // pattern with com=0 then com=1 and observe identical S0 output.
    const fix = buildUnipolarFixture();
    fix.coordinator.writeByLabel("P0_IN", digital(0));
    fix.coordinator.writeByLabel("P1_IN", digital(1));
    fix.coordinator.writeByLabel("P2_IN", digital(0));
    fix.coordinator.writeByLabel("P3_IN", digital(0));
    fix.coordinator.writeByLabel("COM_IN", digital(0));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 1,
    });

    fix.coordinator.writeByLabel("COM_IN", digital(1));
    fix.coordinator.step();
    expect(fix.coordinator.readByLabel("OUT_S0")).toMatchObject({
      type: "digital",
      value: 1,
    });
    fix.coordinator.dispose();
  });
});

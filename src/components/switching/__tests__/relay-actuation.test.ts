/**
 * Regression test for the Relay's RelayCoupling siblingBranch / siblingState
 * actuation path.
 *
 * The Relay netlist (`RELAY_NETLIST` in `relay.ts`) emits a RelayCoupling
 * sub-element with two compiler-resolved refs:
 *   coilBranch:   { kind: "siblingBranch", subElementName: "coilL" }
 *   switchClosed: { kind: "siblingState",  subElementName: "contactSW",
 *                   slotName: "CLOSED" }
 *
 * Pre-Wave-10 the compiler resolved `${labelRef.value}:${subElementName}` at
 * sub-element construction time, when `labelRef.value` was still the empty
 * string. RelayCoupling's setup() then called
 * `ctx.findBranch(":coilL")` and `findBranch` returned 0 — the threshold
 * comparison effectively saw zero coil current and the switch never closed.
 *
 * This test wires up a coil bench that drives current well above the default
 * pull-in threshold (pullInI = 0.05A) and asserts that the Switch's CLOSED
 * pool slot transitions 0 -> 1 after the warm-start step.
 */

import { describe, it, expect } from "vitest";
import { buildFixture, type Fixture } from "../../../solver/analog/__tests__/fixtures/build-fixture.js";
import { SwitchAnalogElement, SWITCH_SCHEMA } from "../switch.js";

import type { Circuit } from "../../../core/circuit.js";
import type { DefaultSimulatorFacade } from "../../../headless/default-facade.js";

const SLOT_CLOSED = SWITCH_SCHEMA.indexOf.get("CLOSED")!;

/**
 * Coil-energising bench:
 *
 *   vSrc(+) ─ relay:in1
 *   vSrc(-) ─ GND ─ relay:in2
 *   relay:A1 ─ rLoad ─ GND
 *   relay:B1 ─ vTest(+) ─ GND ─ vTest(-)
 *
 * Default coil resistance = 100Ω. Driving 10V across the coil at DC steady
 * state pushes I_coil = 10/100 = 0.1A through the coilL inductor — well
 * above the pull-in threshold (default pullInI = 0.05A). The contact-side
 * loop carries a small probe voltage so the contact pair is not floating.
 */
function buildRelayBench(facade: DefaultSimulatorFacade, vCoil: number): Circuit {
  return facade.build({
    components: [
      { id: "vSrc",  type: "DcVoltageSource", props: { label: "vSrc",  voltage: vCoil } },
      { id: "vTest", type: "DcVoltageSource", props: { label: "vTest", voltage: 1.0 } },
      { id: "rLoad", type: "Resistor",        props: { label: "rLoad", resistance: 100 } },
      { id: "relay", type: "Relay",           props: { label: "relay", model: "behavioral" } },
      { id: "gnd",   type: "Ground" },
    ],
    connections: [
      ["vSrc:pos",  "relay:in1"],
      ["vSrc:neg",  "gnd:out"],
      ["relay:in2", "gnd:out"],
      ["relay:A1",  "rLoad:pos"],
      ["rLoad:neg", "gnd:out"],
      ["relay:B1",  "vTest:pos"],
      ["vTest:neg", "gnd:out"],
    ],
  });
}

/**
 * Locate the Switch sub-element inside the expanded relay composite. After
 * SubcircuitWrapperElement.setLabel() runs, every sub-element carries label
 * `${parentLabel}:${subElementName}` — for the Relay netlist that's
 * `relay:contactSW`.
 */
function findContactSwitch(fix: Fixture): SwitchAnalogElement {
  const elements = fix.circuit.elements;
  for (const el of elements) {
    if (el instanceof SwitchAnalogElement && el.label === "relay:contactSW") {
      return el;
    }
  }
  throw new Error(
    "relay:contactSW SwitchAnalogElement not found in compiled circuit; " +
      "the Relay netlist composite did not expand correctly.",
  );
}

describe("Relay RelayCoupling siblingBranch/siblingState actuation", () => {
  it("coil_current_above_pull_in_closes_contact_slot", () => {
    // 10V across the 100Ω coil ⇒ I_coil = 0.1A at DC steady state, well
    // above the default pullInI = 0.05A. After the warm-start step the
    // RelayCoupling's threshold comparison must pull the contact CLOSED
    // and write 1 into the Switch's pool slot.
    const fix = buildFixture({
      build: (_r, facade) => buildRelayBench(facade, 10.0),
    });

    const sw = findContactSwitch(fix);

    // Pool slot CLOSED transitioned from its 0 initial value to 1, proving
    // (a) labelRef siblingBranch path resolves at setup() time
    //     (otherwise RelayCoupling.setup() throws on findBranch == 0);
    // (b) coil branch index is non-zero so RelayCoupling reads a non-zero
    //     current value;
    // (c) siblingState path correctly identifies the Switch's CLOSED slot.
    const closed = fix.pool.state1[sw._stateBase + SLOT_CLOSED];
    expect(closed).toBe(1);
  });
});

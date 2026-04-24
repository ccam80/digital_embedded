/**
 * Phase 3 Task 3.3.3 — Relay composite-child existence tests.
 *
 * Verifies that both relay factories expose a child AnalogInductorElement
 * via getChildElements(), following the composite-child pattern landed in
 * Phase 0 Wave 0.2.3 (DigitalPinModel -> AnalogCapacitorElement precedent
 * in src/solver/analog/digital-pin-model.ts).
 */

import { describe, it, expect } from "vitest";
import {
  createRelayAnalogElement,
  createRelayDTAnalogElement,
} from "../behavioral-remaining.js";
import { AnalogInductorElement } from "../../../components/passives/inductor.js";
import { PropertyBag } from "../../../core/properties.js";

describe("Phase 3 Task 3.3.3 -- Relay composite-child", () => {
  it("SPDT relay exposes coil inductor as composite child", () => {
    const props = new PropertyBag();
    const relay = createRelayAnalogElement(
      new Map([["in1", 1], ["in2", 2], ["A1", 3], ["B1", 4]]),
      [],
      10,
      props,
    );

    const children = (relay as any).getChildElements();
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(AnalogInductorElement);
    expect(children[0].isReactive).toBe(true);
  });

  it("DPDT relay exposes coil inductor as composite child", () => {
    const props = new PropertyBag();
    const relay = createRelayDTAnalogElement(
      new Map([["in1", 1], ["in2", 2], ["A1", 3], ["B1", 4], ["C1", 5]]),
      [],
      10,
      props,
    );

    const children = (relay as any).getChildElements();
    expect(children.length).toBe(1);
    expect(children[0]).toBeInstanceOf(AnalogInductorElement);
    expect(children[0].isReactive).toBe(true);
  });
});

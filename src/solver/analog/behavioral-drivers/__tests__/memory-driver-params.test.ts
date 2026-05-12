/**
 * Param hot-load tests for the 3 multi-bit memory driver leaf elements:
 * counter, counter-preset, register.
 *
 * Asserts that setParam("rOut", 200), setParam("vOH", 3.3), and
 * setParam("vOL", 0.5) do not throw. Phase 1 does not wire these params
 * into load(); that is Phase 4's job.
 */

import { describe, it, expect } from "vitest";
import { PropertyBag } from "../../../../core/properties.js";
import { BehavioralCounterDriverElement } from "../counter-driver.js";
import { BehavioralCounterPresetDriverElement } from "../counter-preset-driver.js";
import { BehavioralRegisterDriverElement } from "../register-driver.js";

function makeProps(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(params)) {
    bag.setModelParam(k, v);
  }
  return bag;
}

function pinNodesFromLabels(labels: readonly string[]): ReadonlyMap<string, number> {
  const m = new Map<string, number>();
  labels.forEach((label, i) => m.set(label, i));
  return m;
}

describe("memory-driver-params — accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("BehavioralCounterDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ vIH: 2.0, bitWidth: 4, rOut: 100, vOH: 5, vOL: 0 });
    const pinNodes = pinNodesFromLabels(["en", "C", "clr", "gnd"]);
    const el = new BehavioralCounterDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("BehavioralCounterPresetDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ vIH: 2.0, vIL: 0.8, bitWidth: 4, preset: 0, rOut: 100, vOH: 5, vOL: 0 });
    const pinNodes = pinNodesFromLabels(["en", "C", "clr", "ld", "gnd"]);
    const el = new BehavioralCounterPresetDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("BehavioralRegisterDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ vIH: 2.0, vIL: 0.8, bitWidth: 4, rOut: 100, vOH: 5, vOL: 0 });
    const pinNodes = pinNodesFromLabels(["C", "clr", "ld", "d_0", "d_1", "d_2", "d_3", "gnd"]);
    const el = new BehavioralRegisterDriverElement(pinNodes, props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});

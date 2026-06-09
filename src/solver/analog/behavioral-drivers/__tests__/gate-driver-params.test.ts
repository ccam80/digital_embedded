/**
 * Param hot-load tests for the BehavioralLogic (BIAnalogElement) gate driver.
 *
 * Asserts that setParam("rOut", 200), setParam("vOH", 3.3), and
 * setParam("vOL", 0.5) do not throw on a directly-constructed BIAnalogElement.
 * BIAnalogElement is the unified driver used by all 8 gate types after
 * conversion to the BehavioralLogic B-source pattern.
 */

import { describe, it, expect } from "vitest";
import { PropertyBag } from "../../../../core/properties.js";
import { BIAnalogElement } from "../../../../components/active/bsource.js";
import { buildBSourceTree } from "../../expression.js";

function makeElement(expression: string, pinEntries: [string, number][]): BIAnalogElement {
  const pinNodes = new Map<string, number>(pinEntries);
  const tree = buildBSourceTree(expression);
  const props = new PropertyBag();
  const el = new BIAnalogElement(pinNodes, tree);
  el.seedParams(props);
  return el;
}

describe("BIAnalogElement (BehavioralLogic) — accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("accepts rOut/vOH/vOL on a 2-input AND expression", () => {
    const el = makeElement("min(V(r1),V(r2))", [["r1", 1], ["r2", 2], ["out+", 0], ["out-", 3]]);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("accepts rOut/vOH/vOL on a 2-input OR expression", () => {
    const el = makeElement("max(V(r1),V(r2))", [["r1", 1], ["r2", 2], ["out+", 0], ["out-", 3]]);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("accepts rOut/vOH/vOL on a 2-input NAND expression", () => {
    const el = makeElement("1-min(V(r1),V(r2))", [["r1", 1], ["r2", 2], ["out+", 0], ["out-", 3]]);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("accepts rOut/vOH/vOL on a 2-input NOR expression", () => {
    const el = makeElement("1-max(V(r1),V(r2))", [["r1", 1], ["r2", 2], ["out+", 0], ["out-", 3]]);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("accepts rOut/vOH/vOL on a 2-input XOR expression", () => {
    const el = makeElement("(V(r1)+V(r2)-2*(V(r1))*V(r2))", [["r1", 1], ["r2", 2], ["out+", 0], ["out-", 3]]);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("accepts rOut/vOH/vOL on a 2-input XNOR expression", () => {
    const el = makeElement("1-(V(r1)+V(r2)-2*(V(r1))*V(r2))", [["r1", 1], ["r2", 2], ["out+", 0], ["out-", 3]]);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("accepts rOut/vOH/vOL on a NOT expression", () => {
    const el = makeElement("1-V(r1)", [["r1", 1], ["out+", 0], ["out-", 2]]);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("accepts rOut/vOH/vOL on a BUF expression", () => {
    const el = makeElement("V(r1)", [["r1", 1], ["out+", 0], ["out-", 2]]);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});

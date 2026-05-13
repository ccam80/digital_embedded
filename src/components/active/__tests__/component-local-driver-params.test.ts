/**
 * Param hot-load tests for the 4 component-local driver elements:
 * ComparatorDriverElement, ComparatorPushPullDriverElement,
 * Timer555LatchDriverElement, ADCDriverElement.
 *
 * Asserts that setParam("rOut", 200), setParam("vOH", 3.3), and
 * setParam("vOL", 0.5) do not throw. Phase 1 does not wire these params
 * into load(); that is Phase 4's job.
 */

import { describe, it, expect } from "vitest";
import { PropertyBag } from "../../../core/properties.js";
import { ComparatorDriverElement } from "../comparator-driver.js";
import { ComparatorPushPullDriverElement } from "../comparator-pushpull-driver.js";
import { Timer555LatchDriverElement } from "../timer-555-latch-driver.js";
import { ADCDriverElement } from "../adc-driver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProps(params: Record<string, number>): PropertyBag {
  const bag = new PropertyBag();
  for (const [k, v] of Object.entries(params)) {
    bag.setModelParam(k, v);
  }
  return bag;
}

function comparatorPinNodes(): ReadonlyMap<string, number> {
  return new Map<string, number>([
    ["in+", 1],
    ["in-", 2],
    ["out", 3],
  ]);
}

function timer555PinNodes(): ReadonlyMap<string, number> {
  return new Map<string, number>([
    ["comp1Out", 1],
    ["comp2Out", 2],
    ["rst",      3],
    ["vcc",      4],
    ["gnd",      0],
    ["disBase",  5],
    ["out",      6],
  ]);
}

function adcPinNodes(): ReadonlyMap<string, number> {
  return new Map<string, number>([
    ["VIN",  1],
    ["CLK",  2],
    ["VREF", 3],
    ["GND",  0],
  ]);
}

// ---------------------------------------------------------------------------
// accepts rOut/vOH/vOL via setParam without throwing
// ---------------------------------------------------------------------------

describe("component-local-driver-params — accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("ComparatorDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({
      hysteresis: 0, vos: 0.001, responseTime: 1e-6,
      rOut: 100, vOH: 5, vOL: 0,
    });
    const el = new ComparatorDriverElement(comparatorPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("ComparatorPushPullDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({
      hysteresis: 0, vos: 0.001, responseTime: 1e-6,
      vOH: 3.3, vOL: 0, rOut: 100,
    });
    const el = new ComparatorPushPullDriverElement(comparatorPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("Timer555LatchDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ vDrop: 1.5, rOut: 100, vOH: 5, vOL: 0 });
    const el = new Timer555LatchDriverElement(timer555PinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("ADCDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({
      bits: 8, vIH: 2.0, vIL: 0.8, bipolar: 0, sar: 1,
      rOut: 100, vOH: 5, vOL: 0,
    });
    const el = new ADCDriverElement(adcPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});

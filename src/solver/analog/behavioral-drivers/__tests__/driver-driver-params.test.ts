/**
 * Param hot-load tests for the 3 driver-driver leaf elements:
 * BehavioralButtonLEDDriverElement, BehavioralDriverDriverElement,
 * BehavioralDriverInvDriverElement.
 *
 * Asserts that setParam("rOut", 200), setParam("vOH", 3.3), and
 * setParam("vOL", 0.5) do not throw.
 */

import { describe, it, expect } from "vitest";
import { PropertyBag } from "../../../../core/properties.js";
import { BehavioralButtonLEDDriverElement } from "../button-led-driver.js";
import { BehavioralDriverDriverElement } from "../driver-driver.js";
import { BehavioralDriverInvDriverElement } from "../driver-inv-driver.js";

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

function buttonLedPinNodes(): ReadonlyMap<string, number> {
  return new Map<string, number>([
    ["ctrl_out", 1],
    ["in",       2],
    ["gnd",      0],
  ]);
}

function driverDriverPinNodes(): ReadonlyMap<string, number> {
  return new Map<string, number>([
    ["in",       1],
    ["sel",      2],
    ["ctrl_out", 3],
    ["ctrl_en",  4],
    ["gnd",      0],
  ]);
}

// ---------------------------------------------------------------------------
// accepts rOut/vOH/vOL via setParam without throwing
// ---------------------------------------------------------------------------

describe("driver-driver-params — accepts rOut/vOH/vOL via setParam without throwing", () => {
  it("BehavioralButtonLEDDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ rOut: 100, vOH: 5, vOL: 0 });
    const el = new BehavioralButtonLEDDriverElement(buttonLedPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("BehavioralDriverDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ rOut: 100, vOH: 5, vOL: 0 });
    const el = new BehavioralDriverDriverElement(driverDriverPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });

  it("BehavioralDriverInvDriverElement accepts rOut/vOH/vOL", () => {
    const props = makeProps({ rOut: 100, vOH: 5, vOL: 0 });
    const el = new BehavioralDriverInvDriverElement(driverDriverPinNodes(), props);
    expect(() => el.setParam("rOut", 200)).not.toThrow();
    expect(() => el.setParam("vOH", 3.3)).not.toThrow();
    expect(() => el.setParam("vOL", 0.5)).not.toThrow();
  });
});

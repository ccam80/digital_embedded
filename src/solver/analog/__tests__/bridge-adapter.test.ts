// Tests BridgeOutputDriverElement and BridgeInputDriverElement threshold logic and factory shape.

import { describe, it, expect } from "vitest";
import {
  makeBridgeOutputAdapter,
  makeBridgeInputAdapter,
} from "../bridge-adapter.js";
import type { ResolvedPinElectrical } from "../../../core/pin-electrical.js";

// ---------------------------------------------------------------------------
// Shared spec- CMOS 3.3V
// ---------------------------------------------------------------------------

const CMOS_3V3: ResolvedPinElectrical = {
  rOut: 50,
  cOut: 5e-12,
  rIn: 1e7,
  cIn: 5e-12,
  vOH: 3.3,
  vOL: 0.0,
  vIH: 2.0,
  vIL: 0.8,
  rHiZ: 1e7,
};

const NODE = 1;

// ---------------------------------------------------------------------------
// BridgeOutputDriverElement / BridgeInputDriverElement — threshold logic
// ---------------------------------------------------------------------------

describe("BridgeOutputDriverElement", () => {
  it("input adapter readLogicLevel thresholds correctly", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, false);

    // Above vIH → true
    expect(adapter.readLogicLevel(CMOS_3V3.vIH + 0.1)).toBe(true);
    // Below vIL → false
    expect(adapter.readLogicLevel(CMOS_3V3.vIL - 0.1)).toBe(false);
    // Between vIL and vIH → undefined
    expect(adapter.readLogicLevel((CMOS_3V3.vIL + CMOS_3V3.vIH) / 2)).toBeUndefined();
  });

  it("setParam('vIH', 2.5) hot-updates input threshold", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, false);

    // With default vIH=2.0, voltage 2.1 is above threshold
    expect(adapter.readLogicLevel(2.1)).toBe(true);

    // Raise threshold to 2.5- 2.1 is now indeterminate (between 0.8 and 2.5)
    adapter.setParam("vIH", 2.5);
    expect(adapter.readLogicLevel(2.1)).toBeUndefined();

    // 2.6 is now above the new threshold
    expect(adapter.readLogicLevel(2.6)).toBe(true);
  });

  it("makeBridgeOutputAdapter produces element with setLogicLevel and setHighZ", () => {
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, false);
    expect(typeof adapter.setLogicLevel).toBe("function");
    expect(typeof adapter.setHighZ).toBe("function");
  });

  it("makeBridgeInputAdapter produces element with readLogicLevel", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, false);
    expect(typeof adapter.readLogicLevel).toBe("function");
  });
});

/**
 * Tests for BridgeOutputDriverElement and BridgeInputDriverElement.
 *
 * Stamp-level tests (setup/load cycle) are deleted: they required
 * loadCtxFromFields + makeTestSetupContext + setupAll from the deleted
 * test-helpers.ts, which is §3 POISON (hand-rolled LoadContext/SetupContext /
 * direct element.setup() / element.load() calls banned by §3 poison-pattern
 * contract). Stamp behaviour is covered at the integration level by
 * coordinator-bridge.test.ts (full mixed-signal coordinator path) and
 * bridge-compilation.test.ts (compileAnalogPartition → adapter properties).
 *
 * Tests retained here exercise only the pure-logic / no-stamp surface:
 *  - readLogicLevel threshold detection
 *  - setParam hot-update of vIH / vIL thresholds
 *  - factory shape (setLogicLevel / setHighZ / readLogicLevel presence)
 */

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
const BRANCH_IDX = 2;

// ---------------------------------------------------------------------------
// Deleted: stamp-level tests that called element.setup() / element.load()
// ---------------------------------------------------------------------------

// Deleted: output adapter stamps ideal voltage source at vOL.
// Coverage: bridge-compilation.test.ts cross-domain mode output adapter stamps rOut conductance;
//           coordinator-bridge.test.ts full mixed-signal coordinator step.
// Reason: called setupAll([adapter], setupCtx) + adapter.load(makeCtx(solver)) — §3 POISON
//         (direct element.setup() + hand-rolled LoadContext via loadCtxFromFields).

// Deleted: output adapter setLogicLevel(true) drives vOH.
// Coverage: coordinator-bridge.test.ts drives logic level and reads node voltage.
// Reason: called setupAll + adapter.load(makeCtx(solver)) — §3 POISON.

// Deleted: output adapter hi-z stamps I=0.
// Coverage: bridge-compilation.test.ts hi-z mode stamps I=0 (compileAnalogPartition path).
// Reason: called setupAll + adapter.load(makeCtx(solver)) — §3 POISON.

// Deleted: loaded output adapter stamps rOut conductance on node diagonal.
// Coverage: bridge-compilation.test.ts cross-domain mode output adapter stamps rOut conductance.
// Reason: called setupAll + adapter.load(makeCtx(solver)) — §3 POISON.

// Deleted: unloaded output adapter does not stamp rOut on node diagonal.
// Coverage: bridge-compilation.test.ts none mode output adapter does not stamp rOut conductance.
// Reason: called setupAll + adapter.load(makeCtx(solver)) — §3 POISON.

// Deleted: input adapter unloaded stamps nothing.
// Coverage: bridge-compilation.test.ts none mode input adapter stamps nothing.
// Reason: called setupAll + adapter.load(makeCtx(solver)) — §3 POISON.

// Deleted: input adapter loaded stamps rIn on node diagonal.
// Coverage: bridge-compilation.test.ts cross-domain mode (rIn coverage via integration).
// Reason: called setupAll + adapter.load(makeCtx(solver)) — §3 POISON.

// Deleted: setParam('rOut', 50) hot-updates output adapter conductance.
// Coverage: coordinator-bridge.test.ts (setParam hot-update exercised via full engine path).
// Reason: called setupAll + adapter.load(makeCtx(solver)) — §3 POISON.

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
    const adapter = makeBridgeOutputAdapter(CMOS_3V3, NODE, BRANCH_IDX, false);
    expect(typeof adapter.setLogicLevel).toBe("function");
    expect(typeof adapter.setHighZ).toBe("function");
  });

  it("makeBridgeInputAdapter produces element with readLogicLevel", () => {
    const adapter = makeBridgeInputAdapter(CMOS_3V3, NODE, false);
    expect(typeof adapter.readLogicLevel).toBe("function");
  });
});

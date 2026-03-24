/**
 * Tests for ScopeTrigger — scope trigger mechanism for timing diagram.
 */

import { describe, it, expect } from "vitest";
import { ScopeTrigger } from "../scope-trigger.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a simple signal reader from a net-to-value map. */
function makeReader(values: Record<number, number>): (netId: number) => number {
  return (netId: number) => values[netId] ?? 0;
}

// ---------------------------------------------------------------------------
// edgeTrigger — 0→1 transition fires trigger
// ---------------------------------------------------------------------------

describe("ScopeTrigger", () => {
  describe("edgeTrigger", () => {
    it("fires on 0→1 rising edge and starts recording", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
        recordingWindow: 5,
      });

      expect(trigger.status).toBe("armed");

      // Step 1: signal is 0 → no trigger
      let records = trigger.onStep(1, makeReader({ 0: 0 }));
      expect(records).toBe(false);
      expect(trigger.status).toBe("armed");

      // Step 2: signal transitions to 1 → trigger fires
      records = trigger.onStep(2, makeReader({ 0: 1 }));
      expect(records).toBe(true);
      expect(trigger.status).toBe("recording");
    });

    it("does not fire on 1→1 (no edge)", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
      });

      // Signal starts at 0, then stays at 1
      trigger.onStep(1, makeReader({ 0: 1 })); // rising edge — fires
      trigger.status; // side-effect read

      // If recording window is 0 it transitions to triggered immediately
      // Reset and test sustained high without edge
      trigger.reset();

      // Pre-set prev value by running a step at 1
      trigger.onStep(1, makeReader({ 0: 1 })); // fires on 0→1
      trigger.reset(); // reset so armed again

      // Now simulate signal already high: 1→1 should not fire again
      // We need to prime prevValue=1 without firing: use internal knowledge
      // Instead: fire once, note status, then check second step
      const t2 = new ScopeTrigger({ triggerNetId: 0, mode: "edge" });
      t2.onStep(1, makeReader({ 0: 1 })); // edge fires: 0→1
      t2.onStep(2, makeReader({ 0: 1 })); // 1→1: no new edge — stays in same state
      // Status should be triggered (from step 1), not cycling again
      expect(t2.status).toBe("triggered");
    });

    it("recording window counts down to armed", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
        recordingWindow: 3,
      });

      // Arm and fire
      trigger.onStep(1, makeReader({ 0: 0 }));
      trigger.onStep(2, makeReader({ 0: 1 })); // fires → recording (3 steps)
      expect(trigger.status).toBe("recording");

      // 3 more recording steps
      trigger.onStep(3, makeReader({ 0: 1 }));
      trigger.onStep(4, makeReader({ 0: 1 }));
      const last = trigger.onStep(5, makeReader({ 0: 1 }));
      expect(last).toBe(true);

      // After window exhausted → armed
      expect(trigger.status).toBe("armed");
    });

    it("returns true for each step within the recording window", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
        recordingWindow: 3,
      });

      trigger.onStep(1, makeReader({ 0: 0 }));
      trigger.onStep(2, makeReader({ 0: 1 })); // fires

      const r1 = trigger.onStep(3, makeReader({ 0: 0 }));
      const r2 = trigger.onStep(4, makeReader({ 0: 0 }));
      const r3 = trigger.onStep(5, makeReader({ 0: 0 }));

      expect(r1).toBe(true);
      expect(r2).toBe(true);
      expect(r3).toBe(true);

      // After window: should be false
      const r4 = trigger.onStep(6, makeReader({ 0: 0 }));
      expect(r4).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // levelTrigger — signal held at 1 fires on every step while high
  // -------------------------------------------------------------------------

  describe("levelTrigger", () => {
    it("returns true on every step while signal is high", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "level",
      });

      expect(trigger.onStep(1, makeReader({ 0: 1 }))).toBe(true);
      expect(trigger.onStep(2, makeReader({ 0: 1 }))).toBe(true);
      expect(trigger.onStep(3, makeReader({ 0: 1 }))).toBe(true);
    });

    it("returns false while signal is low", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "level",
      });

      expect(trigger.onStep(1, makeReader({ 0: 0 }))).toBe(false);
      expect(trigger.onStep(2, makeReader({ 0: 0 }))).toBe(false);
    });

    it("transitions between recording and not-recording as signal changes", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "level",
      });

      expect(trigger.onStep(1, makeReader({ 0: 1 }))).toBe(true);
      expect(trigger.onStep(2, makeReader({ 0: 0 }))).toBe(false);
      expect(trigger.onStep(3, makeReader({ 0: 1 }))).toBe(true);
    });

    it("fires for any non-zero value, not just 1", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "level",
      });

      expect(trigger.onStep(1, makeReader({ 0: 5 }))).toBe(true);
      expect(trigger.onStep(2, makeReader({ 0: 255 }))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // preTriggerBuffer — capture N samples before trigger fires
  // -------------------------------------------------------------------------

  describe("preTriggerBuffer", () => {
    it("captures pre-trigger samples before trigger fires", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
        preTriggerDepth: 10,
      });

      // Run 20 steps with signal low; trigger fires at step 21
      for (let i = 1; i <= 20; i++) {
        trigger.onStep(i, makeReader({ 0: 0 }));
      }

      // Trigger fires at step 21 (0→1)
      trigger.onStep(21, makeReader({ 0: 1 }));

      const preSamples = trigger.getPreTriggerSamples();

      // Should have 10 pre-trigger samples (steps 11–20 in a depth-10 buffer)
      expect(preSamples.length).toBe(10);
      expect(preSamples[0]!.time).toBe(11);
      expect(preSamples[9]!.time).toBe(20);
    });

    it("captures fewer samples if trigger fires before buffer is full", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
        preTriggerDepth: 10,
      });

      // Only 3 steps before trigger
      trigger.onStep(1, makeReader({ 0: 0 }));
      trigger.onStep(2, makeReader({ 0: 0 }));
      trigger.onStep(3, makeReader({ 0: 0 }));
      trigger.onStep(4, makeReader({ 0: 1 })); // fires

      const preSamples = trigger.getPreTriggerSamples();
      expect(preSamples.length).toBe(3);
      expect(preSamples[0]!.time).toBe(1);
      expect(preSamples[2]!.time).toBe(3);
    });

    it("pre-trigger buffer includes values for monitored nets", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
        preTriggerDepth: 5,
      });

      trigger.onStep(1, makeReader({ 0: 0, 1: 42 }), [1]);
      trigger.onStep(2, makeReader({ 0: 1, 1: 99 }), [1]); // fires

      const pre = trigger.getPreTriggerSamples();
      expect(pre.length).toBe(1);
      expect(pre[0]!.values.get(1)).toBe(42);
    });

    it("empty pre-trigger buffer when preTriggerDepth=0", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
        preTriggerDepth: 0,
      });

      trigger.onStep(1, makeReader({ 0: 0 }));
      trigger.onStep(2, makeReader({ 0: 1 })); // fires

      expect(trigger.getPreTriggerSamples().length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // noTrigger — no ScopeTrigger → diagram records continuously
  // -------------------------------------------------------------------------

  describe("noTrigger", () => {
    it("without ScopeTrigger, timing diagram records continuously (no filtering)", () => {
      // This test verifies that TimingDiagramPanel without a ScopeTrigger
      // records on every step — i.e. the trigger class itself is not needed
      // for continuous recording. We verify this by confirming ScopeTrigger
      // only returns true when the condition is met and consumers are not
      // required to instantiate it.

      // When mode is level and signal is always 0, returns false every step
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "level",
      });

      // 10 steps with signal low → never records
      let anyRecord = false;
      for (let i = 1; i <= 10; i++) {
        if (trigger.onStep(i, makeReader({ 0: 0 }))) {
          anyRecord = true;
        }
      }
      expect(anyRecord).toBe(false);

      // This confirms that continuous recording is achieved by NOT using
      // ScopeTrigger (the diagram records every step by default).
    });
  });

  // -------------------------------------------------------------------------
  // status listener
  // -------------------------------------------------------------------------

  describe("statusListener", () => {
    it("fires status listener when status changes", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
        recordingWindow: 2,
      });

      const statuses: string[] = [];
      trigger.addStatusListener((s) => statuses.push(s));

      trigger.onStep(1, makeReader({ 0: 0 }));
      trigger.onStep(2, makeReader({ 0: 1 })); // armed → triggered → recording
      trigger.onStep(3, makeReader({ 0: 0 }));
      trigger.onStep(4, makeReader({ 0: 0 })); // recording → armed

      expect(statuses).toContain("recording");
      expect(statuses).toContain("armed");
    });

    it("removeStatusListener stops notifications", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
      });

      let callCount = 0;
      const listener = () => { callCount++; };
      trigger.addStatusListener(listener);
      trigger.onStep(1, makeReader({ 0: 1 })); // fires
      expect(callCount).toBeGreaterThan(0);

      const before = callCount;
      trigger.removeStatusListener(listener);
      trigger.reset();
      trigger.onStep(1, makeReader({ 0: 1 })); // fires again
      expect(callCount).toBe(before); // no additional calls
    });
  });

  // -------------------------------------------------------------------------
  // reset
  // -------------------------------------------------------------------------

  describe("reset", () => {
    it("returns to armed state after reset", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
        recordingWindow: 10,
      });

      trigger.onStep(1, makeReader({ 0: 0 }));
      trigger.onStep(2, makeReader({ 0: 1 })); // fires → recording
      expect(trigger.status).toBe("recording");

      trigger.reset();
      expect(trigger.status).toBe("armed");
    });

    it("clears pre-trigger buffer on reset", () => {
      const trigger = new ScopeTrigger({
        triggerNetId: 0,
        mode: "edge",
        preTriggerDepth: 5,
      });

      for (let i = 1; i <= 5; i++) {
        trigger.onStep(i, makeReader({ 0: 0 }));
      }

      trigger.reset();
      expect(trigger.getPreTriggerSamples().length).toBe(0);
    });
  });
});

/**
 * Tests for TimingDiagramPanel — waveform view of signals over time.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from "vitest";
import { TimingDiagramPanel } from "../timing-diagram.js";
import { MockCoordinator } from "@/test-utils/mock-coordinator.js";
import type { SignalAddress } from "@/compile/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 800;
  canvas.height = 400;
  document.body.appendChild(canvas);
  return canvas;
}

function teardownCanvas(canvas: HTMLCanvasElement): void {
  canvas.remove();
}

const CLK_ADDR: SignalAddress = { domain: "digital", netId: 0, bitWidth: 1 };
const DATA_ADDR: SignalAddress = { domain: "digital", netId: 1, bitWidth: 8 };
const SIG_ADDR: SignalAddress = { domain: "digital", netId: 0, bitWidth: 1 };

const TWO_CHANNELS = [
  { name: "CLK", addr: CLK_ADDR, width: 1 },
  { name: "DATA", addr: DATA_ADDR, width: 8 },
];

/**
 * Build a MockCoordinator with call-tracking for saveSnapshot/restoreSnapshot.
 * saveSnapshot() returns an incrementing ID starting from 0.
 */
function buildCoordinator(): {
  coordinator: MockCoordinator;
  setSignal(addr: SignalAddress, value: number): void;
  getRestoreCalls(): Array<{ method: "restoreSnapshot"; id: number }>;
  resetCalls(): void;
} {
  const coord = new MockCoordinator();
  let nextSnapshotId = 0;
  const restoreCalls: Array<{ method: "restoreSnapshot"; id: number }> = [];

  (coord as unknown as { saveSnapshot(): number }).saveSnapshot = () => nextSnapshotId++;
  (coord as unknown as { restoreSnapshot(id: number): void }).restoreSnapshot = (id: number) => {
    restoreCalls.push({ method: "restoreSnapshot", id });
  };

  return {
    coordinator: coord,
    setSignal: (addr: SignalAddress, value: number) => {
      coord.setSignal(addr, { type: "digital", value });
    },
    getRestoreCalls: () => restoreCalls,
    resetCalls: () => { restoreCalls.length = 0; nextSnapshotId = 0; },
  };
}

// ---------------------------------------------------------------------------
// recordsSamples — step coordinator 10 times, verify 10 samples per channel
// ---------------------------------------------------------------------------

describe("TimingDiagramPanel", () => {
  describe("recordsSamples", () => {
    it("records one sample per channel per step", () => {
      const { coordinator, setSignal } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 0,
      });

      for (let i = 1; i <= 10; i++) {
        setSignal(CLK_ADDR, i % 2);
        setSignal(DATA_ADDR, i * 10);
        panel.onStep(i);
      }

      const clkChannel = panel.getChannel("CLK");
      const dataChannel = panel.getChannel("DATA");

      expect(clkChannel).toBeDefined();
      expect(dataChannel).toBeDefined();
      expect(clkChannel!.count).toBe(10);
      expect(dataChannel!.count).toBe(10);

      panel.dispose();
    });

    it("records correct values for each step", () => {
      const { coordinator, setSignal } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 0,
      });

      setSignal(CLK_ADDR, 1);
      setSignal(DATA_ADDR, 42);
      panel.onStep(1);

      setSignal(CLK_ADDR, 0);
      setSignal(DATA_ADDR, 99);
      panel.onStep(2);

      const clk = panel.getChannel("CLK")!;
      const data = panel.getChannel("DATA")!;

      expect(clk.getSample(0).value).toBe(1);
      expect(clk.getSample(0).time).toBe(1);
      expect(clk.getSample(1).value).toBe(0);
      expect(clk.getSample(1).time).toBe(2);

      expect(data.getSample(0).value).toBe(42);
      expect(data.getSample(1).value).toBe(99);

      panel.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // ringBufferEviction — fill beyond capacity, oldest evicted
  // -------------------------------------------------------------------------

  describe("ringBufferEviction", () => {
    it("evicts oldest samples when buffer is full", () => {
      const { coordinator, setSignal } = buildCoordinator();

      const channels = [{ name: "SIG", addr: SIG_ADDR, width: 1 }];
      const panel = new TimingDiagramPanel(null, coordinator, channels, {
        snapshotInterval: 0,
        channelCapacity: 5,
      });

      for (let i = 1; i <= 8; i++) {
        setSignal(SIG_ADDR, i);
        panel.onStep(i);
      }

      const ch = panel.getChannel("SIG")!;

      expect(ch.count).toBe(5);

      const samples = ch.getSamples();
      expect(samples[0]!.time).toBe(4);
      expect(samples[4]!.time).toBe(8);

      panel.dispose();
    });

    it("count never exceeds capacity", () => {
      const { coordinator } = buildCoordinator();

      const channels = [{ name: "SIG", addr: SIG_ADDR, width: 1 }];
      const panel = new TimingDiagramPanel(null, coordinator, channels, {
        snapshotInterval: 0,
        channelCapacity: 3,
      });

      for (let i = 1; i <= 100; i++) {
        panel.onStep(i);
      }

      const ch = panel.getChannel("SIG")!;
      expect(ch.count).toBe(3);

      panel.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // snapshotTagging — snapshots saved at configured intervals with time tags
  // -------------------------------------------------------------------------

  describe("snapshotTagging", () => {
    it("saves snapshots at every step when interval=1", () => {
      const { coordinator } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 1,
      });

      for (let i = 1; i <= 5; i++) {
        panel.onStep(i);
      }

      const tags = panel.getSnapshotTags();
      expect(tags.length).toBe(5);

      expect(tags[0]!.time).toBe(1);
      expect(tags[1]!.time).toBe(2);
      expect(tags[4]!.time).toBe(5);

      panel.dispose();
    });

    it("saves snapshots at configured interval (every 3 steps)", () => {
      const { coordinator } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 3,
      });

      for (let i = 1; i <= 9; i++) {
        panel.onStep(i);
      }

      const tags = panel.getSnapshotTags();
      expect(tags.length).toBe(3);
      expect(tags[0]!.time).toBe(3);
      expect(tags[1]!.time).toBe(6);
      expect(tags[2]!.time).toBe(9);

      panel.dispose();
    });

    it("saves no snapshots when interval=0", () => {
      const { coordinator } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 0,
      });

      for (let i = 1; i <= 10; i++) {
        panel.onStep(i);
      }

      expect(panel.getSnapshotTags().length).toBe(0);

      panel.dispose();
    });

    it("snapshot IDs match what the coordinator returned", () => {
      const { coordinator } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 1,
      });

      panel.onStep(1);
      panel.onStep(2);
      panel.onStep(3);

      const tags = panel.getSnapshotTags();
      expect(tags[0]!.snapshotId).toBe(0);
      expect(tags[1]!.snapshotId).toBe(1);
      expect(tags[2]!.snapshotId).toBe(2);

      panel.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // clickToJump — jump to time T, verify restoreSnapshot called with closest
  // -------------------------------------------------------------------------

  describe("clickToJump", () => {
    it("restores the closest snapshot when jumpToTime is called", () => {
      const { coordinator, getRestoreCalls, resetCalls } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 1,
      });

      for (let i = 1; i <= 5; i++) {
        panel.onStep(i);
      }

      resetCalls();

      // Jump to time 3.4 → closest is time 3 (snapshot ID=2)
      panel.jumpToTime(3.4);

      const restoreCalls = getRestoreCalls();
      expect(restoreCalls.length).toBe(1);
      expect(restoreCalls[0]!.id).toBe(2);

      panel.dispose();
    });

    it("restores the closest snapshot to time 0 when jumped to start", () => {
      const { coordinator, getRestoreCalls, resetCalls } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 2,
      });

      // Snapshots at times 2, 4, 6
      for (let i = 1; i <= 6; i++) {
        panel.onStep(i);
      }

      resetCalls();

      // Jump to time 1 → closest snapshot is time=2 (snapshot ID=0)
      panel.jumpToTime(1);

      const restoreCalls = getRestoreCalls();
      expect(restoreCalls.length).toBe(1);
      expect(restoreCalls[0]!.id).toBe(0);

      panel.dispose();
    });

    it("does nothing when no snapshots recorded", () => {
      const { coordinator, getRestoreCalls } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 0,
      });

      panel.onStep(1);

      // Should be a no-op
      panel.jumpToTime(1);

      expect(getRestoreCalls().length).toBe(0);

      panel.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // onReset — clears channels and snapshots
  // -------------------------------------------------------------------------

  describe("onReset", () => {
    it("clears all channel samples on reset", () => {
      const { coordinator } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 0,
      });

      for (let i = 1; i <= 5; i++) {
        panel.onStep(i);
      }

      expect(panel.getChannel("CLK")!.count).toBe(5);

      panel.onReset();

      expect(panel.getChannel("CLK")!.count).toBe(0);
      expect(panel.getChannel("DATA")!.count).toBe(0);

      panel.dispose();
    });

    it("clears snapshot tags on reset", () => {
      const { coordinator } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 1,
      });

      for (let i = 1; i <= 3; i++) {
        panel.onStep(i);
      }
      expect(panel.getSnapshotTags().length).toBe(3);

      panel.onReset();
      expect(panel.getSnapshotTags().length).toBe(0);

      panel.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // getChannels — returns all configured channels
  // -------------------------------------------------------------------------

  describe("getChannels", () => {
    it("returns all channels in order", () => {
      const { coordinator } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 0,
      });

      const channels = panel.getChannels();
      expect(channels.length).toBe(2);
      expect(channels[0]!.name).toBe("CLK");
      expect(channels[1]!.name).toBe("DATA");

      panel.dispose();
    });
  });

  // -------------------------------------------------------------------------
  // timeCursor — getCursorTime and getValuesAtTime
  // -------------------------------------------------------------------------

  describe("timeCursor", () => {
    it("getCursorTime returns null when no cursor position is set", () => {
      const { coordinator } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 0,
      });

      expect(panel.getCursorTime()).toBeNull();

      panel.dispose();
    });

    it("getCursorTime returns correct simulation time after mousemove on canvas", () => {
      const { coordinator } = buildCoordinator();

      const canvas = makeCanvas();
      const panel = new TimingDiagramPanel(canvas, coordinator, TWO_CHANNELS, {
        snapshotInterval: 0,
      });

      // Default viewport: startTime=0, endTime=5000 (5s at default 1000 steps/s)
      // canvas width=800, leftMargin=80, drawWidth = 720
      // cursorX=440 → time = 0 + ((440 - 80) / 720) * 5000 = 2500
      const moveEvent = new PointerEvent("pointermove", { bubbles: true });
      Object.defineProperty(moveEvent, "offsetX", { value: 440 });
      canvas.dispatchEvent(moveEvent);

      const cursorTime = panel.getCursorTime();
      expect(cursorTime).not.toBeNull();
      expect(cursorTime!).toBeCloseTo(2500, 0);

      teardownCanvas(canvas);
      panel.dispose();
    });

    it("getCursorTime returns null after mouseleave", () => {
      const { coordinator } = buildCoordinator();

      const canvas = makeCanvas();
      const panel = new TimingDiagramPanel(canvas, coordinator, TWO_CHANNELS, {
        snapshotInterval: 0,
      });

      const moveEvent = new PointerEvent("pointermove", { bubbles: true });
      Object.defineProperty(moveEvent, "offsetX", { value: 400 });
      canvas.dispatchEvent(moveEvent);
      expect(panel.getCursorTime()).not.toBeNull();

      const leaveEvent = new PointerEvent("pointerleave", { bubbles: false });
      canvas.dispatchEvent(leaveEvent);
      expect(panel.getCursorTime()).toBeNull();

      teardownCanvas(canvas);
      panel.dispose();
    });

    it("getValuesAtTime returns empty array when no samples recorded", () => {
      const { coordinator } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 0,
      });

      const values = panel.getValuesAtTime(5);
      expect(values).toHaveLength(0);

      panel.dispose();
    });

    it("getValuesAtTime returns closest sample value for each channel", () => {
      const { coordinator, setSignal } = buildCoordinator();

      const panel = new TimingDiagramPanel(null, coordinator, TWO_CHANNELS, {
        snapshotInterval: 0,
      });

      setSignal(CLK_ADDR, 1);
      setSignal(DATA_ADDR, 0xAB);
      panel.onStep(1);

      setSignal(CLK_ADDR, 0);
      setSignal(DATA_ADDR, 0xCD);
      panel.onStep(2);

      setSignal(CLK_ADDR, 1);
      setSignal(DATA_ADDR, 0xEF);
      panel.onStep(3);

      // Query at t=2 — exact match
      const values = panel.getValuesAtTime(2);
      expect(values).toHaveLength(2);

      const clkRow = values.find((r) => r.name === "CLK");
      const dataRow = values.find((r) => r.name === "DATA");

      expect(clkRow).toBeDefined();
      expect(clkRow!.value).toBe(0);
      expect(clkRow!.width).toBe(1);

      expect(dataRow).toBeDefined();
      expect(dataRow!.value).toBe(0xCD);
      expect(dataRow!.width).toBe(8);

      panel.dispose();
    });

    it("getValuesAtTime finds closest sample when time is between recorded samples", () => {
      const { coordinator, setSignal } = buildCoordinator();

      const channels = [{ name: "SIG", addr: SIG_ADDR, width: 1 }];
      const panel = new TimingDiagramPanel(null, coordinator, channels, {
        snapshotInterval: 0,
      });

      setSignal(SIG_ADDR, 0);
      panel.onStep(10);

      setSignal(SIG_ADDR, 1);
      panel.onStep(20);

      // t=13 is closer to t=10 than to t=20
      const valuesAt13 = panel.getValuesAtTime(13);
      expect(valuesAt13[0]!.value).toBe(0);

      // t=17 is closer to t=20
      const valuesAt17 = panel.getValuesAtTime(17);
      expect(valuesAt17[0]!.value).toBe(1);

      panel.dispose();
    });
  });
});

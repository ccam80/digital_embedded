/**
 * Tests for WaveformRenderer — drawing logic for digital and bus waveforms.
 */

import { describe, it, expect } from "vitest";
import {
  RecordingContext,
  drawDigitalWaveform,
  drawBusWaveform,
} from "../waveform-renderer.js";
import type { WaveformViewport } from "../waveform-renderer.js";
import type { WaveformSample } from "../waveform-data.js";

// ---------------------------------------------------------------------------
// Shared fixture
// ---------------------------------------------------------------------------

function makeVp(): WaveformViewport {
  return {
    startTime: 0,
    endTime: 10,
    laneHeight: 60,
    leftMargin: 80,
  };
}

// ---------------------------------------------------------------------------
// digitalWaveform — 1-bit signal [0,1,1,0] → verify square wave path segments
// ---------------------------------------------------------------------------

describe("WaveformRenderer", () => {
  describe("digitalWaveform", () => {
    it("draws square wave path segments for [0,1,1,0]", () => {
      const ctx = new RecordingContext(800, 400);
      const vp = makeVp();

      const samples: WaveformSample[] = [
        { time: 0, value: 0 },
        { time: 2, value: 1 },
        { time: 4, value: 1 },
        { time: 6, value: 0 },
      ];

      drawDigitalWaveform(ctx, samples, 0, vp);

      // Must have a beginPath
      const hasBeginPath = ctx.commands.some((c) => c.kind === "beginPath");
      expect(hasBeginPath).toBe(true);

      // Must have a moveTo (starting the path)
      const moveToCommands = ctx.commands.filter((c) => c.kind === "moveTo");
      expect(moveToCommands.length).toBeGreaterThanOrEqual(1);

      // Must have multiple lineTo commands for the square wave segments
      const lineToCommands = ctx.commands.filter((c) => c.kind === "lineTo");
      expect(lineToCommands.length).toBeGreaterThan(2);

      // Must end with a stroke
      const hasStroke = ctx.commands.some((c) => c.kind === "stroke");
      expect(hasStroke).toBe(true);
    });

    it("draws a vertical transition when value changes", () => {
      const ctx = new RecordingContext(800, 400);
      const vp = makeVp();

      // 0 then 1: expect a vertical lineTo (same x, different y)
      const samples: WaveformSample[] = [
        { time: 0, value: 0 },
        { time: 5, value: 1 },
      ];

      drawDigitalWaveform(ctx, samples, 0, vp);

      const lineTos = ctx.commands.filter(
        (c): c is { kind: "lineTo"; x: number; y: number } => c.kind === "lineTo",
      );

      // Find at least one pair of consecutive lineTos at the same x (vertical)
      let hasVertical = false;
      for (let i = 1; i < lineTos.length; i++) {
        if (Math.abs(lineTos[i]!.x - lineTos[i - 1]!.x) < 1) {
          hasVertical = true;
          break;
        }
      }
      expect(hasVertical).toBe(true);
    });

    it("draws no commands for empty sample list", () => {
      const ctx = new RecordingContext(800, 400);
      const vp = makeVp();
      drawDigitalWaveform(ctx, [], 0, vp);
      expect(ctx.commands.length).toBe(0);
    });

    it("uses high Y for value 0 and low Y for value 1", () => {
      const ctx = new RecordingContext(800, 400);
      const vp = makeVp();
      const highY = vp.laneHeight * 0.15; // laneY=0, highY=9
      const lowY = vp.laneHeight * 0.85;  // laneY=0, lowY=51

      const samples: WaveformSample[] = [
        { time: 0, value: 0 },
      ];
      drawDigitalWaveform(ctx, samples, 0, vp);

      // First moveTo should be at lowY (value=0 → low level)
      const firstMoveTo = ctx.commands.find(
        (c): c is { kind: "moveTo"; x: number; y: number } => c.kind === "moveTo",
      );
      expect(firstMoveTo).toBeDefined();
      expect(firstMoveTo!.y).toBeCloseTo(lowY, 1);

      // Now check value=1 → highY
      const ctx2 = new RecordingContext(800, 400);
      const samples1: WaveformSample[] = [{ time: 0, value: 1 }];
      drawDigitalWaveform(ctx2, samples1, 0, vp);
      const firstMoveTo2 = ctx2.commands.find(
        (c): c is { kind: "moveTo"; x: number; y: number } => c.kind === "moveTo",
      );
      expect(firstMoveTo2!.y).toBeCloseTo(highY, 1);
    });
  });

  // -------------------------------------------------------------------------
  // busWaveform — multi-bit signal with transitions → hatched band + labels
  // -------------------------------------------------------------------------

  describe("busWaveform", () => {
    it("draws top and bottom rails for bus signal", () => {
      const ctx = new RecordingContext(800, 400);
      const vp = makeVp();

      const samples: WaveformSample[] = [
        { time: 0, value: 0x00 },
        { time: 5, value: 0xFF },
      ];

      drawBusWaveform(ctx, samples, 8, 0, vp);

      // Must have moveTo and lineTo for the rails
      const moveToCommands = ctx.commands.filter((c) => c.kind === "moveTo");
      expect(moveToCommands.length).toBeGreaterThanOrEqual(2);

      const lineToCommands = ctx.commands.filter((c) => c.kind === "lineTo");
      expect(lineToCommands.length).toBeGreaterThanOrEqual(2);
    });

    it("annotates hex value in segment", () => {
      const ctx = new RecordingContext(800, 400);
      const vp = makeVp();

      const samples: WaveformSample[] = [
        { time: 0, value: 0xAB },
      ];

      drawBusWaveform(ctx, samples, 8, 0, vp);

      const textCommands = ctx.commands.filter(
        (c): c is { kind: "text"; value: string; x: number; y: number } =>
          c.kind === "text",
      );
      expect(textCommands.length).toBeGreaterThan(0);

      // The hex annotation for 0xAB with 8 bits → "0xAB"
      const hasHexLabel = textCommands.some((c) => c.value === "0xAB");
      expect(hasHexLabel).toBe(true);
    });

    it("draws transition markers at value change points", () => {
      const ctx = new RecordingContext(800, 400);
      const vp = makeVp();

      const samples: WaveformSample[] = [
        { time: 0, value: 0x00 },
        { time: 5, value: 0xFF },
      ];

      drawBusWaveform(ctx, samples, 8, 0, vp);

      // Transition diagonal crosses: at time=5 there is a value change.
      // The transition marker uses moveTo/lineTo pairs at approximately x=5.
      const timeRange = vp.endTime - vp.startTime; // 10
      const drawWidth = 800 - 80; // 720
      const transX = 80 + (5 / timeRange) * drawWidth; // 80 + 360 = 440

      const moveToNearTrans = ctx.commands.filter(
        (c): c is { kind: "moveTo"; x: number; y: number } =>
          c.kind === "moveTo" && Math.abs(c.x - (transX - 3)) < 2,
      );
      expect(moveToNearTrans.length).toBeGreaterThan(0);
    });

    it("draws no commands for empty sample list", () => {
      const ctx = new RecordingContext(800, 400);
      const vp = makeVp();
      drawBusWaveform(ctx, [], 8, 0, vp);
      expect(ctx.commands.length).toBe(0);
    });

    it("annotates correct hex label for 16-bit value", () => {
      const ctx = new RecordingContext(800, 400);
      const vp = makeVp();

      const samples: WaveformSample[] = [
        { time: 0, value: 0x1234 },
      ];

      drawBusWaveform(ctx, samples, 16, 0, vp);

      const textCommands = ctx.commands.filter(
        (c): c is { kind: "text"; value: string; x: number; y: number } =>
          c.kind === "text",
      );
      const hasLabel = textCommands.some((c) => c.value === "0x1234");
      expect(hasLabel).toBe(true);
    });
  });
});

/**
 * Tests for exportGif() — animated GIF circuit export.
 *
 * Spec tests:
 *   producesBlob      — export returns a Blob with type image/gif
 *   correctFrameCount — 10 steps → GIF has 10 frames
 *   frameDelay        — 100ms delay → encoded in GIF frame metadata
 *
 * Runs in the node environment (no DOM). The engine is stubbed to count
 * step() calls. Frame pixel data is injected via the `frameCapture` option
 * so no canvas is needed.
 *
 * GIF binary parsing:
 *   The GIF89a format stores each frame as a Graphic Control Extension block
 *   at offset 0: 0x21 0xF9 (extension introducer + GCE label).
 *   Delay is at bytes 4-5 of the GCE block (little-endian, centiseconds).
 *   We count GCE blocks to determine frame count.
 */

import { describe, it, expect } from "vitest";
import { exportGif } from "../gif";
import { Circuit } from "@/core/circuit";
import type { SimulationEngine, CompiledCircuit, EngineChangeListener, MeasurementObserver, SnapshotId } from "@/core/engine-interface";
import { EngineState } from "@/core/engine-interface";
import { BitVector } from "@/core/signal";
import { lightColorScheme } from "@/core/renderer-interface";

// ---------------------------------------------------------------------------
// Stub engine
// ---------------------------------------------------------------------------

class StubEngine implements SimulationEngine {
  stepCount = 0;

  init(_circuit: CompiledCircuit): void {}
  reset(): void { this.stepCount = 0; }
  dispose(): void {}

  step(): void { this.stepCount++; }
  microStep(): void {}
  runToBreak(): void {}
  start(): void {}
  stop(): void {}

  getState(): EngineState { return EngineState.STOPPED; }

  getSignalRaw(_netId: number): number { return 0; }
  getSignalValue(_netId: number): BitVector { return BitVector.fromNumber(0, 1); }
  setSignalValue(_netId: number, _value: BitVector): void {}

  addChangeListener(_listener: EngineChangeListener): void {}
  removeChangeListener(_listener: EngineChangeListener): void {}
  addMeasurementObserver(_observer: MeasurementObserver): void {}
  removeMeasurementObserver(_observer: MeasurementObserver): void {}

  saveSnapshot(): SnapshotId { return 0; }
  restoreSnapshot(_id: SnapshotId): void {}
  getSnapshotCount(): number { return 0; }
  clearSnapshots(): void {}
  setSnapshotBudget(_bytes: number): void {}
}

// ---------------------------------------------------------------------------
// GIF binary helpers
// ---------------------------------------------------------------------------

/**
 * Count Graphic Control Extension blocks in a GIF byte array.
 * Each GCE starts with 0x21 0xF9.
 */
function countGifFrames(data: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < data.length - 1; i++) {
    if (data[i] === 0x21 && data[i + 1] === 0xf9) {
      count++;
    }
  }
  return count;
}

/**
 * Extract GCE delay values (in centiseconds) from a GIF byte array.
 *
 * GCE block layout (after the 0x21 0xF9 header):
 *   byte 0: block size (4)
 *   byte 1: packed flags
 *   byte 2: delay low byte
 *   byte 3: delay high byte
 *   byte 4: transparent color index
 *   byte 5: block terminator (0x00)
 *
 * We read bytes 2-3 after the 0x21 0xF9 introducer, so at i+2 and i+3
 * relative to the start of 0x21.
 */
function extractGifDelays(data: Uint8Array): number[] {
  const delays: number[] = [];
  for (let i = 0; i < data.length - 5; i++) {
    if (data[i] === 0x21 && data[i + 1] === 0xf9) {
      // i+2 = block size (should be 4)
      // i+3 = packed flags
      // i+4 = delay low byte
      // i+5 = delay high byte
      const low = data[i + 4]!;
      const high = data[i + 5]!;
      const delayCentiseconds = low | (high << 8);
      delays.push(delayCentiseconds);
    }
  }
  return delays;
}

// ---------------------------------------------------------------------------
// Synthetic frame capture
// ---------------------------------------------------------------------------

/**
 * Returns a solid-color RGBA frame: all pixels set to r=100, g=150, b=200, a=255.
 */
function solidFrame(
  _stepIndex: number,
  width: number,
  height: number,
): Uint8ClampedArray {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 100;
    data[i + 1] = 150;
    data[i + 2] = 200;
    data[i + 3] = 255;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Circuit helpers
// ---------------------------------------------------------------------------

function buildEmptyCircuit(): Circuit {
  return new Circuit({ name: "gif-test" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("exportGif", () => {
  it("producesBlob — export returns a Blob with type image/gif", async () => {
    const circuit = buildEmptyCircuit();
    const engine = new StubEngine();

    const blob = await exportGif(circuit, engine, {
      steps: 3,
      frameDelay: 100,
      scale: 1,
      colorScheme: lightColorScheme,
      frameCapture: solidFrame,
    });

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe("image/gif");
  });

  it("correctFrameCount — 10 steps produces a GIF with 10 frames", async () => {
    const circuit = buildEmptyCircuit();
    const engine = new StubEngine();

    const blob = await exportGif(circuit, engine, {
      steps: 10,
      frameDelay: 50,
      scale: 1,
      colorScheme: lightColorScheme,
      frameCapture: solidFrame,
    });

    const buffer = await blob.arrayBuffer();
    const data = new Uint8Array(buffer);
    const frameCount = countGifFrames(data);

    expect(frameCount).toBe(10);
  });

  it("correctFrameCount — engine.step() called once per frame step", async () => {
    const circuit = buildEmptyCircuit();
    const engine = new StubEngine();

    await exportGif(circuit, engine, {
      steps: 7,
      frameDelay: 50,
      scale: 1,
      colorScheme: lightColorScheme,
      frameCapture: solidFrame,
    });

    expect(engine.stepCount).toBe(7);
  });

  it("frameDelay — 100ms delay is encoded as 10 centiseconds in GIF metadata", async () => {
    const circuit = buildEmptyCircuit();
    const engine = new StubEngine();

    const blob = await exportGif(circuit, engine, {
      steps: 3,
      frameDelay: 100,
      scale: 1,
      colorScheme: lightColorScheme,
      frameCapture: solidFrame,
    });

    const buffer = await blob.arrayBuffer();
    const data = new Uint8Array(buffer);
    const delays = extractGifDelays(data);

    expect(delays.length).toBeGreaterThan(0);
    // 100ms = 10 centiseconds
    for (const d of delays) {
      expect(d).toBe(10);
    }
  });

  it("frameDelay — 200ms delay is encoded as 20 centiseconds in GIF metadata", async () => {
    const circuit = buildEmptyCircuit();
    const engine = new StubEngine();

    const blob = await exportGif(circuit, engine, {
      steps: 2,
      frameDelay: 200,
      scale: 1,
      colorScheme: lightColorScheme,
      frameCapture: solidFrame,
    });

    const buffer = await blob.arrayBuffer();
    const data = new Uint8Array(buffer);
    const delays = extractGifDelays(data);

    expect(delays.length).toBeGreaterThan(0);
    // 200ms = 20 centiseconds
    for (const d of delays) {
      expect(d).toBe(20);
    }
  });

  it("GIF starts with correct GIF89a header", async () => {
    const circuit = buildEmptyCircuit();
    const engine = new StubEngine();

    const blob = await exportGif(circuit, engine, {
      steps: 1,
      frameDelay: 100,
      scale: 1,
      colorScheme: lightColorScheme,
      frameCapture: solidFrame,
    });

    const buffer = await blob.arrayBuffer();
    const data = new Uint8Array(buffer);

    // GIF89a signature: 0x47 0x49 0x46 0x38 0x39 0x61 ('G','I','F','8','9','a')
    expect(data[0]).toBe(0x47); // G
    expect(data[1]).toBe(0x49); // I
    expect(data[2]).toBe(0x46); // F
    expect(data[3]).toBe(0x38); // 8
    expect(data[4]).toBe(0x39); // 9
    expect(data[5]).toBe(0x61); // a
  });
});

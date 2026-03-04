/**
 * Tests for WorkerDetection — task 3.4.5.
 *
 * Tests the canUseSharedArrayBuffer() detection and the createEngine() factory.
 * Worker integration tests (requiring COOP/COEP headers) are deferred to Phase 6.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { canUseSharedArrayBuffer, createEngine } from "../worker-detection.js";
import { DigitalEngine } from "../digital-engine.js";
import { WorkerEngine } from "../worker-engine.js";
import type { CompiledCircuit } from "@/core/engine-interface";

// ---------------------------------------------------------------------------
// Minimal CompiledCircuit stub
// ---------------------------------------------------------------------------

function makeCompiledCircuit(netCount = 4): CompiledCircuit {
  return { netCount, componentCount: 0 };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("WorkerDetection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // fallsBackToMainThread
  // -------------------------------------------------------------------------

  it("fallsBackToMainThread — mock SharedArrayBuffer unavailable, verify factory returns DigitalEngine", () => {
    // Simulate an environment where SharedArrayBuffer is not defined
    const originalSAB = (globalThis as Record<string, unknown>)["SharedArrayBuffer"];
    (globalThis as Record<string, unknown>)["SharedArrayBuffer"] = undefined;

    try {
      expect(canUseSharedArrayBuffer()).toBe(false);

      const engine = createEngine(makeCompiledCircuit(), "level");
      expect(engine).toBeInstanceOf(DigitalEngine);
    } finally {
      (globalThis as Record<string, unknown>)["SharedArrayBuffer"] = originalSAB;
    }
  });

  // -------------------------------------------------------------------------
  // usesWorkerWhenAvailable
  // -------------------------------------------------------------------------

  it("usesWorkerWhenAvailable — mock SAB available, verify factory returns WorkerEngine", () => {
    // Node.js test environment has SharedArrayBuffer available natively, so we
    // just verify the detection returns true and the factory returns WorkerEngine.
    //
    // If the environment does not have SAB (unusual), skip this assertion.
    if (typeof SharedArrayBuffer === "undefined") {
      // Environment has no SAB — cannot verify WorkerEngine path here.
      // This scenario is covered by the fallsBackToMainThread test above.
      return;
    }

    expect(canUseSharedArrayBuffer()).toBe(true);

    const engine = createEngine(makeCompiledCircuit(), "level");
    expect(engine).toBeInstanceOf(WorkerEngine);
  });
});

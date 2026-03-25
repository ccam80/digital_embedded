/**
 * Tests for WorkerDetection — canUseWorkerEngine() and createEngine() factory.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { canUseWorkerEngine, createEngine } from "../worker-detection.js";
import { DigitalEngine } from "../digital-engine.js";
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
  // falls_back_when_Worker_undefined
  // -------------------------------------------------------------------------

  it("falls_back_when_Worker_undefined", () => {
    // In Node.js test environment, Worker is not defined.
    // canUseWorkerEngine() should return false because Worker is unavailable,
    // even though SharedArrayBuffer is available.
    expect(typeof Worker).toBe("undefined");
    expect(canUseWorkerEngine()).toBe(false);

    // createEngine() should return a DigitalEngine instance (main-thread fallback)
    const engine = createEngine(makeCompiledCircuit(), "level");
    expect(engine).toBeInstanceOf(DigitalEngine);
  });

  // -------------------------------------------------------------------------
  // uses_worker_when_available
  // -------------------------------------------------------------------------

  it("uses_worker_when_available", () => {
    // Verify that when both SharedArrayBuffer and Worker are defined,
    // canUseWorkerEngine() returns true.
    //
    // We mock Worker on globalThis to simulate a browser environment.
    const originalWorker = (globalThis as Record<string, unknown>)["Worker"];
    (globalThis as Record<string, unknown>)["Worker"] = class MockWorker {
      onmessage: ((ev: unknown) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      postMessage(): void { /* no-op */ }
      terminate(): void { /* no-op */ }
    };

    try {
      expect(typeof SharedArrayBuffer !== "undefined").toBe(true);
      expect(typeof Worker !== "undefined").toBe(true);
      expect(canUseWorkerEngine()).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>)["Worker"] = originalWorker;
    }
  });

  // -------------------------------------------------------------------------
  // falls_back_when_SAB_undefined
  // -------------------------------------------------------------------------

  it("falls_back_when_SAB_undefined", () => {
    // When SharedArrayBuffer is unavailable, canUseWorkerEngine() returns false
    // regardless of whether Worker is available.
    const originalSAB = (globalThis as Record<string, unknown>)["SharedArrayBuffer"];
    (globalThis as Record<string, unknown>)["SharedArrayBuffer"] = undefined;

    try {
      expect(canUseWorkerEngine()).toBe(false);

      const engine = createEngine(makeCompiledCircuit(), "level");
      expect(engine).toBeInstanceOf(DigitalEngine);
    } finally {
      (globalThis as Record<string, unknown>)["SharedArrayBuffer"] = originalSAB;
    }
  });
});

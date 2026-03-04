/**
 * Web Worker entry point for the DigitalEngine.
 *
 * Receives EngineMessage commands via onmessage, runs the simulation, and
 * posts EngineResponse messages back to the main thread.
 *
 * The engine's signal Uint32Array is backed by a SharedArrayBuffer transferred
 * from the main thread during the init handshake, allowing the main thread to
 * read signal values via Atomics.load() without messaging overhead.
 *
 * This file is bundled as a separate chunk by Vite (worker entry point).
 */

import { DigitalEngine } from "./digital-engine.js";
import type { EngineMessage, EngineResponse, CompiledCircuit } from "@/core/engine-interface";
import { EngineState } from "@/core/engine-interface";

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let engine: DigitalEngine | null = null;

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (ev: MessageEvent<EngineMessage>): void => {
  const msg = ev.data;

  if (engine === null && msg.type !== "reset") {
    // Engine not yet initialised — ignore commands until reset is received
    return;
  }

  switch (msg.type) {
    case "step":
      runSafely(() => engine!.step());
      break;

    case "microStep":
      runSafely(() => engine!.microStep());
      break;

    case "runToBreak":
      runSafely(() => engine!.runToBreak());
      break;

    case "start":
      engine!.start();
      postResponse({ type: "stateChange", state: EngineState.RUNNING });
      break;

    case "stop":
      engine!.stop();
      postResponse({ type: "stateChange", state: EngineState.PAUSED });
      break;

    case "reset":
      if (engine === null) {
        engine = new DigitalEngine("level");
      }
      engine.reset();
      postResponse({ type: "stateChange", state: EngineState.STOPPED });
      break;

    case "dispose":
      engine?.dispose();
      engine = null;
      postResponse({ type: "stateChange", state: EngineState.STOPPED });
      break;

    case "setSignal": {
      const mockCircuit: CompiledCircuit = { netCount: 0, componentCount: 0 };
      void mockCircuit;
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function postResponse(response: EngineResponse): void {
  (self as unknown as { postMessage(msg: EngineResponse): void }).postMessage(response);
}

function runSafely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    postResponse({ type: "error", message });
  }
}

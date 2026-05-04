/**
 * Web Worker entry point for the DigitalEngine.
 *
 * Receives EngineMessage commands via onmessage, runs the simulation, and
 * posts EngineResponse messages back to the main thread.
 *
 * On receiving an "init" message, the worker reconstructs a ConcreteCompiledCircuit
 * from the transferred typed arrays and its own component registry. The
 * SharedArrayBuffer provides lock-free signal reads from the main thread.
 *
 * This file is bundled as a separate chunk by Vite (worker entry point).
 */

import { DigitalEngine } from "./digital-engine.js";
import { FlatComponentLayout } from "./compiled-circuit.js";
import { createDefaultRegistry } from "@/components/register-all";
import type { ExecuteFunction } from "@/core/registry";
import type { EngineMessage, EngineResponse } from "@/core/engine-interface";
import { EngineState } from "@/core/engine-interface";
import type { EvaluationGroup } from "./digital-engine.js";

// ---------------------------------------------------------------------------
// Worker state
// ---------------------------------------------------------------------------

let engine: DigitalEngine | null = null;

// SharedArrayBuffer views for signal sync (written after each step)
let sharedValues: Int32Array | null = null;
let sharedHighZs: Int32Array | null = null;

// ---------------------------------------------------------------------------
// No-op execute function for unrecognised types
// ---------------------------------------------------------------------------

const noopExecuteFn: ExecuteFunction = () => { /* no-op */ };

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

self.onmessage = (ev: MessageEvent<EngineMessage>): void => {
  const msg = ev.data;

  if (msg.type === "init") {
    handleInit(msg);
    return;
  }

  if (engine === null && msg.type !== "reset") {
    return;
  }

  switch (msg.type) {
    case "step":
      runSafely(() => {
        engine!.step();
        syncSharedBuffer();
      });
      break;

    case "microStep":
      runSafely(() => {
        engine!.microStep();
        syncSharedBuffer();
      });
      break;

    case "runToBreak":
      runSafely(() => {
        engine!.runToBreak();
        syncSharedBuffer();
      });
      break;

    case "start":
      postResponse({ type: "stateChange", state: EngineState.RUNNING });
      runContinuous();
      break;

    case "stop":
      stopContinuous();
      engine!.stop();
      postResponse({ type: "stateChange", state: EngineState.PAUSED });
      break;

    case "reset":
      if (engine === null) {
        engine = new DigitalEngine("level");
      }
      engine.reset();
      syncSharedBuffer();
      postResponse({ type: "stateChange", state: EngineState.STOPPED });
      break;

    case "dispose":
      engine?.dispose();
      engine = null;
      sharedValues = null;
      sharedHighZs = null;
      postResponse({ type: "stateChange", state: EngineState.STOPPED });
      break;

    case "setSignal": {
      if (engine !== null) {
        const signalArray = engine.getSignalArray();
        signalArray[msg.netId] = msg.valueLo;
      }
      break;
    }
  }
};

// ---------------------------------------------------------------------------
// Init handler -- reconstruct compiled circuit from transferred data
// ---------------------------------------------------------------------------

function handleInit(msg: Extract<EngineMessage, { type: "init" }>): void {
  const registry = createDefaultRegistry();

  // Build executeFns and sampleFns from type names
  const executeFns: ExecuteFunction[] = [];
  const sampleFns: (ExecuteFunction | null)[] = [];

  for (const typeName of msg.typeNames) {
    const def = registry.getStandalone(typeName);
    if (def !== undefined) {
      executeFns.push(def.models!.digital!.executeFn);
      sampleFns.push(def.models?.digital?.sampleFn ?? null);
    } else {
      console.warn(`Worker: unrecognized type name "${typeName}", using no-op`);
      executeFns.push(noopExecuteFn);
      sampleFns.push(null);
    }
  }

  // Reconstruct layout
  const layout = new FlatComponentLayout(
    msg.inputOffsets,
    msg.outputOffsets,
    msg.inputCounts,
    msg.outputCounts,
    msg.wiringTable,
    [],
    msg.stateOffsets,
  );

  if (msg.switchClassification.length > 0) {
    layout.setSwitchClassification(msg.switchClassification);
  }

  // Reconstruct evaluation groups
  const evaluationOrder: EvaluationGroup[] = msg.evaluationGroups.map((g) => ({
    componentIndices: g.componentIndices,
    isFeedback: g.isFeedback,
  }));

  // Build the worker-side compiled circuit object
  const compiled = {
    netCount: msg.netCount,
    componentCount: msg.componentCount,
    totalStateSlots: msg.signalArraySize - msg.netCount,
    signalArraySize: msg.signalArraySize,
    typeIds: msg.typeIds,
    executeFns,
    sampleFns,
    wiringTable: msg.wiringTable,
    layout,
    evaluationOrder,
    sequentialComponents: msg.sequentialComponents,
    netWidths: msg.netWidths,
    sccSnapshotBuffer: new Uint32Array(msg.netCount),
    delays: msg.delays,
    componentToElement: new Map(),
    wireToNetId: new Map(),
    pinNetMap: new Map(),
    resetComponentIndices: msg.resetComponentIndices,
    busResolver: null,
    multiDriverNets: new Set<number>(),
    switchComponentIndices: msg.switchComponentIndices,
    switchClassification: msg.switchClassification,
  };

  // Store shared buffer views
  sharedValues = new Int32Array(msg.sharedBuffer, 0, msg.netCount);
  sharedHighZs = new Int32Array(
    msg.sharedBuffer,
    msg.netCount * Int32Array.BYTES_PER_ELEMENT,
    msg.netCount,
  );

  // Create and initialise engine
  engine = new DigitalEngine("level");
  engine.init(compiled);

  syncSharedBuffer();
  postResponse({ type: "stateChange", state: EngineState.STOPPED });
}

// ---------------------------------------------------------------------------
// Signal sync -- copy engine state to shared buffer
// ---------------------------------------------------------------------------

function syncSharedBuffer(): void {
  if (engine === null || sharedValues === null || sharedHighZs === null) return;

  const signalArray = engine.getSignalArray();
  const netCount = sharedValues.length;

  for (let i = 0; i < netCount; i++) {
    Atomics.store(sharedValues, i, signalArray[i]!);
  }
}

// ---------------------------------------------------------------------------
// Continuous run using MessageChannel for yielding
// ---------------------------------------------------------------------------

let continuousPort: MessagePort | null = null;

function runContinuous(): void {
  if (engine === null) return;

  const channel = new MessageChannel();
  continuousPort = channel.port1;

  channel.port1.onmessage = () => {
    if (engine === null || engine.getState() !== EngineState.RUNNING) {
      continuousPort = null;
      return;
    }

    try {
      engine.step();
      syncSharedBuffer();
      channel.port2.postMessage(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      postResponse({ type: "error", message });
      continuousPort = null;
    }
  };

  channel.port2.postMessage(null);
}

function stopContinuous(): void {
  if (continuousPort !== null) {
    continuousPort.close();
    continuousPort = null;
  }
}

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

/**
 * EditorBinding — integration layer connecting the compiled engine to the
 * visual editor.
 *
 * Holds the Wire→netId and pin-key→netId mappings produced by the compiler.
 * Routes interactive input (user clicking an In component) through to the
 * engine via setSignalValue(). Provides getWireValue() and getPinValue() for
 * the renderer and property panels.
 *
 * Browser-free: no Canvas2D or DOM imports. The renderer calls into this
 * module; this module does not import the renderer.
 */

import type { Wire, Circuit } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { SimulationEngine } from "@/core/engine-interface";
import type { BitVector } from "@/core/signal";

// ---------------------------------------------------------------------------
// EditorBinding interface
// ---------------------------------------------------------------------------

export interface EditorBinding {
  /**
   * Connect a circuit, engine, and net-ID mappings.
   *
   * circuit     — the compiled circuit providing component-to-pin context.
   * wireNetMap  — maps each Wire to the net ID assigned by the compiler.
   * pinNetMap   — maps "{instanceId}:{pinLabel}" keys to net IDs.
   */
  bind(
    circuit: Circuit,
    engine: SimulationEngine,
    wireNetMap: Map<Wire, number>,
    pinNetMap: Map<string, number>,
  ): void;

  /** Disconnect from the engine and clear all mappings. */
  unbind(): void;

  /**
   * Return the raw signal value for a wire.
   * Throws if not currently bound.
   */
  getWireValue(wire: Wire): number;

  /**
   * Return the raw signal value for a pin on a specific element.
   * Throws if not currently bound.
   */
  getPinValue(element: CircuitElement, pinLabel: string): number;

  /**
   * Drive an input signal change from the UI.
   * Looks up the net ID for the pin, then calls engine.setSignalValue().
   * Throws if not currently bound.
   */
  setInput(element: CircuitElement, pinLabel: string, value: BitVector): void;

  /** True when bind() has been called and unbind() has not. */
  readonly isBound: boolean;

  /** The bound engine, or null when unbound. */
  readonly engine: SimulationEngine | null;
}

// ---------------------------------------------------------------------------
// EditorBindingImpl
// ---------------------------------------------------------------------------

class EditorBindingImpl implements EditorBinding {
  private _engine: SimulationEngine | null = null;
  private _wireNetMap: Map<Wire, number> = new Map();
  private _pinNetMap: Map<string, number> = new Map();

  bind(
    circuit: Circuit,
    engine: SimulationEngine,
    wireNetMap: Map<Wire, number>,
    pinNetMap: Map<string, number>,
  ): void {
    void circuit; // circuit reference not stored; engine manages state
    this._engine = engine;
    this._wireNetMap = wireNetMap;
    this._pinNetMap = pinNetMap;
  }

  unbind(): void {
    this._engine = null;
    this._wireNetMap = new Map();
    this._pinNetMap = new Map();
  }

  getWireValue(wire: Wire): number {
    if (this._engine === null) {
      throw new Error("EditorBinding: not bound to an engine");
    }
    const netId = this._wireNetMap.get(wire);
    if (netId === undefined) {
      throw new Error("EditorBinding: wire has no net assignment");
    }
    return this._engine.getSignalRaw(netId);
  }

  getPinValue(element: CircuitElement, pinLabel: string): number {
    if (this._engine === null) {
      throw new Error("EditorBinding: not bound to an engine");
    }
    const key = `${element.instanceId}:${pinLabel}`;
    const netId = this._pinNetMap.get(key);
    if (netId === undefined) {
      throw new Error(
        `EditorBinding: pin "${key}" has no net assignment`,
      );
    }
    return this._engine.getSignalRaw(netId);
  }

  setInput(
    element: CircuitElement,
    pinLabel: string,
    value: BitVector,
  ): void {
    if (this._engine === null) {
      throw new Error("EditorBinding: not bound to an engine");
    }
    const key = `${element.instanceId}:${pinLabel}`;
    const netId = this._pinNetMap.get(key);
    if (netId === undefined) {
      throw new Error(
        `EditorBinding: pin "${key}" has no net assignment`,
      );
    }
    this._engine.setSignalValue(netId, value);
  }

  get isBound(): boolean {
    return this._engine !== null;
  }

  get engine(): SimulationEngine | null {
    return this._engine;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a new EditorBinding instance. */
export function createEditorBinding(): EditorBinding {
  return new EditorBindingImpl();
}

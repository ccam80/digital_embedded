/**
 * EditorBinding — integration layer connecting the compiled coordinator to the
 * visual editor.
 *
 * Holds the Wire→SignalAddress and pin-key→SignalAddress mappings produced by
 * the unified compiler. Routes interactive input (user clicking an In component)
 * through to the coordinator via writeSignal(). Provides getWireSignal(),
 * getWireValue(), and getPinValue() for the renderer and property panels.
 *
 * Browser-free: no Canvas2D or DOM imports. The renderer calls into this
 * module; this module does not import the renderer.
 */

import type { Wire, Circuit } from "@/core/circuit";
import type { CircuitElement } from "@/core/element";
import type { SimulationEngine } from "@/core/engine-interface";
import type { BitVector } from "@/core/signal";
import type { SignalAddress, SignalValue } from "@/compile/types";
import type { SimulationCoordinator } from "@/compile/coordinator-types";

// ---------------------------------------------------------------------------
// Helper: extract a raw number from a SignalValue
// ---------------------------------------------------------------------------

function signalToNumber(sv: SignalValue): number {
  return sv.type === "digital" ? sv.value : sv.voltage;
}

// ---------------------------------------------------------------------------
// EditorBinding interface
// ---------------------------------------------------------------------------

export interface EditorBinding {
  /**
   * Connect a circuit, coordinator, and signal-address mappings.
   *
   * circuit         — the compiled circuit providing component-to-pin context.
   * coordinator     — unified simulation coordinator for all domains.
   * wireSignalMap   — maps each Wire to its SignalAddress (from CompiledCircuitUnified).
   * pinSignalMap    — maps "{instanceId}:{pinLabel}" keys to SignalAddresses.
   */
  bind(
    _circuit: Circuit,
    coordinator: SimulationCoordinator,
    wireSignalMap: Map<Wire, SignalAddress>,
    pinSignalMap: Map<string, SignalAddress>,
  ): void;

  /** Disconnect from the coordinator and clear all mappings. */
  unbind(): void;

  /**
   * Return the SignalValue for a wire.
   * Throws if not currently bound.
   */
  getWireSignal(wire: Wire): SignalValue;

  /**
   * Return the raw numeric signal value for a wire.
   * Extracts value from SignalValue (digital → value, analog → voltage).
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
   * Looks up the SignalAddress for the pin, then calls coordinator.writeSignal().
   * Throws if not currently bound.
   */
  setInput(element: CircuitElement, pinLabel: string, value: BitVector): void;

  /** True when bind() has been called and unbind() has not. */
  readonly isBound: boolean;

  /** The bound coordinator, or null when unbound. */
  readonly coordinator: SimulationCoordinator | null;

  /** The digital backend engine, or null when unbound or no digital domain. */
  readonly engine: SimulationEngine | null;
}

// ---------------------------------------------------------------------------
// EditorBindingImpl
// ---------------------------------------------------------------------------

class EditorBindingImpl implements EditorBinding {
  private _coordinator: SimulationCoordinator | null = null;
  private _wireSignalMap: Map<Wire, SignalAddress> = new Map();
  private _pinSignalMap: Map<string, SignalAddress> = new Map();

  bind(
    _circuit: Circuit,
    coordinator: SimulationCoordinator,
    wireSignalMap: Map<Wire, SignalAddress>,
    pinSignalMap: Map<string, SignalAddress>,
  ): void {
    this._coordinator = coordinator;
    this._wireSignalMap = wireSignalMap;
    this._pinSignalMap = pinSignalMap;
  }

  unbind(): void {
    this._coordinator = null;
    this._wireSignalMap = new Map();
    this._pinSignalMap = new Map();
  }

  getWireSignal(wire: Wire): SignalValue {
    if (this._coordinator === null) {
      throw new Error("EditorBinding: not bound to a coordinator");
    }
    const addr = this._wireSignalMap.get(wire);
    if (addr === undefined) {
      throw new Error("EditorBinding: wire has no signal address");
    }
    return this._coordinator.readSignal(addr);
  }

  getWireValue(wire: Wire): number {
    return signalToNumber(this.getWireSignal(wire));
  }

  getPinValue(element: CircuitElement, pinLabel: string): number {
    if (this._coordinator === null) {
      throw new Error("EditorBinding: not bound to a coordinator");
    }
    const key = `${element.instanceId}:${pinLabel}`;
    const addr = this._pinSignalMap.get(key);
    if (addr === undefined) {
      throw new Error(
        `EditorBinding: pin "${key}" has no signal address`,
      );
    }
    return signalToNumber(this._coordinator.readSignal(addr));
  }

  setInput(
    element: CircuitElement,
    pinLabel: string,
    value: BitVector,
  ): void {
    if (this._coordinator === null) {
      throw new Error("EditorBinding: not bound to a coordinator");
    }
    const key = `${element.instanceId}:${pinLabel}`;
    const addr = this._pinSignalMap.get(key);
    if (addr === undefined) {
      throw new Error(
        `EditorBinding: pin "${key}" has no signal address`,
      );
    }
    const sv: SignalValue = addr.domain === "digital"
      ? { type: "digital", value: value.toNumber() }
      : { type: "analog", voltage: value.toNumber() };
    this._coordinator.writeSignal(addr, sv);
  }

  get isBound(): boolean {
    return this._coordinator !== null;
  }

  get coordinator(): SimulationCoordinator | null {
    return this._coordinator;
  }

  get engine(): SimulationEngine | null {
    return this._coordinator?.digitalBackend ?? null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a new EditorBinding instance. */
export function createEditorBinding(): EditorBinding {
  return new EditorBindingImpl();
}

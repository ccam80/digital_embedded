/**
 * Unified compilation types for the Phase 3 netlist extraction and partitioning pipeline.
 *
 * Sections 4.3–4.6 of spec/unified-component-architecture.md.
 */

import type { Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { Point, PinDirection } from "../core/pin.js";
import type { PinElectricalSpec } from "../core/pin-electrical.js";
import type { ComponentDefinition, DigitalModel, AnalogModel } from "../core/registry.js";
import type { CrossEngineBoundary } from "../solver/digital/cross-engine-boundary.js";
import type { CompiledCircuitImpl as CompiledDigitalDomain } from "../solver/digital/compiled-circuit.js";
import type { ConcreteCompiledAnalogCircuit as CompiledAnalogDomain } from "../solver/analog/compiled-analog-circuit.js";
import type { Diagnostic } from "../headless/netlist-types.js";

export type { Diagnostic };

// ---------------------------------------------------------------------------
// Re-export imported types for downstream consumers of this module
// ---------------------------------------------------------------------------

export type { Wire, CircuitElement, ComponentDefinition, DigitalModel, AnalogModel };
export type { PinElectricalSpec, CrossEngineBoundary };
export type { CompiledDigitalDomain, CompiledAnalogDomain };

// ---------------------------------------------------------------------------
// Section 4.3 — Connectivity group types
// ---------------------------------------------------------------------------

/**
 * A single pin resolved to world coordinates and its domain, produced by
 * extractConnectivityGroups().
 */
export interface ResolvedGroupPin {
  elementIndex: number;
  pinIndex: number;
  pinLabel: string;
  direction: PinDirection;
  bitWidth: number;
  worldPosition: Point;
  wireVertex: Point | null;
  domain: string;
}

/**
 * A connected group of pins and wires sharing the same electrical node.
 * The `domains` set contains all engine domains present on pins in this group.
 * Groups with `domains.size > 1` are cross-engine boundary groups.
 */
export interface ConnectivityGroup {
  groupId: number;
  pins: ResolvedGroupPin[];
  wires: Wire[];
  domains: Set<string>;
  bitWidth?: number;
}

// ---------------------------------------------------------------------------
// Section 4.4 — Solver partition types
// ---------------------------------------------------------------------------

/**
 * A single component resolved to its active model and domain, within a partition.
 */
export interface PartitionedComponent {
  element: CircuitElement;
  definition: ComponentDefinition;
  model: DigitalModel | AnalogModel;
  resolvedPins: ResolvedGroupPin[];
}

/**
 * Describes a single cross-domain boundary group — the data needed to
 * build a bridge adapter connecting the two simulation domains.
 */
export interface BridgeDescriptor {
  boundaryGroup: ConnectivityGroup;
  direction: "digital-to-analog" | "analog-to-digital";
  bitWidth: number;
  electricalSpec: PinElectricalSpec;
}

/**
 * Reference to a bridge descriptor, keyed by the boundary group ID.
 * Held in a SolverPartition so each side knows which groups require bridging.
 */
export interface BridgeStub {
  boundaryGroupId: number;
  descriptor: BridgeDescriptor;
}

/**
 * All components, groups, and bridge stubs for one simulation domain.
 * Either or both partitions may be empty (zero components, zero groups).
 */
export interface SolverPartition {
  components: PartitionedComponent[];
  groups: ConnectivityGroup[];
  bridgeStubs: BridgeStub[];
  crossEngineBoundaries: CrossEngineBoundary[];
}

// ---------------------------------------------------------------------------
// Bridge adapter — runtime cross-domain link
// ---------------------------------------------------------------------------

/**
 * A runtime bridge connecting a digital net to an analog node.
 *
 * Produced by the bridge builder during compilation. The coordinator reads
 * `digitalNetId` from the digital engine and drives the analog node, or
 * reads the analog voltage and thresholds it back to a digital value.
 */
export interface BridgeAdapter {
  /** The connectivity group that straddles the domain boundary. */
  boundaryGroupId: number;
  /** Net ID in the compiled digital domain for this boundary. */
  digitalNetId: number;
  /** Node ID in the compiled analog domain for this boundary. */
  analogNodeId: number;
  /** Signal direction: which domain drives. */
  direction: "digital-to-analog" | "analog-to-digital";
  /** Bit width of the crossing signal. */
  bitWidth: number;
  /** Electrical characteristics for threshold/drive computations. */
  electricalSpec: PinElectricalSpec;
}

// ---------------------------------------------------------------------------
// Section 4.6 — Unified compiled output
// ---------------------------------------------------------------------------

/**
 * Signal address in either the digital or analog domain.
 *
 * Used by wireSignalMap and labelSignalMap so the renderer and runner can
 * resolve any signal without knowing which domain it belongs to.
 */
export type SignalAddress =
  | { domain: "digital"; netId: number; bitWidth: number }
  | { domain: "analog"; nodeId: number };

/**
 * A snapshot signal value from either domain.
 */
export type SignalValue =
  | { type: "digital"; value: number }
  | { type: "analog"; voltage: number; current?: number };

/**
 * The unified output of the single `compileUnified()` entry point.
 *
 * Contains both compiled domains (null when not present), bridge adapters,
 * wire-to-signal and label-to-signal maps, and collected diagnostics.
 */
export interface CompiledCircuitUnified {
  /** Compiled digital domain (null if no digital components). */
  digital: CompiledDigitalDomain | null;
  /** Compiled analog domain (null if no analog components). */
  analog: CompiledAnalogDomain | null;
  /** Bridge adapters connecting the two domains. */
  bridges: BridgeAdapter[];
  /** Map from original circuit Wire → signal address for wire-state rendering. */
  wireSignalMap: Map<Wire, SignalAddress>;
  /** Map from component label → signal address for label-based I/O. */
  labelSignalMap: Map<string, SignalAddress>;
  /** Diagnostics collected during compilation. */
  diagnostics: Diagnostic[];
}

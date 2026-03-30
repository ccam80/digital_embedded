/**
 * Unified compilation types for the Phase 3 netlist extraction and partitioning pipeline.
 *
 * Sections 4.3–4.6 of spec/unified-component-architecture.md.
 */

import type { Circuit, Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { Point, PinDirection } from "../core/pin.js";
import type { PinElectricalSpec } from "../core/pin-electrical.js";
import type { ComponentDefinition, DigitalModel, AnalogFactory } from "../core/registry.js";
import type { ComponentRegistry } from "../core/registry.js";
import type { CompiledCircuitImpl as CompiledDigitalDomain } from "../solver/digital/compiled-circuit.js";
import type { ConcreteCompiledAnalogCircuit as CompiledAnalogDomain } from "../solver/analog/compiled-analog-circuit.js";
import type { NetPin } from "../headless/netlist-types.js";

// ---------------------------------------------------------------------------
// Diagnostic and DiagnosticCode — canonical definitions (moved from headless)
// ---------------------------------------------------------------------------

/**
 * Diagnostic codes for pre-compilation and compilation errors/warnings.
 */
export type DiagnosticCode =
  | 'width-mismatch'
  | 'unconnected-input'
  | 'unconnected-output'
  | 'multi-driver-no-tristate'
  | 'missing-subcircuit'
  | 'label-collision'
  | 'combinational-loop'
  | 'missing-property'
  | 'unknown-component'
  | 'unsupported-ctz-component'
  | 'orphaned-pin-loading-override'
  | 'invalid-simulation-model'
  | 'unresolved-model-ref';

/**
 * A single diagnostic: an error, warning, or informational note about
 * the circuit structure.
 *
 * Consumed by:
 * - GUI status bar / error panel (human-readable `message`)
 * - Headless facade / LLM agents (structured fields for programmatic use)
 * - postMessage API (serializable to JSON)
 */
export interface Diagnostic {
  /** Severity level. */
  readonly severity: 'error' | 'warning' | 'info';
  /** Machine-readable diagnostic code. */
  readonly code: DiagnosticCode;
  /** Human-readable description. */
  readonly message: string;
  /** Net involved, if applicable. */
  readonly netId?: number;
  /** Pins involved (e.g. the two sides of a width mismatch). */
  readonly pins?: NetPin[];
  /** Which .dig file this relates to (for subcircuit errors). */
  readonly subcircuitFile?: string;
  /** Nesting path for subcircuit errors. */
  readonly hierarchyPath?: readonly string[];
  /** Suggested fix in plain English. */
  readonly fix?: string;
}

// ---------------------------------------------------------------------------
// MnaModel — compiler-internal analog model representation
// ---------------------------------------------------------------------------

import type { PropertyBag } from "../core/properties.js";
import type { AnalogElementCore } from "../core/analog-types.js";

/**
 * Compiler-internal representation of an analog model that can be stamped
 * into the MNA matrix. The compiler resolves ModelEntry (from modelRegistry)
 * into this shape before the stamp loop.
 */
export interface MnaModel {
  factory: (
    pinNodes: ReadonlyMap<string, number>,
    internalNodeIds: readonly number[],
    branchIdx: number,
    props: PropertyBag,
    getTime: () => number,
  ) => AnalogElementCore;
  getInternalNodeCount?: (props: PropertyBag) => number;
  branchCount?: number;
}

// ---------------------------------------------------------------------------
// Re-export imported types for downstream consumers of this module
// ---------------------------------------------------------------------------

export type { Wire, CircuitElement, ComponentDefinition, DigitalModel, AnalogFactory };
export type { PinElectricalSpec };
export type { CompiledDigitalDomain, CompiledAnalogDomain };

// ---------------------------------------------------------------------------
// Callback type for compiling an inner digital sub-circuit.
//
// Used to break the circular dependency between compile/compile.ts and
// solver/analog/compiler.ts: the analog compiler accepts this callback
// instead of importing compileUnified directly.
// ---------------------------------------------------------------------------

/**
 * Compiles a standalone digital Circuit into a CompiledCircuitImpl.
 * Injected into compileAnalogPartition() by the caller (compile/compile.ts)
 * to avoid a circular module dependency.
 */
export type DigitalCompilerFn = (
  circuit: Circuit,
  registry: ComponentRegistry,
) => CompiledDigitalDomain;

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
  kind: "signal" | "power";
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
  modelKey: string;
  model: DigitalModel | MnaModel | null;
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
  /** Map from "instanceId:pinLabel" → signal address for pin-level I/O (editor binding). */
  pinSignalMap: Map<string, SignalAddress>;
  /** Diagnostics collected during compilation. */
  diagnostics: Diagnostic[];
  /**
   * All visual CircuitElements from the (flattened) circuit, including
   * structural elements such as Tunnels that are not stamped by any domain
   * compiler. Used by WireCurrentResolver for tunnel-vertex detection.
   */
  allCircuitElements: readonly CircuitElement[];
}

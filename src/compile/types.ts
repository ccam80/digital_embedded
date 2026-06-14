/**
 * Unified compilation types for the Phase 3 netlist extraction and partitioning pipeline.
 *
 * Sections 4.3–4.6 of spec/unified-component-architecture.md.
 */

import type { Circuit, Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import type { Point, PinDirection } from "../core/pin.js";
import type { PinElectricalSpec } from "../core/pin-electrical.js";
import type { ComponentDefinition, StandaloneComponentDefinition, DigitalModel, AnalogFactory } from "../core/registry.js";
import type { ComponentRegistry } from "../core/registry.js";
import type { CompiledCircuitImpl as CompiledDigitalDomain } from "../solver/digital/compiled-circuit.js";
import type { ConcreteCompiledAnalogCircuit as CompiledAnalogDomain } from "../solver/analog/compiled-analog-circuit.js";

// ---------------------------------------------------------------------------
// Diagnostic and DiagnosticCode- canonical unified definitions
// ---------------------------------------------------------------------------

/**
 * All diagnostic codes emitted by the compiler, netlist validator, and analog solver.
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
  | 'spec-connection-missing-element'
  | 'spec-connection-missing-pin'
  | 'auto-layout-collision'
  | 'unsupported-ctz-component'
  | 'orphaned-pin-loading-override'
  | 'invalid-simulation-model'
  | 'unresolved-model-ref'
  | 'competing-voltage-constraints'
  | 'singular-matrix'
  | 'voltage-source-loop'
  | 'floating-node'
  | 'orphan-node'
  | 'inductor-loop'
  | 'no-ground'
  | 'convergence-failed'
  | 'timestep-too-small'
  | 'dc-op-converged'
  | 'dc-op-gmin'
  | 'dc-op-source-step'
  | 'dc-op-failed'
  | 'model-param-ignored'
  | 'model-level-unsupported'
  | 'bridge-inner-compile-error'
  | 'bridge-unconnected-pin'
  | 'bridge-missing-inner-pin'
  | 'bridge-indeterminate-input'
  | 'bridge-oscillating-input'
  | 'bridge-impedance-mismatch'
  | 'transmission-line-low-segments'
  | 'reverse-biased-cap'
  | 'fuse-blown'
  | 'ndr-convergence-assist'
  | 'rs-flipflop-both-set'
  | 'ac-no-source'
  | 'ac-linearization-failed'
  | 'monte-carlo-trial-failed'
  | 'unconnected-analog-pin'
  | 'floating-terminal'
  | 'reactive-state-outside-pool'
  | 'inductive-system-not-positive-definite'
  | 'inductive-system-duplicate-k'
  | 'inductive-system-incomplete-k'
  | 'internal-error';

/**
 * A concrete suggestion attached to a `Diagnostic`.
 *
 * When `automatable` is `true`, the editor can apply the fix automatically
 * using the `patch` field as a circuit patch operation.
 */
export interface DiagnosticSuggestion {
  /** Human-readable description of the suggested fix. */
  text: string;
  /** Whether the editor can apply this fix without user intervention. */
  automatable: boolean;
  /** Optional patch operation that implements the fix. */
  patch?: unknown;
}

/**
 * A single diagnostic: an error, warning, or informational note about
 * the circuit structure or analog solver state.
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
  /** Detailed explanation for display in the diagnostics panel. */
  readonly explanation?: string;
  /** Ordered list of suggested fixes. */
  readonly suggestions?: DiagnosticSuggestion[];
  /** MNA node IDs involved in this diagnostic, if applicable. */
  readonly involvedNodes?: number[];
  /** World-space positions of involved pins, for overlay rendering. */
  readonly involvedPositions?: Point[];
  /** Element IDs involved in this diagnostic, if applicable. */
  readonly involvedElements?: number[];
  /** Simulation time at which this diagnostic was emitted, in seconds. */
  readonly simTime?: number;
  /** Additional detail string for extended context. */
  readonly detail?: string;
  /** Net involved, if applicable. */
  readonly netId?: number;
  /** Which .dig file this relates to (for subcircuit errors). */
  readonly subcircuitFile?: string;
  /** Nesting path for subcircuit errors. */
  readonly hierarchyPath?: readonly string[];
}

// ---------------------------------------------------------------------------
// MnaModel- compiler-internal analog model representation
// ---------------------------------------------------------------------------

import type { PropertyBag } from "../core/properties.js";
import type { AnalogElement } from "../solver/analog/element.js";

/**
 * Compiler-internal representation of an analog model that can be stamped
 * into the MNA matrix. The compiler resolves ModelEntry (from modelRegistry)
 * into this shape before the stamp loop.
 *
 * `findBranchFor` lives on the constructed element (per spec A.6), not on
 * the model. The engine resolves a branch by `findDevice(label)` then
 * dispatching `el.findBranchFor?.(name, ctx)`.
 */
export interface MnaModel {
  factory: (
    pinNodes: ReadonlyMap<string, number>,
    props: PropertyBag,
    getTime: () => number,
  ) => AnalogElement;
}

// ---------------------------------------------------------------------------
// Re-export imported types for downstream consumers of this module
// ---------------------------------------------------------------------------

export type { Wire, CircuitElement, ComponentDefinition, StandaloneComponentDefinition, DigitalModel, AnalogFactory };
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
// Section 4.3- Connectivity group types
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
  /**
   * Per-net loading mode override for boundary groups.
   * "ideal" instructs the bridge builder to zero out loading contributions
   * on this net. Only set by applyLoadingDecisions() on boundary groups
   * that have an explicit per-net "ideal" override.
   */
  loadingMode?: "loaded" | "ideal";
}

// ---------------------------------------------------------------------------
// Section 4.4- Solver partition types
// ---------------------------------------------------------------------------

/**
 * A single component resolved to its active model and domain, within a partition.
 */
export interface PartitionedComponent {
  element: CircuitElement;
  definition: StandaloneComponentDefinition;
  modelKey: string;
  model: DigitalModel | MnaModel | null;
  resolvedPins: ResolvedGroupPin[];
}

/**
 * Describes ONE crossing digital pin at a cross-domain boundary group.
 *
 * Per-pin (not per-net): a single physical boundary net that carries N
 * crossing digital pins emits N BridgePinDescriptors, all sharing the same
 * `analogGroupId` (the merged analog hub node) but each carrying its own
 * private digital net, role, and resolved electrical spec.
 *
 * `role` is derived from the crossing pin's own `direction`
 * (OUTPUT -> 'output', anything else -> 'input'); there is no per-net
 * direction collapse. `isTriState` is uniformly true for output crossings
 * (every output crossing realizes a DigitalOutputPinTriState whose `en` port
 * the coordinator drives from highZs).
 */
export interface BridgePinDescriptor {
  /** The boundary connectivity group whose analog hub this pin attaches to. */
  boundaryGroup: ConnectivityGroup;
  /** Analog hub group ID (== boundaryGroup.groupId). Every pin on the net
   *  shares this; it resolves to the single shared analog MNA node. */
  analogGroupId: number;
  /** Stable identity of the crossing digital pin: "instanceId:pinLabel".
   *  Used to mint the pin's private digital net and to label the adapter. */
  pinKey: string;
  /** The crossing pin's own label (e.g. "out", "In_2"). */
  pinLabel: string;
  /** Element index (into the flat circuit elements array) of the crossing
   *  pin's owning component. */
  elementIndex: number;
  /** Pin index within that component. */
  pinIndex: number;
  /** Boundary role of THIS pin: 'output' when pin.direction===OUTPUT, else
   *  'input'. Replaces the per-net bridgeDirection collapse. */
  role: "output" | "input";
  /** Output crossings always realize a tri-state output pin so highZs can
   *  release the node; gates simply never assert Hi-Z (en stays 1). Inputs
   *  carry false. */
  isTriState: boolean;
  bitWidth: number;
  /** Per-pin electrical spec resolved from THIS pin's component cascade. */
  electricalSpec: PinElectricalSpec;
}

/**
 * Reference to a per-pin bridge descriptor. Held in a SolverPartition so each
 * side knows which crossing pins require an adapter. Keyed by the crossing
 * pin's stable `pinKey` (an analog hub net carries one stub per crossing pin).
 */
export interface BridgeStub {
  /** Stable "instanceId:pinLabel" of the crossing pin. */
  pinKey: string;
  /** Analog hub group ID this pin's adapter `node` port attaches to. */
  analogGroupId: number;
  descriptor: BridgePinDescriptor;
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
// Bridge adapter- runtime cross-domain link
// ---------------------------------------------------------------------------

/**
 * A runtime bridge connecting a digital net to an analog node.
 *
 * Produced by the bridge builder during compilation. The coordinator reads
 * `digitalNetId` from the digital engine and drives the analog node, or
 * reads the analog voltage and thresholds it back to a digital value.
 */
export interface BridgeAdapter {
  /** Stable "instanceId:pinLabel" of the crossing pin. */
  pinKey: string;
  /** Analog hub group ID (shared by all pins on the net). */
  analogGroupId: number;
  /** Private digital net ID minted for THIS pin in the compiled digital
   *  domain. */
  digitalNetId: number;
  /** Shared analog MNA node ID for the boundary hub. */
  analogNodeId: number;
  /** Boundary role of this pin. */
  role: "output" | "input";
  /** True for output crossings (always tri-state-capable). */
  isTriState: boolean;
  /** Bit width of the crossing signal. */
  bitWidth: number;
  /** Per-pin electrical characteristics for threshold/drive computations. */
  electricalSpec: PinElectricalSpec;
}

// ---------------------------------------------------------------------------
// Section 4.6- Unified compiled output
// ---------------------------------------------------------------------------

/**
 * Signal address in either the digital or analog domain.
 *
 * Used by wireSignalMap and labelSignalMap so the renderer and runner can
 * resolve any signal without knowing which domain it belongs to.
 */
export type SignalAddress =
  | { domain: "digital"; netId: number; bitWidth: number; direction: PinDirection }
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
  /** Map from component label → CircuitElement for all labeled elements in the flattened circuit. */
  labelToCircuitElement: Map<string, CircuitElement>;
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

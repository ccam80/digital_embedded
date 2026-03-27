/**
 * Netlist, diagnostic, and circuit-editing types for the headless API.
 *
 * These types define the read/write interface for agent-led circuit
 * introspection and design. The core principle: **read and write use
 * the same addressing scheme.** If the netlist shows `sysreg:ADD [1-bit]`,
 * the edit is `{ op: 'set', target: 'ADD', props: { Bits: 16 } }`.
 */

import type { PinDirection } from '../core/pin.js';
import type { PropertyValue } from '../core/properties.js';
import type { Diagnostic } from '../compile/types.js';

// ===========================================================================
// Netlist — the read side
// ===========================================================================

/**
 * Complete netlist view of a circuit: components, nets, and diagnostics.
 * Returned by `netlist(circuit)` on the facade.
 */
export interface Netlist {
  /** All components in the circuit, with their pins and properties. */
  readonly components: ComponentDescriptor[];
  /** All nets (connected groups of pins). */
  readonly nets: NetDescriptor[];
  /** Pre-compilation diagnostics (width mismatches, unconnected pins, etc.). */
  readonly diagnostics: Diagnostic[];
}

/**
 * One net: a group of pins connected by wires (and/or tunnels).
 */
export interface NetDescriptor {
  /** Unique net identifier (stable within one netlist call). */
  readonly netId: number;
  /**
   * Inferred bit width of this net. `null` when pins disagree (→ diagnostic).
   * When pins agree, this is their shared width.
   */
  readonly inferredWidth: number | null;
  /** All pins connected to this net. */
  readonly pins: NetPin[];
}

/**
 * A pin's membership in a net — the fundamental unit of connectivity.
 *
 * This is the same structure used in both netlist output (reading) and
 * diagnostic context (errors), so agents see consistent addresses.
 */
export interface NetPin {
  /** Index into `Netlist.components`. */
  readonly componentIndex: number;
  /** Component type name (e.g. "And", "In", "sysreg"). */
  readonly componentType: string;
  /** User-assigned label if present, otherwise instanceId. */
  readonly componentLabel: string;
  /** Pin label on the component (e.g. "A", "Q", "ADD"). */
  readonly pinLabel: string;
  /** Pin direction. */
  readonly pinDirection: PinDirection;
  /** Declared bit width on this pin. */
  readonly declaredWidth: number;
  /** Subcircuit nesting path, e.g. ["MCU.dig", "sysreg"]. Empty for top-level. */
  readonly hierarchyPath: readonly string[];
}

/**
 * Describes one component instance in the circuit.
 */
export interface ComponentDescriptor {
  /** Index in the circuit's element list. */
  readonly index: number;
  /** Component type name (e.g. "And", "FlipflopD"). */
  readonly typeId: string;
  /** User-assigned label, if any. */
  readonly label: string | undefined;
  /** Unique instance identifier. */
  readonly instanceId: string;
  /** All pins on this component, with connectivity info. */
  readonly pins: PinDescriptor[];
  /** Component properties (Bits, label, Inputs, etc.). */
  readonly properties: Record<string, PropertyValue>;
  /** Simulation model keys available for this component type (e.g. ["digital"], ["analog"], ["digital", "analog"]). */
  readonly availableModels: string[];
  /** Active model key for this instance, if explicitly set. */
  readonly activeModel?: string;
}

/**
 * Describes one pin on a component, including what it's connected to.
 *
 * The `connectedTo` array is the key introspection feature: for each pin,
 * you see every other pin on the same net. Width mismatches jump out.
 */
export interface PinDescriptor {
  /** Pin label (e.g. "A", "out", "ADD"). */
  readonly label: string;
  /** Pin direction. */
  readonly direction: PinDirection;
  /** Declared bit width. */
  readonly bitWidth: number;
  /** Net ID this pin is assigned to (-1 if unconnected). */
  readonly netId: number;
  /** All OTHER pins on the same net. Empty if unconnected. */
  readonly connectedTo: NetPin[];
}

// ===========================================================================
// Diagnostics — re-exported from compile/types.ts (canonical home)
// ===========================================================================

export type { DiagnosticCode, Diagnostic } from '../compile/types.js';

// ===========================================================================
// Circuit spec — declarative circuit creation (the write side, new circuits)
// ===========================================================================

/**
 * Declarative description of a circuit for `build()`.
 *
 * No coordinates, no object references — pure topology.
 * The builder auto-lays-out and auto-routes.
 */
export interface CircuitSpec {
  /** Optional circuit name. */
  readonly name?: string;
  /** Optional circuit description. */
  readonly description?: string;
  /** Components to create. */
  readonly components: ComponentSpec[];
  /**
   * Connections as pairs of "id:pin" addresses.
   * The `id` is the ComponentSpec.id, the `pin` is a pin label.
   * Example: `["A:out", "gate:A"]`
   */
  readonly connections: readonly [string, string][];
}

/**
 * One component in a CircuitSpec.
 */
export interface ComponentSpec {
  /** Local identifier — used in `connections` to address this component. */
  readonly id: string;
  /** Component type name from registry (e.g. "And", "In", "FlipflopD"). */
  readonly type: string;
  /** Optional properties (Bits, label, Inputs, etc.). */
  readonly props?: Record<string, PropertyValue>;
  /**
   * Optional layout constraints for auto-layout.
   *
   * - `col` pins the component to a specific column (0 = leftmost).
   * - `row` pins the vertical position within its column (0 = topmost).
   * - Either or both can be specified; omitted axes are auto-assigned.
   *
   * Example: `{ col: 0 }` forces input-side placement;
   *          `{ col: 0, row: 0 }` forces top-left corner.
   */
  readonly layout?: { readonly col?: number; readonly row?: number };
}

// ===========================================================================
// Patch operations — editing existing circuits (the write side, edits)
// ===========================================================================

/**
 * A circuit patch: a list of operations applied atomically.
 *
 * Targets use the same `label` / `label:pin` addressing as netlist output.
 * For subcircuit edits, use the `scope` option on `patch()`.
 */
export type CircuitPatch = PatchOp[];

/**
 * Set properties on a component.
 * Target is a component label (or instanceId).
 * Example: `{ op: 'set', target: 'ADD', props: { Bits: 16 } }`
 */
export interface PatchSet {
  readonly op: 'set';
  /** Component label or instanceId. */
  readonly target: string;
  /** Properties to set (merged with existing). */
  readonly props: Record<string, PropertyValue>;
}

/**
 * Add a new component, optionally connecting its pins.
 * The `connect` map keys are pin labels on the new component,
 * values are "existingLabel:pin" addresses.
 * Example: `{ op: 'add', spec: { id: 'U5', type: 'And' }, connect: { A: 'in1:out', B: 'in2:out' } }`
 */
export interface PatchAdd {
  readonly op: 'add';
  /** Component to create. */
  readonly spec: ComponentSpec;
  /** Optional connections: { newPinLabel: "existingComponent:pin" }. */
  readonly connect?: Record<string, string>;
}

/**
 * Remove a component and all its wires.
 * Target is a component label or instanceId.
 */
export interface PatchRemove {
  readonly op: 'remove';
  /** Component label or instanceId. */
  readonly target: string;
}

/**
 * Connect two pins. Addresses are "label:pin".
 * Example: `{ op: 'connect', from: 'gate:out', to: 'output:in' }`
 */
export interface PatchConnect {
  readonly op: 'connect';
  /** Source pin address: "componentLabel:pinLabel". */
  readonly from: string;
  /** Destination pin address: "componentLabel:pinLabel". */
  readonly to: string;
}

/**
 * Disconnect all wires at a pin.
 * Address is "label:pin".
 */
export interface PatchDisconnect {
  readonly op: 'disconnect';
  /** Pin address: "componentLabel:pinLabel". */
  readonly pin: string;
}

/**
 * Replace a component with a different type, preserving connections
 * where pin labels match between old and new types.
 */
export interface PatchReplace {
  readonly op: 'replace';
  /** Component label or instanceId of the component to replace. */
  readonly target: string;
  /** New component type name. */
  readonly newType: string;
  /** Optional properties for the replacement. */
  readonly props?: Record<string, PropertyValue>;
}

export type PatchOp =
  | PatchSet
  | PatchAdd
  | PatchRemove
  | PatchConnect
  | PatchDisconnect
  | PatchReplace;

/**
 * Options for the `patch()` facade method.
 */
export interface PatchOptions {
  /**
   * Hierarchy scope for the edit, e.g. "MCU/sysreg".
   * When set, targets are resolved within the named subcircuit.
   * When absent, targets are resolved at the top level.
   */
  readonly scope?: string;
}

/**
 * Result of a `patch()` operation.
 */
export interface PatchResult {
  /** Post-patch diagnostics from net resolution. */
  readonly diagnostics: Diagnostic[];
  /**
   * Map of spec.id → instanceId for each `add` op.
   * Enables callers to address just-added components by their instanceId
   * in follow-up operations.
   */
  readonly addedIds: Record<string, string>;
}

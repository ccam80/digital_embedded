/**
 * Subcircuit engine flattening.
 *
 * Transforms a Circuit containing subcircuit elements into an equivalent flat
 * Circuit containing only leaf (non-subcircuit) components. The compiler then
 * processes the flat circuit- it has no knowledge of subcircuits.
 *
 * Flattening process per subcircuit instance:
 *   1. Look up the subcircuit's internal Circuit definition.
 *   2. Deep-copy every internal component with scoped instance naming.
 *   3. Find each In/Out interface component in the internal circuit.
 *   4. Redirect wires: replace subcircuit interface pin connections with
 *      connections that go directly to the corresponding internal component pins.
 *   5. Remove the subcircuit element from the parent circuit.
 *   6. Recurse for nested subcircuits.
 *
 * Scoped naming: the element instanceId is rewritten to
 * `{parentScopedName}.{childTypeId}_{childIndex}` so multiple instances of the
 * same subcircuit produce distinct internal names.
 *
 */

import { Circuit, Wire } from "../../core/circuit.js";
import type { CircuitElement } from "../../core/element.js";
import { AbstractCircuitElement } from "../../core/element.js";
import type { ComponentRegistry } from "../../core/registry.js";
import type { Pin } from "../../core/pin.js";
import { PinDirection } from "../../core/pin.js";
import type { RenderContext, Rect } from "../../core/renderer-interface.js";
import type { SerializedElement } from "../../core/element.js";

// ---------------------------------------------------------------------------
// SubcircuitHost interface- the contract flatten.ts needs from a subcircuit element
// ---------------------------------------------------------------------------

/**
 * A CircuitElement that wraps an internal Circuit definition.
 *
 * Any element whose typeId starts with "Subcircuit:" or that implements this
 * interface can be flattened. The internal circuit must contain In/Out
 * components whose labels match the subcircuit's interface pins.
 */
export interface SubcircuitHost extends CircuitElement {
  /**
   * The internal circuit definition for this subcircuit type.
   * Contains In and Out elements that define the interface.
   */
  readonly internalCircuit: Circuit;

  /**
   * The name used to scope internal component names.
   * Typically derived from the typeId or a human-readable subcircuit name.
   */
  readonly subcircuitName: string;
}

/**
 * Returns true when the given element implements SubcircuitHost.
 * Detection uses duck-typing on the `internalCircuit` property.
 */
export function isSubcircuitHost(el: CircuitElement): el is SubcircuitHost {
  return (
    typeof (el as SubcircuitHost).internalCircuit === "object" &&
    (el as SubcircuitHost).internalCircuit !== null &&
    typeof (el as SubcircuitHost).subcircuitName === "string"
  );
}

// ---------------------------------------------------------------------------
// FlattenResult- public return type
// ---------------------------------------------------------------------------

/**
 * The result of flattening a circuit.
 *
 * `circuit` contains only leaf elements (non-subcircuit components).
 * All subcircuits are unconditionally inlined.
 */
export interface FlattenResult {
  /** The flattened circuit (leaf elements only). */
  circuit: Circuit;
}

// ---------------------------------------------------------------------------
// flattenCircuit- public API
// ---------------------------------------------------------------------------

/**
 * Flatten a circuit by unconditionally inlining all subcircuit instances.
 *
 * Every subcircuit is recursively replaced by its internal components.
 * Domain classification is the partitioner's job- the flattener does not
 * care about simulation domains.
 *
 * @param circuit   Source circuit (may contain subcircuit elements).
 * @param registry  Component registry (unused, retained for API compatibility).
 * @returns         FlattenResult containing the flat circuit.
 */
export function flattenCircuit(
  circuit: Circuit,
  _registry: ComponentRegistry,
): FlattenResult {
  const flatCircuit = flattenCircuitScoped(circuit, "", new Set());
  return { circuit: flatCircuit };
}

// ---------------------------------------------------------------------------
// Internal recursive flattener
// ---------------------------------------------------------------------------

/**
 * Recursive implementation. `scopePrefix` is the dotted-path prefix applied to
 * all internal component instanceIds. `seen` tracks circuit identities to
 * detect infinite recursion.
 */
function flattenCircuitScoped(
  circuit: Circuit,
  scopePrefix: string,
  seen: Set<Circuit>,
): Circuit {
  if (seen.has(circuit)) {
    throw new Error(
      `flattenCircuit: circular subcircuit reference detected at scope "${scopePrefix}"`,
    );
  }
  seen.add(circuit);

  const result = new Circuit({ ...circuit.metadata });

  const resultWires: Wire[] = [];

  for (let elemIdx = 0; elemIdx < circuit.elements.length; elemIdx++) {
    const el = circuit.elements[elemIdx]!;

    if (!isSubcircuitHost(el)) {
      const scopedEl = scopeInstanceId(el, scopePrefix);
      result.addElement(scopedEl);
      continue;
    }

    const instanceName = buildInstanceName(el, elemIdx, scopePrefix);

    const inlineResult = inlineSubcircuit(
      el,
      instanceName,
      circuit,
      seen,
    );

    for (const inlinedEl of inlineResult.elements) {
      result.addElement(inlinedEl);
    }
    for (const bridgeWire of inlineResult.bridgeWires) {
      resultWires.push(bridgeWire);
    }
  }

  seen.delete(circuit);

  for (const wire of circuit.wires) {
    resultWires.push(new Wire({ ...wire.start }, { ...wire.end }));
  }

  for (const wire of resultWires) {
    result.addWire(wire);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Subcircuit inlining
// ---------------------------------------------------------------------------

interface InlineResult {
  elements: CircuitElement[];
  bridgeWires: Wire[];
}

/**
 * Inline one subcircuit instance into the parent.
 *
 * Steps:
 *   1. Recursively flatten the internal circuit (handles nested subcircuits).
 *   2. Deep-copy all internal non-interface elements with scoped names.
 *   3. Build bridge wires connecting parent nets to internal component pins.
 *
 * Interface wiring:
 *   - Subcircuit's In components connect the parent's input net to internal nets.
 *   - Subcircuit's Out components connect internal nets to the parent's output net.
 *
 * The bridge wire approach: for each In/Out interface component in the
 * internal circuit, find the parent wire endpoint that connects to the
 * subcircuit element's pin at that position, then draw a wire directly to
 * the corresponding pin of the internal In/Out component (with scoped name).
 */
function inlineSubcircuit(
  subcircuitEl: SubcircuitHost,
  instanceName: string,
  _parentCircuit: Circuit,
  seen: Set<Circuit>,
): InlineResult {
  const internalCircuit = subcircuitEl.internalCircuit;

  const flatInternal = flattenCircuitScoped(
    internalCircuit,
    instanceName,
    new Set(seen),
  );

  const elements: CircuitElement[] = [];
  const bridgeWires: Wire[] = [];

  // All elements from the flattened internal circuit go into the parent.
  // In/Out/Port interface elements are included- they are leaf components.
  for (const internalEl of flatInternal.elements) {
    elements.push(internalEl);
  }

  // Internal wires (within the subcircuit) are included verbatim.
  for (const internalWire of flatInternal.wires) {
    bridgeWires.push(internalWire);
  }

  // Build bridge wires connecting parent nets to internal interface pins.
  // For each pin on the subcircuit element in the parent, find the parent
  // net's wire endpoint at that pin position, then connect it to the
  // internal In/Out component's pin.
  const subcircuitPins = subcircuitEl.getPins();

  for (const subcircuitPin of subcircuitPins) {
    const pinPos = subcircuitPin.position;

    // Find the corresponding internal interface element (In for INPUT pins,
    // Out for OUTPUT pins) by matching the pin label to the interface element's label.
    const interfaceEl = findInterfaceElement(
      flatInternal,
      subcircuitPin.label,
      subcircuitPin.direction,
    );

    if (interfaceEl === undefined) continue;

    // Find the pin on the internal element that connects to the parent net.
    const interfacePins = interfaceEl.getPins();
    if (interfacePins.length === 0) continue;

    // The signal pin of an In element is its single output (east face).
    // The signal pin of an Out element is its single input (west face).
    // In both cases it is pins[0].
    const interfacePin = interfacePins[0]!;

    // Create a bridge wire from the subcircuit's pin WORLD position in the parent
    // to the internal interface element's pin WORLD position.
    // pinWorldPosition(el, pin) = el.position + pin.position- this matches
    // how the connectivity extractor resolves net membership for both endpoints.
    bridgeWires.push(new Wire(
      {
        x: subcircuitEl.position.x + pinPos.x,
        y: subcircuitEl.position.y + pinPos.y,
      },
      {
        x: interfaceEl.position.x + interfacePin.position.x,
        y: interfaceEl.position.y + interfacePin.position.y,
      },
    ));
  }

  return { elements, bridgeWires };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the internal interface element whose label matches the given interface
 * pin label and whose direction corresponds to the pin direction.
 *
 * Port is the standard subcircuit interface element. In/Out matching is
 * retained for loading pre-existing .dig files that predate Port.
 */
function findInterfaceElement(
  flatCircuit: Circuit,
  label: string,
  direction: PinDirection,
): CircuitElement | undefined {
  // Port- the standard subcircuit interface element
  for (const el of flatCircuit.elements) {
    if (el.typeId === "Port") {
      const elLabel = el.getAttribute("label");
      if (typeof elLabel === "string" && elLabel === label) return el;
    }
  }

  // BIDIRECTIONAL pins only match Port.
  if (direction === PinDirection.BIDIRECTIONAL) return undefined;

  // In/Out- for pre-existing .dig files that predate Port
  const targetTypeId = direction === PinDirection.INPUT ? "In" : "Out";
  for (const el of flatCircuit.elements) {
    if (el.typeId !== targetTypeId) continue;
    const elLabel = el.getAttribute("label");
    if (typeof elLabel === "string" && elLabel === label) {
      return el;
    }
  }
  return undefined;
}

/**
 * Build a scoped instance name for a subcircuit element at the given index.
 *
 * Format: `{scopePrefix}{subcircuitName}_{elemIdx}`
 * Example: "FullAdder_0" or "TopLevel.FullAdder_0.HalfAdder_2"
 */
function buildInstanceName(
  el: SubcircuitHost,
  elemIdx: number,
  scopePrefix: string,
): string {
  const base = `${el.subcircuitName}_${elemIdx}`;
  return scopePrefix.length > 0 ? `${scopePrefix}.${base}` : base;
}

/**
 * Return a copy of the element with a scoped instanceId.
 *
 * The instanceId is rewritten to `{scopePrefix}.{originalInstanceId}` so
 * that multiple subcircuit instances have distinct internal net names.
 *
 * When scopePrefix is empty (top-level), the element is returned as-is.
 */
function scopeInstanceId(el: CircuitElement, scopePrefix: string): CircuitElement {
  if (scopePrefix.length === 0) return el;
  return new ScopedElement(el, `${scopePrefix}.${el.instanceId}`);
}

// ---------------------------------------------------------------------------
// ScopedElement- thin wrapper that overrides instanceId
// ---------------------------------------------------------------------------

/**
 * Wraps a CircuitElement and overrides its instanceId with a scoped version.
 *
 * All other methods delegate directly to the wrapped element. This avoids
 * mutating the original elements during flattening.
 */
class ScopedElement extends AbstractCircuitElement {
  private readonly _wrapped: CircuitElement;

  constructor(wrapped: CircuitElement, scopedInstanceId: string) {
    super(
      wrapped.typeId,
      scopedInstanceId,
      wrapped.position,
      wrapped.rotation,
      wrapped.mirror,
      wrapped.getProperties(),
    );
    this._wrapped = wrapped;
  }

  getPins(): readonly Pin[] {
    return this._wrapped.getPins();
  }

  draw(ctx: RenderContext): void {
    this._wrapped.draw(ctx);
  }

  getBoundingBox(): Rect {
    return this._wrapped.getBoundingBox();
  }

  serialize(): SerializedElement {
    const base = this._wrapped.serialize();
    return { ...base, instanceId: this.instanceId };
  }
}

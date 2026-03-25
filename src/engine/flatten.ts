/**
 * Subcircuit engine flattening.
 *
 * Transforms a Circuit containing subcircuit elements into an equivalent flat
 * Circuit containing only leaf (non-subcircuit) components. The compiler then
 * processes the flat circuit — it has no knowledge of subcircuits.
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

import { Circuit, Wire } from "../core/circuit.js";
import type { CircuitElement } from "../core/element.js";
import { AbstractCircuitElement } from "../core/element.js";
import type { ComponentRegistry } from "../core/registry.js";
import { hasDigitalModel, hasAnalogModel } from "../core/registry.js";
import type { Pin } from "../core/pin.js";
import { PinDirection } from "../core/pin.js";
import type { RenderContext, Rect } from "../core/renderer-interface.js";
import type { SerializedElement } from "../core/element.js";
import type { CrossEngineBoundary, BoundaryPinMapping } from "./cross-engine-boundary.js";

// ---------------------------------------------------------------------------
// SubcircuitHost interface — the contract flatten.ts needs from a subcircuit element
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
// FlattenResult — public return type
// ---------------------------------------------------------------------------

/**
 * The result of flattening a circuit.
 *
 * `circuit` contains only leaf elements (non-subcircuit components), except
 * for cross-engine subcircuit placeholders which are left in place.
 *
 * `crossEngineBoundaries` lists every subcircuit instance whose internal
 * engine type differs from the outer circuit's engine type. The analog
 * compiler uses these to insert bridge adapter elements.
 */
/**
 * Describes one cut point between the analog and digital domains.
 */
export interface InternalCutPoint {
  label: string;
  direction: "in" | "out";
  innerLabel: string;
  bitWidth: number;
  position: { x: number; y: number };
}

/**
 * A partition of digital-only elements extracted from a mixed circuit.
 */
export interface InternalDigitalPartition {
  internalCircuit: Circuit;
  cutPoints: InternalCutPoint[];
  instanceName: string;
}

export interface FlattenResult {
  /** The flattened circuit (leaf elements only, except cross-engine placeholders). */
  circuit: Circuit;
  /** Boundaries that the compiler must handle via bridge adapters. */
  crossEngineBoundaries: CrossEngineBoundary[];
  /**
   * Mixed-mode partitions for circuits containing both analog-only and
   * digital-only components. The analog compiler creates bridge instances for each.
   */
  mixedModePartitions?: InternalDigitalPartition[];
}

// ---------------------------------------------------------------------------
// flattenCircuit — public API
// ---------------------------------------------------------------------------

/**
 * Return a FlattenResult with the circuit flattened (all same-engine
 * subcircuit instances replaced by their internal components) and a list of
 * cross-engine boundaries that were NOT flattened.
 *
 * Cross-engine subcircuits (where the internal engineType differs from the
 * outer circuit's engineType, or where the subcircuit instance has
 * simulationMode='digital' in an analog-engine outer circuit) are preserved
 * as opaque placeholder elements in the flat result. The compiler must handle
 * them separately via bridge adapters.
 *
 * Same-engine subcircuits are recursively inlined as before. Digital-only
 * callers can ignore `crossEngineBoundaries`.
 *
 * @param circuit   Source circuit (may contain subcircuit elements).
 * @param registry  Component registry (used only for leaf component validation).
 * @returns         FlattenResult containing the flat circuit and any cross-engine boundaries.
 */
export function flattenCircuit(circuit: Circuit, registry: ComponentRegistry): FlattenResult {
  const boundaries: CrossEngineBoundary[] = [];
  const flatCircuit = flattenCircuitScoped(circuit, "", registry, new Set(), boundaries);
  return { circuit: flatCircuit, crossEngineBoundaries: boundaries };
}

// ---------------------------------------------------------------------------
// Domain resolution helper
// ---------------------------------------------------------------------------

/**
 * Determine the active simulation domain of a circuit.
 *
 * When the circuit's engineType metadata is "digital" or "analog", that value
 * is returned directly. When it is "auto", the domain is inferred from the
 * models available on the circuit's non-subcircuit leaf components: if any
 * component has only analog models, the circuit is "analog"; if all have
 * digital models, the circuit is "digital". Returns "auto" when no leaf
 * components are registered or the domain is indeterminate.
 */
function resolveCircuitDomain(
  circuit: Circuit,
  registry: ComponentRegistry,
): "digital" | "analog" | "auto" {
  const explicitType = circuit.metadata.engineType;
  if (explicitType === "digital" || explicitType === "analog") {
    return explicitType;
  }

  let hasDigital = false;
  let hasAnalog = false;

  for (const el of circuit.elements) {
    if (isSubcircuitHost(el)) continue;
    const def = registry.get(el.typeId);
    if (def === undefined) continue;
    if (hasDigitalModel(def)) hasDigital = true;
    if (hasAnalogModel(def)) hasAnalog = true;
  }

  if (hasAnalog && !hasDigital) return "analog";
  if (hasDigital && !hasAnalog) return "digital";
  return "auto";
}

// ---------------------------------------------------------------------------
// Internal recursive flattener
// ---------------------------------------------------------------------------

/**
 * Recursive implementation. `scopePrefix` is the dotted-path prefix applied to
 * all internal component instanceIds. `seen` tracks circuit identities to
 * detect infinite recursion. `boundaries` accumulates cross-engine boundary
 * records as they are discovered.
 */
function flattenCircuitScoped(
  circuit: Circuit,
  scopePrefix: string,
  registry: ComponentRegistry,
  seen: Set<Circuit>,
  boundaries: CrossEngineBoundary[],
): Circuit {
  if (seen.has(circuit)) {
    throw new Error(
      `flattenCircuit: circular subcircuit reference detected at scope "${scopePrefix}"`,
    );
  }
  seen.add(circuit);

  const result = new Circuit({ ...circuit.metadata });

  // Track which wires belong to the flat result. We start with all non-
  // subcircuit wires, then add bridge wires for subcircuit interface pins.
  const resultWires: Wire[] = [];

  const outerDomain = resolveCircuitDomain(circuit, registry);

  // For each element, either pass it through (leaf) or inline it (subcircuit).
  for (let elemIdx = 0; elemIdx < circuit.elements.length; elemIdx++) {
    const el = circuit.elements[elemIdx]!;

    if (!isSubcircuitHost(el)) {
      // Leaf element — pass through with scoped instanceId
      const scopedEl = scopeInstanceId(el, scopePrefix);
      result.addElement(scopedEl);
      continue;
    }

    const instanceName = buildInstanceName(el, elemIdx, scopePrefix);

    // Detect cross-engine boundary using model-based domain checks:
    //   (a) the subcircuit instance has simulationMode='digital' in an analog
    //       outer context, OR
    //   (b) the internal circuit's components resolve to a different domain
    //       than the outer circuit (using activeModel/hasDigitalModel/hasAnalogModel).
    const instanceSimMode = el.getAttribute("simulationMode");
    const internalDomain = resolveCircuitDomain(el.internalCircuit, registry);
    const isCrossEngine =
      (outerDomain === "analog" && instanceSimMode === "digital") ||
      (outerDomain !== internalDomain && internalDomain !== "auto" && outerDomain !== "auto");

    if (isCrossEngine) {
      // Record the boundary and leave the element as a placeholder.
      const pinMappings = buildPinMappings(el);
      boundaries.push({
        subcircuitElement: el,
        internalCircuit: el.internalCircuit,
        internalEngineType: el.internalCircuit.metadata.engineType,
        outerEngineType: circuit.metadata.engineType,
        pinMappings,
        instanceName,
      });
      // Keep the subcircuit element in the flat result as an opaque placeholder
      // so the compiler can locate it by its identity when processing bridges.
      result.addElement(el);
      continue;
    }

    // Same-engine subcircuit — inline its contents.
    const inlineResult = inlineSubcircuit(
      el,
      instanceName,
      circuit,
      registry,
      seen,
      boundaries,
    );

    for (const inlinedEl of inlineResult.elements) {
      result.addElement(inlinedEl);
    }
    for (const bridgeWire of inlineResult.bridgeWires) {
      resultWires.push(bridgeWire);
    }
  }

  seen.delete(circuit);

  // Add all non-subcircuit-internal wires from the parent
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
  registry: ComponentRegistry,
  seen: Set<Circuit>,
  boundaries: CrossEngineBoundary[],
): InlineResult {
  const internalCircuit = subcircuitEl.internalCircuit;

  // Recursively flatten the internal circuit
  const flatInternal = flattenCircuitScoped(
    internalCircuit,
    instanceName,
    registry,
    new Set(seen),
    boundaries,
  );

  const elements: CircuitElement[] = [];
  const bridgeWires: Wire[] = [];

  // All elements from the flattened internal circuit go into the parent.
  // In/Out interface elements are included — they are leaf components.
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

    // Create a bridge wire from the subcircuit's pin position in the parent
    // to the internal element's signal pin position.
    bridgeWires.push(new Wire(
      { x: pinPos.x, y: pinPos.y },
      { x: interfacePin.position.x, y: interfacePin.position.y },
    ));
  }

  return { elements, bridgeWires };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build the BoundaryPinMapping list for a cross-engine subcircuit instance.
 *
 * Each pin on the subcircuit element in the outer circuit becomes one
 * BoundaryPinMapping. The direction is from the subcircuit's perspective:
 *   - INPUT pin on the outer element  → 'in'  (data flows into the subcircuit)
 *   - OUTPUT pin on the outer element → 'out' (data flows out of the subcircuit)
 */
function buildPinMappings(el: SubcircuitHost): BoundaryPinMapping[] {
  const mappings: BoundaryPinMapping[] = [];
  for (const pin of el.getPins()) {
    mappings.push({
      pinLabel: pin.label,
      direction: pin.direction === PinDirection.INPUT ? "in" : "out",
      innerLabel: pin.label,
      bitWidth: pin.bitWidth,
    });
  }
  return mappings;
}

/**
 * Find the internal In or Out element whose label matches the given interface
 * pin label and whose direction corresponds to the pin direction.
 *
 * INPUT pin on the subcircuit interface → In element inside the subcircuit.
 * OUTPUT pin on the subcircuit interface → Out element inside the subcircuit.
 */
function findInterfaceElement(
  flatCircuit: Circuit,
  label: string,
  direction: PinDirection,
): CircuitElement | undefined {
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
// ScopedElement — thin wrapper that overrides instanceId
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

  getHelpText(): string {
    return this._wrapped.getHelpText();
  }

  serialize(): SerializedElement {
    const base = this._wrapped.serialize();
    return { ...base, instanceId: this.instanceId };
  }
}

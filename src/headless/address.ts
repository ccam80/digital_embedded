/**
 * Address resolution utilities for the headless API.
 *
 * Resolves "label:pin" style addresses to CircuitElement + Pin references
 * within a Circuit. The addressing scheme is identical to what the netlist
 * read side emits, so agents can copy addresses directly from netlist output
 * into patch operations.
 */

import type { Circuit } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import type { Pin } from '../core/pin.js';
import type { ComponentRegistry } from '../core/registry.js';
import { SubcircuitElement } from '../components/subcircuit/subcircuit.js';
import { FacadeError } from './types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ResolvedComponent {
  element: CircuitElement;
  index: number;
}

export interface ResolvedPin {
  element: CircuitElement;
  elementIndex: number;
  pin: Pin;
}

// ---------------------------------------------------------------------------
// parseAddress
// ---------------------------------------------------------------------------

/**
 * Parse a "component:pin" address into its parts.
 * "gate:A" → { component: "gate", pin: "A" }
 * "gate"   → { component: "gate", pin: undefined }
 */
function parseAddress(address: string): { component: string; pin: string | undefined } {
  const colonIdx = address.indexOf(':');
  if (colonIdx === -1) {
    return { component: address, pin: undefined };
  }
  return {
    component: address.slice(0, colonIdx),
    pin: address.slice(colonIdx + 1),
  };
}

// ---------------------------------------------------------------------------
// resolveComponent
// ---------------------------------------------------------------------------

/**
 * Get the effective label for a component: checks "label" first, then
 * "NetName" for Tunnel components (which store their label as NetName
 * in .dig XML).
 */
export function getComponentLabel(el: CircuitElement): string | undefined {
  const labelAttr = el.getAttribute('label');
  if (typeof labelAttr === 'string' && labelAttr.length > 0) return labelAttr;
  if (el.typeId === 'Tunnel') {
    const netName = el.getAttribute('NetName');
    if (typeof netName === 'string' && netName.length > 0) return netName;
  }
  return undefined;
}

/**
 * Find a component by label or instanceId in a circuit.
 *
 * Resolution order:
 * 1. Exact instanceId match (always unambiguous — takes priority)
 * 2. User label (getAttribute("label"), or NetName for Tunnels)
 *
 * When multiple components share a label (e.g. many Tunnels named "C"),
 * the first match wins. Use instanceId for disambiguation.
 *
 * Throws FacadeError with available labels if not found.
 */
export function resolveComponent(circuit: Circuit, label: string): ResolvedComponent {
  // First pass: search by instanceId (always unique, enables disambiguation)
  for (let i = 0; i < circuit.elements.length; i++) {
    const el = circuit.elements[i];
    if (el.instanceId === label) {
      return { element: el, index: i };
    }
  }

  // Second pass: search by user label (including NetName for Tunnels)
  for (let i = 0; i < circuit.elements.length; i++) {
    const el = circuit.elements[i];
    const effectiveLabel = getComponentLabel(el);
    if (effectiveLabel === label) {
      return { element: el, index: i };
    }
  }

  // Build helpful error message listing available labels
  const available = circuit.elements.map((el) => {
    return getComponentLabel(el) ?? el.instanceId;
  });

  throw new FacadeError(
    `Component '${label}' not found. Available labels: ${available.join(', ')}`,
    label,
    undefined,
    undefined,
    { availableLabels: available },
  );
}

// ---------------------------------------------------------------------------
// resolvePin
// ---------------------------------------------------------------------------

/**
 * Find a component + pin by "label:pin" address.
 * Throws FacadeError if component or pin not found.
 */
export function resolvePin(circuit: Circuit, address: string): ResolvedPin {
  const { component: componentLabel, pin: pinLabel } = parseAddress(address);

  if (pinLabel === undefined) {
    throw new FacadeError(
      `Address '${address}' is missing a pin label. Expected format: "componentLabel:pinLabel"`,
    );
  }

  const { element, index } = resolveComponent(circuit, componentLabel);

  const pin = element.getPins().find((p: Pin) => p.label === pinLabel);
  if (!pin) {
    const validPins = Array.from(element.getPins())
      .map((p: Pin) => p.label)
      .join(', ');
    throw new FacadeError(
      `Pin '${pinLabel}' not found on component '${componentLabel}' (type: ${element.typeId}). Valid pins: ${validPins}`,
      componentLabel,
      pinLabel,
      undefined,
      { validPins: validPins.split(', ') },
    );
  }

  return { element, elementIndex: index, pin };
}

// ---------------------------------------------------------------------------
// resolveScope
// ---------------------------------------------------------------------------

/**
 * Walk a "/" separated hierarchy path and return the inner Circuit of the
 * named subcircuit.
 *
 * Example: resolveScope(topCircuit, registry, "MCU/sysreg") walks:
 *   1. Find element labelled "MCU" in topCircuit — must be a SubcircuitElement
 *   2. Get its inner Circuit
 *   3. Find element labelled "sysreg" in that inner Circuit — must be a SubcircuitElement
 *   4. Return its inner Circuit
 *
 * Throws FacadeError if any segment is not found or is not a subcircuit.
 *
 * @param circuit   The top-level (or current) circuit to start walking from.
 * @param _registry Unused — reserved for future registry-based lookup.
 * @param scope     Slash-separated path, e.g. "MCU/sysreg" or just "sysreg".
 * @returns         The inner Circuit of the leaf subcircuit named by scope.
 */
export function resolveScope(
  circuit: Circuit,
  _registry: ComponentRegistry,
  scope: string,
): Circuit {
  const segments = scope.split('/').filter((s) => s.length > 0);

  if (segments.length === 0) {
    throw new FacadeError(
      `Scope "${scope}" is empty or invalid. Expected a non-empty slash-separated path.`,
    );
  }

  let current = circuit;

  for (const segment of segments) {
    const { element } = resolveComponent(current, segment);

    if (!(element instanceof SubcircuitElement)) {
      throw new FacadeError(
        `Scope segment "${segment}" resolves to a component of type "${element.typeId}" which is not a subcircuit. ` +
          `Only SubcircuitElement instances can be traversed in a scope path.`,
        segment,
      );
    }

    current = element.definition.circuit;
  }

  return current;
}

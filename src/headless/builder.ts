/**
 * Circuit builder: programmatic circuit construction API
 */

import { Circuit, Wire } from '../core/circuit.js';
import type { ComponentRegistry } from '../core/registry.js';
import type { PropertyValue } from '../core/properties.js';
import { PropertyBag } from '../core/properties.js';
import type { Pin } from '../core/pin.js';
import type { CircuitElement } from '../core/element.js';
import { FacadeError } from './types.js';
import type { CircuitBuildOptions } from './types.js';
import { loadDig as loadDigFromXml } from '../io/dig-loader.js';

const AUTO_POSITION_Y_STEP = 4;

/**
 * String similarity for suggesting corrections (Levenshtein-like heuristic)
 */
function levenshteinDistance(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();

  if (aLower === bLower) return 0;

  const matrix: number[][] = Array(bLower.length + 1)
    .fill(0)
    .map(() => Array(aLower.length + 1).fill(0));

  for (let i = 0; i <= aLower.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= bLower.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= bLower.length; j++) {
    for (let i = 1; i <= aLower.length; i++) {
      const cost = aLower[i - 1] === bLower[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }

  return matrix[bLower.length][aLower.length];
}

/**
 * Find the closest matching string
 */
function findClosestMatch(
  query: string,
  candidates: string[]
): string | undefined {
  if (candidates.length === 0) return undefined;

  let best = candidates[0];
  let bestDistance = levenshteinDistance(query, best);

  for (const candidate of candidates) {
    const distance = levenshteinDistance(query, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }

  return bestDistance <= 2 ? best : undefined;
}

/**
 * CircuitBuilder: Builds circuits programmatically
 */
export class CircuitBuilder {
  private elementPositionCounter = 0;

  constructor(private registry: ComponentRegistry) {}

  /**
   * Load a .dig XML string and produce a populated Circuit.
   *
   * Accepts a raw .dig XML string (starts with "<") and delegates to the
   * dig-loader pipeline: parseDigXml → loadDigCircuit → Circuit.
   *
   * @param xml - Raw .dig XML content
   * @returns Populated Circuit with all elements and wires
   * @throws DigParserError if any elementName is not registered in this builder's registry
   * @throws Error if the XML is malformed
   */
  loadDig(xml: string): Circuit {
    return loadDigFromXml(xml, this.registry);
  }

  /**
   * Create a new empty circuit
   */
  createCircuit(opts?: CircuitBuildOptions): Circuit {
    this.elementPositionCounter = 0;
    return new Circuit({
      name: opts?.name,
      description: opts?.description,
    });
  }

  /**
   * Add a component to the circuit by type name
   * Auto-positions sequentially unless caller specifies position in props
   */
  addComponent(
    circuit: Circuit,
    typeName: string,
    props?: Record<string, PropertyValue>
  ): CircuitElement {
    const definition = this.registry.get(typeName);
    if (!definition) {
      const allNames = this.registry.getAll().map((d) => d.name);
      const suggestion = findClosestMatch(typeName, allNames);
      throw new FacadeError(
        suggestion
          ? `Unknown component type '${typeName}'. Did you mean '${suggestion}'?`
          : `Unknown component type '${typeName}'.`,
        typeName
      );
    }

    // Build property bag from defaults and caller props
    const bag = new PropertyBag();
    for (const [key, value] of Object.entries(props || {})) {
      bag.set(key, value);
    }

    // Auto-position unless caller specified position
    if (!bag.has('position')) {
      bag.set('position', {
        x: 0,
        y: this.elementPositionCounter * AUTO_POSITION_Y_STEP,
      });
    }

    const element = definition.factory(bag);
    circuit.elements.push(element);
    this.elementPositionCounter++;

    return element;
  }

  /**
   * Connect two components by pin label
   */
  connect(
    circuit: Circuit,
    src: CircuitElement,
    srcPinLabel: string,
    dst: CircuitElement,
    dstPinLabel: string
  ): Wire {
    const srcPin = this.findPin(src, srcPinLabel);
    if (!srcPin) {
      const validLabels = Array.from(src.getPins())
        .map((p) => p.label)
        .join(', ');
      throw new FacadeError(
        `Pin '${srcPinLabel}' not found on component '${src.typeId}'. Valid pins: ${validLabels}`,
        src.typeId,
        srcPinLabel
      );
    }

    const dstPin = this.findPin(dst, dstPinLabel);
    if (!dstPin) {
      const validLabels = Array.from(dst.getPins())
        .map((p) => p.label)
        .join(', ');
      throw new FacadeError(
        `Pin '${dstPinLabel}' not found on component '${dst.typeId}'. Valid pins: ${validLabels}`,
        dst.typeId,
        dstPinLabel
      );
    }

    // Validate pin directions
    this.validatePinConnection(srcPin, dstPin);

    // Validate bit width match
    if (srcPin.bitWidth !== dstPin.bitWidth) {
      throw new FacadeError(
        `Bit width mismatch: '${srcPinLabel}' is ${srcPin.bitWidth}-bit, '${dstPinLabel}' is ${dstPin.bitWidth}-bit`,
        src.typeId,
        srcPinLabel,
        undefined,
        { srcWidth: srcPin.bitWidth, dstWidth: dstPin.bitWidth }
      );
    }

    // Create wire from pin world positions
    const srcWorldPos = this.getPinWorldPosition(src, srcPin);
    const dstWorldPos = this.getPinWorldPosition(dst, dstPin);

    const wire = new Wire(srcWorldPos, dstWorldPos);

    // Check for duplicate connections
    const isDuplicate = circuit.wires.some(
      (w) =>
        (w.start.x === wire.start.x &&
          w.start.y === wire.start.y &&
          w.end.x === wire.end.x &&
          w.end.y === wire.end.y) ||
        (w.start.x === wire.end.x &&
          w.start.y === wire.end.y &&
          w.end.x === wire.start.x &&
          w.end.y === wire.start.y)
    );

    if (isDuplicate) {
      throw new FacadeError('Duplicate wire connection not allowed');
    }

    circuit.wires.push(wire);
    return wire;
  }

  /**
   * Find a pin by label on a component
   */
  private findPin(element: CircuitElement, label: string): Pin | undefined {
    return element.getPins().find((p: Pin) => p.label === label);
  }

  /**
   * Validate that pin directions are compatible for connection
   */
  private validatePinConnection(srcPin: Pin, dstPin: Pin): void {
    const srcOut = srcPin.direction === 'OUTPUT' || srcPin.direction === 'BIDIRECTIONAL';
    const dstIn = dstPin.direction === 'INPUT' || dstPin.direction === 'BIDIRECTIONAL';

    if (!srcOut || !dstIn) {
      throw new FacadeError(
        `Cannot connect ${srcPin.direction} pin to ${dstPin.direction} pin`
      );
    }
  }

  /**
   * Calculate world position of a pin given its component and relative position
   */
  private getPinWorldPosition(
    element: CircuitElement,
    pin: Pin
  ): { x: number; y: number } {
    return {
      x: element.position.x + pin.position.x,
      y: element.position.y + pin.position.y,
    };
  }

}

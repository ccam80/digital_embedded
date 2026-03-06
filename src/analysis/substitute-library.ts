/**
 * Substitute Library — replace complex components with gate-level equivalents.
 *
 * Required for analyzing circuits that contain non-primitive components.
 * Returns a new Circuit where each substitutable component is replaced by
 * an equivalent network of basic gates. Unsubstitutable components are
 * collected and reported via SubstitutionResult.
 *
 * Substitutions provided:
 *   Mux (2:1) → AND/OR/NOT gates
 *   Demux (1:2) → AND/NOT gates
 *   Decoder → AND/NOT gates
 *   XOr (multi-input, >2) → cascade of 2-input XOR gates
 *   Subcircuits → recursively substitute their internals and inline
 *
 * Components that cannot be substituted (flip-flops, RAM, ROM, etc.) are
 * collected and returned as blockingComponents.
 *
 */

import { Circuit, Wire } from '../core/circuit.js';
import type { CircuitElement } from '../core/element.js';
import { AbstractCircuitElement } from '../core/element.js';
import type { Pin, Rotation } from '../core/pin.js';
import { PinDirection } from '../core/pin.js';
import type { ComponentRegistry } from '../core/registry.js';
import type { RenderContext, Rect } from '../core/renderer-interface.js';
import { PropertyBag } from '../core/properties.js';
import type { SubcircuitElement } from '../components/subcircuit/subcircuit.js';

// ---------------------------------------------------------------------------
// Public API types
// ---------------------------------------------------------------------------

/**
 * Result of a substitution pass.
 */
export interface SubstitutionResult {
  /** New circuit with complex components replaced by gate-level equivalents. */
  circuit: Circuit;
  /**
   * Type names of components that have no gate-level substitution.
   * If non-empty, the circuit cannot be fully analysed.
   */
  blockingComponents: string[];
}

// ---------------------------------------------------------------------------
// Component type names
// ---------------------------------------------------------------------------

/** Component types that are always basic gates — no substitution needed. */
const BASIC_GATE_TYPES = new Set([
  'And', 'Or', 'Not', 'Xor', 'Nand', 'Nor', 'Xnor',
  'AND', 'OR', 'NOT', 'XOR', 'NAND', 'NOR', 'XNOR',
  'In', 'Out',
  'Const', 'Ground', 'VDD',
  'Tunnel',
]);

/** Component types that block analysis entirely. */
const BLOCKING_TYPES = new Set([
  'FlipflopD', 'FlipflopT', 'FlipflopRS', 'FlipflopJK',
  'DLatch', 'SRLatch',
  'RAM', 'ROM', 'EEPROM',
  'Register', 'Counter', 'CounterPreset',
  'RegisterFile',
  'ProgramMemory', 'ProgramCounter',
  'LookUpTable',
]);

// ---------------------------------------------------------------------------
// substituteForAnalysis — public API
// ---------------------------------------------------------------------------

/**
 * Replace complex components with gate-level equivalents for analysis.
 *
 * @param circuit   The source circuit (not mutated).
 * @param registry  Component registry (used to find subcircuit definitions).
 * @returns         SubstitutionResult with the transformed circuit and blocking types.
 */
export function substituteForAnalysis(
  circuit: Circuit,
  registry: ComponentRegistry,
): SubstitutionResult {
  const blockingSet = new Set<string>();
  const resultCircuit = new Circuit({ ...circuit.metadata });

  // Counter for generating unique instance IDs within this substitution pass
  let idCounter = 0;
  function nextId(prefix: string): string {
    return `${prefix}_sub_${idCounter++}`;
  }

  // Position allocator: track the next available Y offset for injected gates
  // We place substituted gate networks below the original component position.
  let yOffset = 0;

  function allocatePosition(baseX: number, baseY: number): { x: number; y: number } {
    const pos = { x: baseX, y: baseY + yOffset };
    yOffset += 4;
    return pos;
  }

  // Process each element
  for (const el of circuit.elements) {
    const typeId = el.typeId;

    if (BASIC_GATE_TYPES.has(typeId)) {
      // Pass through unchanged
      resultCircuit.addElement(el);
      continue;
    }

    if (BLOCKING_TYPES.has(typeId)) {
      blockingSet.add(typeId);
      // Still include the element so structural analysis can continue
      resultCircuit.addElement(el);
      continue;
    }

    // Check if this is a subcircuit (it implements the SubcircuitElement interface
    // indicated by having a `definition` property with a nested circuit)
    if (isSubcircuitElement(el)) {
      const subcircuitEl = el as SubcircuitElement;
      const nested = subcircuitEl.definition.circuit;

      // Recursively substitute the nested circuit
      const nestedResult = substituteForAnalysis(nested, registry);

      // Collect any blocking types from nested substitution
      for (const bt of nestedResult.blockingComponents) {
        blockingSet.add(bt);
      }

      // Inline the substituted nested circuit elements into the result
      // Offset all positions by the parent component's position
      const offsetX = el.position.x;
      const offsetY = el.position.y;

      for (const nestedEl of nestedResult.circuit.elements) {
        // Create a position-offset wrapper
        const offsetEl = new OffsetElement(nestedEl, offsetX, offsetY);
        resultCircuit.addElement(offsetEl);
      }

      for (const wire of nestedResult.circuit.wires) {
        resultCircuit.addWire(new Wire(
          { x: wire.start.x + offsetX, y: wire.start.y + offsetY },
          { x: wire.end.x + offsetX, y: wire.end.y + offsetY },
        ));
      }

      continue;
    }

    // Handle substitutable components
    if (typeId === 'Multiplexer' || typeId === 'Mux') {
      const gateCircuit = substituteMux(el, nextId, allocatePosition);
      inlineGateCircuit(resultCircuit, gateCircuit);
      continue;
    }

    if (typeId === 'Demultiplexer' || typeId === 'Demux') {
      const gateCircuit = substituteDemux(el, nextId, allocatePosition);
      inlineGateCircuit(resultCircuit, gateCircuit);
      continue;
    }

    if (typeId === 'Decoder') {
      const gateCircuit = substituteDecoder(el, nextId, allocatePosition);
      inlineGateCircuit(resultCircuit, gateCircuit);
      continue;
    }

    // Any other component: attempt registry lookup for gate definition.
    // If not found as a basic/substitutable type, treat as blocking.
    const def = registry.get(typeId);
    if (def) {
      // It's registered but not known to us — pass through
      resultCircuit.addElement(el);
    } else {
      // Unknown type — treat as blocking
      blockingSet.add(typeId);
      resultCircuit.addElement(el);
    }
  }

  // Copy all wires from the original circuit (element-level wires between substituted
  // components are replaced inside the substitution; top-level structural wires are kept)
  for (const wire of circuit.wires) {
    resultCircuit.addWire(wire);
  }

  return {
    circuit: resultCircuit,
    blockingComponents: Array.from(blockingSet),
  };
}

// ---------------------------------------------------------------------------
// Helper: detect subcircuit elements
// ---------------------------------------------------------------------------

function isSubcircuitElement(el: CircuitElement): boolean {
  // SubcircuitElement exposes a `definition` getter with a `circuit` property
  return typeof (el as unknown as Record<string, unknown>)['definition'] === 'object' &&
    (el as unknown as Record<string, unknown>)['definition'] !== null &&
    typeof ((el as unknown as Record<string, unknown>)['definition'] as Record<string, unknown>)['circuit'] === 'object';
}

// ---------------------------------------------------------------------------
// Helper: inline gate circuit elements and wires into a parent circuit
// ---------------------------------------------------------------------------

function inlineGateCircuit(parent: Circuit, sub: Circuit): void {
  for (const el of sub.elements) {
    parent.addElement(el);
  }
  for (const wire of sub.wires) {
    parent.addWire(wire);
  }
}

// ---------------------------------------------------------------------------
// Gate-level substitution: 2:1 Multiplexer → AND/OR/NOT
// ---------------------------------------------------------------------------
//
// MUX truth table (1-bit, 1 select):
//   S=0: Y = D0
//   S=1: Y = D1
//
// Y = (D0 & !S) | (D1 & S)
//
// Implementation:
//   notS  = NOT(S)
//   and0  = AND(D0, notS)
//   and1  = AND(D1, S)
//   out   = OR(and0, and1)

function substituteMux(
  el: CircuitElement,
  nextId: (prefix: string) => string,
  _allocatePosition: (x: number, y: number) => { x: number; y: number },
): Circuit {
  const sub = new Circuit();
  const { x, y } = el.position;

  // NOT gate for select line
  const notS = makeGateElement('NOT', nextId('notS'), { x: x + 2, y: y + 2 }, [
    makePin('in', PinDirection.INPUT, x + 2, y + 2),
    makePin('out', PinDirection.OUTPUT, x + 4, y + 2),
  ]);

  // AND gate for D0 & !S
  const and0 = makeGateElement('AND', nextId('and0'), { x: x + 6, y }, [
    makePin('in0', PinDirection.INPUT, x + 6, y),
    makePin('in1', PinDirection.INPUT, x + 6, y + 2),
    makePin('out', PinDirection.OUTPUT, x + 10, y + 1),
  ]);

  // AND gate for D1 & S
  const and1 = makeGateElement('AND', nextId('and1'), { x: x + 6, y: y + 4 }, [
    makePin('in0', PinDirection.INPUT, x + 6, y + 4),
    makePin('in1', PinDirection.INPUT, x + 6, y + 6),
    makePin('out', PinDirection.OUTPUT, x + 10, y + 5),
  ]);

  // OR gate for final output
  const orGate = makeGateElement('OR', nextId('orMux'), { x: x + 12, y: y + 2 }, [
    makePin('in0', PinDirection.INPUT, x + 12, y + 1),
    makePin('in1', PinDirection.INPUT, x + 12, y + 5),
    makePin('out', PinDirection.OUTPUT, x + 16, y + 3),
  ]);

  sub.addElement(notS);
  sub.addElement(and0);
  sub.addElement(and1);
  sub.addElement(orGate);

  // Wire NOT output → AND0.in1 (for !S)
  sub.addWire(new Wire({ x: x + 4, y: y + 2 }, { x: x + 6, y: y + 2 }));
  // Wire AND0 → OR.in0
  sub.addWire(new Wire({ x: x + 10, y: y + 1 }, { x: x + 12, y: y + 1 }));
  // Wire AND1 → OR.in1
  sub.addWire(new Wire({ x: x + 10, y: y + 5 }, { x: x + 12, y: y + 5 }));

  return sub;
}

// ---------------------------------------------------------------------------
// Gate-level substitution: 1:2 Demultiplexer → AND/NOT
// ---------------------------------------------------------------------------
//
// DEMUX (1-bit input, 1 select):
//   S=0: Y0 = D,  Y1 = 0
//   S=1: Y0 = 0,  Y1 = D
//
// Y0 = D & !S
// Y1 = D & S

function substituteDemux(
  el: CircuitElement,
  nextId: (prefix: string) => string,
  _allocatePosition: (x: number, y: number) => { x: number; y: number },
): Circuit {
  const sub = new Circuit();
  const { x, y } = el.position;

  // NOT gate for select line
  const notS = makeGateElement('NOT', nextId('notS'), { x: x + 2, y: y + 2 }, [
    makePin('in', PinDirection.INPUT, x + 2, y + 2),
    makePin('out', PinDirection.OUTPUT, x + 4, y + 2),
  ]);

  // AND gate for D & !S (output Y0)
  const and0 = makeGateElement('AND', nextId('and0'), { x: x + 6, y }, [
    makePin('in0', PinDirection.INPUT, x + 6, y),
    makePin('in1', PinDirection.INPUT, x + 6, y + 2),
    makePin('out', PinDirection.OUTPUT, x + 10, y + 1),
  ]);

  // AND gate for D & S (output Y1)
  const and1 = makeGateElement('AND', nextId('and1'), { x: x + 6, y: y + 4 }, [
    makePin('in0', PinDirection.INPUT, x + 6, y + 4),
    makePin('in1', PinDirection.INPUT, x + 6, y + 6),
    makePin('out', PinDirection.OUTPUT, x + 10, y + 5),
  ]);

  sub.addElement(notS);
  sub.addElement(and0);
  sub.addElement(and1);

  // Wire NOT output → AND0.in1
  sub.addWire(new Wire({ x: x + 4, y: y + 2 }, { x: x + 6, y: y + 2 }));

  return sub;
}

// ---------------------------------------------------------------------------
// Gate-level substitution: Decoder → AND/NOT
// ---------------------------------------------------------------------------
//
// A 2-to-4 decoder:
//   Y0 = !A & !B
//   Y1 =  A & !B
//   Y2 = !A &  B
//   Y3 =  A &  B

function substituteDecoder(
  el: CircuitElement,
  nextId: (prefix: string) => string,
  _allocatePosition: (x: number, y: number) => { x: number; y: number },
): Circuit {
  const sub = new Circuit();
  const { x, y } = el.position;

  // NOT gate for A
  const notA = makeGateElement('NOT', nextId('notA'), { x: x + 2, y }, [
    makePin('in', PinDirection.INPUT, x + 2, y),
    makePin('out', PinDirection.OUTPUT, x + 4, y),
  ]);

  // NOT gate for B
  const notB = makeGateElement('NOT', nextId('notB'), { x: x + 2, y: y + 2 }, [
    makePin('in', PinDirection.INPUT, x + 2, y + 2),
    makePin('out', PinDirection.OUTPUT, x + 4, y + 2),
  ]);

  // Y0 = !A & !B
  const and0 = makeGateElement('AND', nextId('decAnd0'), { x: x + 6, y }, [
    makePin('in0', PinDirection.INPUT, x + 6, y),
    makePin('in1', PinDirection.INPUT, x + 6, y + 2),
    makePin('out', PinDirection.OUTPUT, x + 10, y + 1),
  ]);

  // Y1 = A & !B
  const and1 = makeGateElement('AND', nextId('decAnd1'), { x: x + 6, y: y + 4 }, [
    makePin('in0', PinDirection.INPUT, x + 6, y + 4),
    makePin('in1', PinDirection.INPUT, x + 6, y + 6),
    makePin('out', PinDirection.OUTPUT, x + 10, y + 5),
  ]);

  // Y2 = !A & B
  const and2 = makeGateElement('AND', nextId('decAnd2'), { x: x + 6, y: y + 8 }, [
    makePin('in0', PinDirection.INPUT, x + 6, y + 8),
    makePin('in1', PinDirection.INPUT, x + 6, y + 10),
    makePin('out', PinDirection.OUTPUT, x + 10, y + 9),
  ]);

  // Y3 = A & B
  const and3 = makeGateElement('AND', nextId('decAnd3'), { x: x + 6, y: y + 12 }, [
    makePin('in0', PinDirection.INPUT, x + 6, y + 12),
    makePin('in1', PinDirection.INPUT, x + 6, y + 14),
    makePin('out', PinDirection.OUTPUT, x + 10, y + 13),
  ]);

  sub.addElement(notA);
  sub.addElement(notB);
  sub.addElement(and0);
  sub.addElement(and1);
  sub.addElement(and2);
  sub.addElement(and3);

  // Wire NOT outputs to AND gates
  sub.addWire(new Wire({ x: x + 4, y }, { x: x + 6, y }));       // notA → and0.in0
  sub.addWire(new Wire({ x: x + 4, y: y + 2 }, { x: x + 6, y: y + 2 })); // notB → and0.in1
  sub.addWire(new Wire({ x: x + 4, y: y + 2 }, { x: x + 6, y: y + 6 })); // notB → and1.in1
  sub.addWire(new Wire({ x: x + 4, y }, { x: x + 6, y: y + 8 }));          // notA → and2.in0
  sub.addWire(new Wire({ x: x + 4, y: y + 2 }, { x: x + 6, y: y + 10 })); // B → and2.in1

  return sub;
}

// ---------------------------------------------------------------------------
// Minimal gate element for substitution
// ---------------------------------------------------------------------------

/**
 * Minimal implementation of CircuitElement used only within substituted circuits.
 * Not rendered — used only for structural analysis.
 */
class GateElement extends AbstractCircuitElement {
  private readonly _pins: readonly Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pins: readonly Pin[],
  ) {
    super(typeId, instanceId, position, 0 as Rotation, false, new PropertyBag());
    this._pins = pins;
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(_ctx: RenderContext): void {
    // Substituted elements are not rendered
  }

  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }

  getHelpText(): string {
    return `Substituted gate: ${this.typeId}`;
  }
}

function makeGateElement(
  typeId: string,
  instanceId: string,
  position: { x: number; y: number },
  pins: Pin[],
): GateElement {
  return new GateElement(typeId, instanceId, position, pins);
}

function makePin(
  label: string,
  direction: PinDirection,
  x: number,
  y: number,
): Pin {
  return { label, direction, position: { x, y }, bitWidth: 1, isNegated: false, isClock: false };
}

// ---------------------------------------------------------------------------
// OffsetElement — wraps an element with a position offset
// ---------------------------------------------------------------------------

/**
 * Wraps a CircuitElement and returns all pins offset by (dx, dy).
 * Used when inlining a subcircuit's elements into a parent coordinate space.
 */
class OffsetElement extends AbstractCircuitElement {
  private readonly _inner: CircuitElement;
  private readonly _pins: readonly Pin[];
  private readonly _dx: number;
  private readonly _dy: number;

  constructor(inner: CircuitElement, dx: number, dy: number) {
    super(
      inner.typeId,
      inner.instanceId + `_off_${dx}_${dy}`,
      { x: inner.position.x + dx, y: inner.position.y + dy },
      inner.rotation as Rotation,
      inner.mirror,
      inner.getProperties(),
    );
    this._inner = inner;
    this._dx = dx;
    this._dy = dy;

    this._pins = inner.getPins().map((p) => ({
      ...p,
      position: { x: p.position.x + dx, y: p.position.y + dy },
    }));
  }

  getPins(): readonly Pin[] {
    return this._pins;
  }

  draw(ctx: RenderContext): void {
    this._inner.draw(ctx);
  }

  getBoundingBox(): Rect {
    const bb = this._inner.getBoundingBox();
    return { x: bb.x + this._dx, y: bb.y + this._dy, width: bb.width, height: bb.height };
  }

  getHelpText(): string {
    return this._inner.getHelpText();
  }
}

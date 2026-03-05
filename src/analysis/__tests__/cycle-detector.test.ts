/**
 * Tests for cycle-detector.ts
 *
 * Spec: src/analysis/__tests__/cycle-detector.test.ts
 *   - noCycles: simple combinational circuit → empty array
 *   - selfLoop: output wired to own input → cycle detected
 */

import { describe, it, expect } from 'vitest';
import { detectCycles } from '../cycle-detector.js';
import { Circuit, Wire } from '../../core/circuit.js';
import { AbstractCircuitElement } from '../../core/element.js';
import type { Pin, Rotation } from '../../core/pin.js';
import { PinDirection } from '../../core/pin.js';
import type { RenderContext, Rect } from '../../core/renderer-interface.js';
import { PropertyBag } from '../../core/properties.js';

// ---------------------------------------------------------------------------
// Test element stub
// ---------------------------------------------------------------------------

class StubElement extends AbstractCircuitElement {
  private readonly _pins: Pin[];

  constructor(
    typeId: string,
    instanceId: string,
    position: { x: number; y: number },
    pins: Pin[],
  ) {
    super(typeId, instanceId, position, 0 as Rotation, false, new PropertyBag());
    this._pins = pins;
  }

  getPins(): readonly Pin[] { return this._pins; }
  draw(_ctx: RenderContext): void {}
  getBoundingBox(): Rect {
    return { x: this.position.x, y: this.position.y, width: 4, height: 4 };
  }
  getHelpText(): string { return ''; }
}

function makePin(
  label: string,
  direction: PinDirection,
  x: number,
  y: number,
  bitWidth = 1,
): Pin {
  return { label, direction, position: { x, y }, bitWidth, isNegated: false, isClock: false };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CycleDetector', () => {
  it('noCycles — simple AND gate circuit → empty array', () => {
    // In(A) → AND → Out(Y)
    // In(B) → AND → Out(Y)
    //
    // Layout:
    //   InA: output at (2,0)
    //   InB: output at (2,2)
    //   AND: inputs at (4,0) and (4,2), output at (8,1)
    //   Out: input at (10,1)

    const circuit = new Circuit();

    const inA = new StubElement('In', 'inA', { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ]);
    const inB = new StubElement('In', 'inB', { x: 0, y: 2 }, [
      makePin('out', PinDirection.OUTPUT, 2, 2),
    ]);
    const and = new StubElement('AND', 'and1', { x: 4, y: 0 }, [
      makePin('in0', PinDirection.INPUT, 4, 0),
      makePin('in1', PinDirection.INPUT, 4, 2),
      makePin('out', PinDirection.OUTPUT, 8, 1),
    ]);
    const out = new StubElement('Out', 'out1', { x: 10, y: 1 }, [
      makePin('in', PinDirection.INPUT, 10, 1),
    ]);

    circuit.elements.push(inA, inB, and, out);
    circuit.wires.push(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.wires.push(new Wire({ x: 2, y: 2 }, { x: 4, y: 2 }));
    circuit.wires.push(new Wire({ x: 8, y: 1 }, { x: 10, y: 1 }));

    const cycles = detectCycles(circuit);
    expect(cycles).toHaveLength(0);
  });

  it('selfLoop — output wired to own input → cycle detected', () => {
    // A NOT gate with its output wired back to its own input.
    //
    // NOT: input at (4,0), output at (8,0)
    // Wire: (8,0) → (4,0)  [output feeds back to input]

    const circuit = new Circuit();

    const notGate = new StubElement('NOT', 'not1', { x: 4, y: 0 }, [
      makePin('in', PinDirection.INPUT, 4, 0),
      makePin('out', PinDirection.OUTPUT, 8, 0),
    ]);

    circuit.elements.push(notGate);
    // Feedback wire: output (8,0) → input (4,0)
    circuit.wires.push(new Wire({ x: 8, y: 0 }, { x: 4, y: 0 }));

    const cycles = detectCycles(circuit);
    expect(cycles.length).toBeGreaterThan(0);
    expect(cycles[0].componentIds).toContain('not1');
  });

  it('noCycles — two independent chains → empty array', () => {
    // Chain 1: In(X) → NOT → Out(Y)
    // Chain 2: In(P) → NOT → Out(Q)
    // Both are acyclic.

    const circuit = new Circuit();

    const inX = new StubElement('In', 'inX', { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ]);
    const not1 = new StubElement('NOT', 'not1', { x: 4, y: 0 }, [
      makePin('in', PinDirection.INPUT, 4, 0),
      makePin('out', PinDirection.OUTPUT, 8, 0),
    ]);
    const outY = new StubElement('Out', 'outY', { x: 10, y: 0 }, [
      makePin('in', PinDirection.INPUT, 10, 0),
    ]);

    const inP = new StubElement('In', 'inP', { x: 0, y: 10 }, [
      makePin('out', PinDirection.OUTPUT, 2, 10),
    ]);
    const not2 = new StubElement('NOT', 'not2', { x: 4, y: 10 }, [
      makePin('in', PinDirection.INPUT, 4, 10),
      makePin('out', PinDirection.OUTPUT, 8, 10),
    ]);
    const outQ = new StubElement('Out', 'outQ', { x: 10, y: 10 }, [
      makePin('in', PinDirection.INPUT, 10, 10),
    ]);

    circuit.elements.push(inX, not1, outY, inP, not2, outQ);
    circuit.wires.push(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.wires.push(new Wire({ x: 8, y: 0 }, { x: 10, y: 0 }));
    circuit.wires.push(new Wire({ x: 2, y: 10 }, { x: 4, y: 10 }));
    circuit.wires.push(new Wire({ x: 8, y: 10 }, { x: 10, y: 10 }));

    const cycles = detectCycles(circuit);
    expect(cycles).toHaveLength(0);
  });

  it('noCycles — empty circuit → empty array', () => {
    const circuit = new Circuit();
    const cycles = detectCycles(circuit);
    expect(cycles).toHaveLength(0);
  });

  it('noCycles — memory component in feedback path is not a cycle', () => {
    // FlipflopD Q output fed back to D input — this is sequential, not combinational.
    // The flip-flop is a memory component and should break the cycle.
    //
    // In(D) → FlipflopD(D input) → FlipflopD(Q output) → Out(Q)
    // FlipflopD Q output also wired back to FlipflopD D input (sequential feedback)

    const circuit = new Circuit();

    const inD = new StubElement('In', 'inD', { x: 0, y: 0 }, [
      makePin('out', PinDirection.OUTPUT, 2, 0),
    ]);
    // FlipflopD: D input at (4,0), Q output at (8,0)
    const ff = new StubElement('FlipflopD', 'ff1', { x: 4, y: 0 }, [
      makePin('D', PinDirection.INPUT, 4, 0),
      makePin('Q', PinDirection.OUTPUT, 8, 0),
    ]);
    const outQ = new StubElement('Out', 'outQ', { x: 10, y: 0 }, [
      makePin('in', PinDirection.INPUT, 10, 0),
    ]);

    circuit.elements.push(inD, ff, outQ);
    circuit.wires.push(new Wire({ x: 2, y: 0 }, { x: 4, y: 0 }));
    circuit.wires.push(new Wire({ x: 8, y: 0 }, { x: 10, y: 0 }));
    // Feedback from Q → D (sequential feedback through flip-flop)
    circuit.wires.push(new Wire({ x: 8, y: 0 }, { x: 4, y: 0 }));

    const cycles = detectCycles(circuit);
    // Flip-flop breaks the combinational cycle — should be 0 cycles
    expect(cycles).toHaveLength(0);
  });
});

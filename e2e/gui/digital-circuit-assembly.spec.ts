/**
 * Digital circuit assembly E2E tests — Phase 2 of the test plan.
 *
 * Every test in this file builds a complete circuit through genuine UI
 * interactions: palette click → canvas placement → wire drawing between pins
 * → simulation stepping → output verification via test vectors.
 *
 * The test bridge is used ONLY for coordinate queries and state reads.
 * NO bridge mutation methods. NO page.evaluate(() => button.click()).
 *
 * See spec/e2e-circuit-assembly-test-plan.md for full plan.
 */
import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ---------------------------------------------------------------------------
// Layout conventions:
//   Inputs on the left (col 3–5), gates in the middle (col 10–14),
//   outputs on the right (col 18–20). Vertical spacing = 3 grid units.
// ---------------------------------------------------------------------------

test.describe('Digital circuit assembly via UI', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
  });

  // =========================================================================
  // Test 1: AND gate — the single most important test
  // =========================================================================

  test('AND gate: place, wire, simulate, verify truth table', async () => {
    await builder.placeLabeled('In', 3, 6, 'A');
    await builder.placeLabeled('In', 3, 9, 'B');
    await builder.placeLabeled('And', 10, 7, 'G');
    await builder.placeLabeled('Out', 18, 7, 'Y');

    const info = await builder.getCircuitInfo();
    expect(info.elementCount).toBe(4);

    await builder.drawWire('A', 'out', 'G', 'In_1');
    await builder.drawWire('B', 'out', 'G', 'In_2');
    await builder.drawWire('G', 'out', 'Y', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(4);
  });

  // =========================================================================
  // Test 2: OR gate
  // =========================================================================

  test('OR gate: place, wire, simulate, verify truth table', async () => {
    await builder.placeLabeled('In', 3, 6, 'A');
    await builder.placeLabeled('In', 3, 9, 'B');
    await builder.placeLabeled('Or', 10, 7, 'G');
    await builder.placeLabeled('Out', 18, 7, 'Y');

    await builder.drawWire('A', 'out', 'G', 'In_1');
    await builder.drawWire('B', 'out', 'G', 'In_2');
    await builder.drawWire('G', 'out', 'Y', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'A B Y\n0 0 0\n0 1 1\n1 0 1\n1 1 1',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 3: NOT gate (simplest single-input)
  // =========================================================================

  test('NOT gate: inverter', async () => {
    await builder.placeLabeled('In', 3, 7, 'A');
    await builder.placeLabeled('Not', 10, 7, 'N');
    await builder.placeLabeled('Out', 18, 7, 'Y');

    await builder.drawWire('A', 'out', 'N', 'in');
    await builder.drawWire('N', 'out', 'Y', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors('A Y\n0 1\n1 0');
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 4: NAND gate
  // =========================================================================

  test('NAND gate: verify truth table', async () => {
    await builder.placeLabeled('In', 3, 6, 'A');
    await builder.placeLabeled('In', 3, 9, 'B');
    await builder.placeLabeled('NAnd', 10, 7, 'G');
    await builder.placeLabeled('Out', 18, 7, 'Y');

    await builder.drawWire('A', 'out', 'G', 'In_1');
    await builder.drawWire('B', 'out', 'G', 'In_2');
    await builder.drawWire('G', 'out', 'Y', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'A B Y\n0 0 1\n0 1 1\n1 0 1\n1 1 0',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 5: XOR gate
  // =========================================================================

  test('XOR gate: verify truth table', async () => {
    await builder.placeLabeled('In', 3, 6, 'A');
    await builder.placeLabeled('In', 3, 9, 'B');
    await builder.placeLabeled('XOr', 10, 7, 'G');
    await builder.placeLabeled('Out', 18, 7, 'Y');

    await builder.drawWire('A', 'out', 'G', 'In_1');
    await builder.drawWire('B', 'out', 'G', 'In_2');
    await builder.drawWire('G', 'out', 'Y', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'A B Y\n0 0 0\n0 1 1\n1 0 1\n1 1 0',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 6: 2:1 Multiplexer (palette name = "Multiplexer")
  // =========================================================================

  test('2:1 Mux: selector routes correct input to output', async () => {
    await builder.placeLabeled('In', 3, 5, 'A');
    await builder.placeLabeled('In', 3, 8, 'B');
    await builder.placeLabeled('In', 3, 12, 'Sel');
    await builder.placeLabeled('Multiplexer', 10, 7, 'M');
    await builder.placeLabeled('Out', 18, 7, 'Y');

    await builder.drawWire('A', 'out', 'M', 'in_0');
    await builder.drawWire('B', 'out', 'M', 'in_1');
    await builder.drawWire('Sel', 'out', 'M', 'sel');
    await builder.drawWire('M', 'out', 'Y', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'A B Sel Y\n' +
      '0 0 0 0\n' +
      '1 0 0 1\n' +
      '0 1 0 0\n' +
      '0 0 1 0\n' +
      '0 1 1 1\n' +
      '1 1 1 1',
    );
    expect(result.passed).toBe(6);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 7: Half adder — fan-out from same output pin
  // FIXME: Drawing a second wire from the same output pin (fan-out) does not
  // create a junction in the UI. The second wire draw from A:out to C:In_1
  // fails to connect. Needs investigation into wire-drawing mode behavior
  // when starting from a pin that already has a wire endpoint.
  // =========================================================================

  test('half adder: XOr for sum, And for carry (fan-out)', async () => {
    await builder.placeLabeled('In', 3, 5, 'A');
    await builder.placeLabeled('In', 3, 11, 'B');
    await builder.placeLabeled('XOr', 10, 5, 'X');
    await builder.placeLabeled('And', 10, 11, 'C');
    await builder.placeLabeled('Out', 18, 5, 'S');
    await builder.placeLabeled('Out', 18, 11, 'Co');

    await builder.drawWire('A', 'out', 'X', 'In_1');
    await builder.drawWire('B', 'out', 'X', 'In_2');
    await builder.drawWire('X', 'out', 'S', 'in');
    // Fan-out: second wire from same output pin
    await builder.drawWire('A', 'out', 'C', 'In_1');
    await builder.drawWire('B', 'out', 'C', 'In_2');
    await builder.drawWire('C', 'out', 'Co', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'A B S Co\n0 0 0 0\n0 1 1 0\n1 0 1 0\n1 1 0 1',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 8: SR latch from NAND gates (sequential, feedback)
  // FIXME: Test vector execution times out for circuits with feedback loops.
  // The postMessage-based test runner may not handle oscillation/settling
  // correctly when the circuit has combinational feedback.
  // =========================================================================

  test('SR latch from NAND gates: set, hold, reset', async () => {
    await builder.placeLabeled('In', 3, 5, 'nS');
    await builder.placeLabeled('In', 3, 15, 'nR');
    await builder.placeLabeled('NAnd', 10, 6, 'N1');
    await builder.placeLabeled('NAnd', 10, 14, 'N2');
    await builder.placeLabeled('Out', 20, 6, 'Q');
    await builder.placeLabeled('Out', 20, 14, 'nQ');

    await builder.drawWire('nS', 'out', 'N1', 'In_1');
    await builder.drawWire('nR', 'out', 'N2', 'In_2');
    await builder.drawWire('N1', 'out', 'N2', 'In_1');
    await builder.drawWire('N2', 'out', 'N1', 'In_2');
    await builder.drawWire('N1', 'out', 'Q', 'in');
    await builder.drawWire('N2', 'out', 'nQ', 'in');

    await builder.stepViaUI();

    const result = await builder.runTestVectors(
      'nS nR Q nQ\n0 1 1 0\n1 1 1 0\n1 0 0 1\n1 1 0 1',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 9: D flip-flop (clock-driven sequential)
  // FIXME: Test vector execution times out. The 'C' clock token in test
  // vectors may not be supported by the postMessage digital-test handler,
  // or the circuit compilation/stepping for clock-driven circuits needs
  // investigation in the direct page (non-iframe) context.
  // =========================================================================

  test('D flip-flop: clock-edge triggered latch', async () => {
    await builder.placeLabeled('In', 3, 6, 'D');
    await builder.placeLabeled('Clock', 3, 10, 'C');
    await builder.placeLabeled('D_FF', 10, 7, 'FF');
    await builder.placeLabeled('Out', 18, 6, 'Q');

    await builder.drawWire('D', 'out', 'FF', 'D');
    await builder.drawWire('C', 'out', 'FF', 'C');
    await builder.drawWire('FF', 'Q', 'Q', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'D C Q\n0 C 0\n1 C 1\n0 C 0\n1 C 1',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 10: Tunnel wiring (invisible connections)
  // Tunnel has a single bidirectional pin named "in".
  // Net name is set via the property popup's "Net Name" field.
  // =========================================================================

  // FIXME: Tunnel test gets 1/2 — the wire from T2:in to Y:in may not
  // connect properly. Tunnel has a single bidirectional pin named "in";
  // drawing FROM that pin to another input pin may confuse wire-drawing mode.
  // Needs investigation into bidirectional pin wire-drawing behavior.
  test('Tunnel wiring: signal propagates through named tunnels', async () => {
    await builder.placeLabeled('In', 3, 7, 'A');
    await builder.placeLabeled('Out', 20, 7, 'Y');

    // Tunnels have no "Label" property — only "Net Name". Use type-index API.
    await builder.placeComponent('Tunnel', 8, 7);
    await builder.placeComponent('Tunnel', 14, 7);

    const info = await builder.getCircuitInfo();
    expect(info.elements.filter(e => e.typeId === 'Tunnel').length).toBe(2);

    // Set Net Name on both tunnels
    await builder.setPropertyByTypeIndex('Tunnel', 0, 'Net Name', 'sig');
    await builder.setPropertyByTypeIndex('Tunnel', 1, 'Net Name', 'sig');

    // Wire using type-index pin positions (tunnels have no label)
    const aOutPos = await builder.getPinPagePosition('A', 'out');
    const t1InPos = await builder.getPinPagePositionByTypeIndex('Tunnel', 0, 'in');
    const t2InPos = await builder.getPinPagePositionByTypeIndex('Tunnel', 1, 'in');
    const yInPos = await builder.getPinPagePosition('Y', 'in');

    await builder.drawWireBetweenPoints(aOutPos, t1InPos);
    await builder.drawWireBetweenPoints(t2InPos, yInPos);

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors('A Y\n0 0\n1 1');
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });
});

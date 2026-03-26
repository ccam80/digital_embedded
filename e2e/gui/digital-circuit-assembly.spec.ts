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
import { mkdirSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { openSync, closeSync, constants as fsConst } from 'fs';

// ---------------------------------------------------------------------------
// Debug circuit export: on each run, clear circuits/debug/ and write .dig
// files for every failing test so the circuit can be inspected offline.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DEBUG_DIR = resolve(__dirname, '../../circuits/debug');

// Atomic once-per-run cleanup: lock file in tmpdir survives the dir wipe.
mkdirSync(DEBUG_DIR, { recursive: true });
try {
  const lock = resolve(tmpdir(), 'digital-e2e-debug-cleanup.lock');
  const fd = openSync(lock, fsConst.O_CREAT | fsConst.O_EXCL | fsConst.O_WRONLY);
  closeSync(fd);
  // Winner: remove stale .dig files (keep dir intact for concurrent writers)
  for (const f of readdirSync(DEBUG_DIR)) {
    if (f.endsWith('.dig')) unlinkSync(resolve(DEBUG_DIR, f));
  }
  // Schedule lock removal so next run can clean again
  process.on('exit', () => { try { unlinkSync(lock); } catch { /* */ } });
} catch {
  // Another worker (or stale lock) — just ensure dir exists
}

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

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') {
      // Export the circuit as .dig XML for offline debugging
      const xml = await builder.exportCircuitDigXml();
      if (xml) {
        const safeName = testInfo.title
          .replace(/[^a-zA-Z0-9_-]/g, '-')
          .replace(/-+/g, '-')
          .replace(/^-|-$/g, '')
          .toLowerCase()
          .slice(0, 80);
        writeFileSync(resolve(DEBUG_DIR, `${safeName}.dig`), xml, 'utf-8');
      }
    }
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
  // Test 6: Half adder — XOr for sum, And for carry (fan-out from inputs)
  // Two wires originate from each input pin (A→XOr + A→And, B→XOr + B→And).
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
    // Fan-out: second wire from same output pins
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
  // Test 7: Full adder — 3 inputs, 7 components, heavy fan-out
  // S = A⊕B⊕Cin, Co = (A∧B)∨((A⊕B)∧Cin)
  // =========================================================================

  test('full adder: sum and carry for all 8 input combos', async () => {
    // Inputs
    await builder.placeLabeled('In', 3, 4, 'A');
    await builder.placeLabeled('In', 3, 8, 'B');
    await builder.placeLabeled('In', 3, 12, 'Cin');

    // Stage 1: A⊕B and A∧B
    await builder.placeLabeled('XOr', 8, 5, 'X1');
    await builder.placeLabeled('And', 8, 11, 'A1');

    // Stage 2: (A⊕B)⊕Cin and (A⊕B)∧Cin
    await builder.placeLabeled('XOr', 14, 5, 'X2');
    await builder.placeLabeled('And', 14, 11, 'A2');

    // Stage 3: carry = (A∧B)∨((A⊕B)∧Cin)
    await builder.placeLabeled('Or', 18, 11, 'O1');

    // Outputs
    await builder.placeLabeled('Out', 22, 5, 'S');
    await builder.placeLabeled('Out', 22, 11, 'Co');

    // Wire stage 1
    await builder.drawWire('A', 'out', 'X1', 'In_1');
    await builder.drawWire('B', 'out', 'X1', 'In_2');
    await builder.drawWire('A', 'out', 'A1', 'In_1');   // fan-out from A
    await builder.drawWire('B', 'out', 'A1', 'In_2');   // fan-out from B

    // Wire stage 2
    await builder.drawWire('X1', 'out', 'X2', 'In_1');
    await builder.drawWire('Cin', 'out', 'X2', 'In_2');
    await builder.drawWire('X1', 'out', 'A2', 'In_1');  // fan-out from X1
    await builder.drawWire('Cin', 'out', 'A2', 'In_2'); // fan-out from Cin

    // Wire stage 3 + outputs
    await builder.drawWire('X2', 'out', 'S', 'in');
    await builder.drawWire('A1', 'out', 'O1', 'In_1');
    await builder.drawWire('A2', 'out', 'O1', 'In_2');
    await builder.drawWire('O1', 'out', 'Co', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'A B Cin S Co\n' +
      '0 0 0 0 0\n' +
      '0 0 1 1 0\n' +
      '0 1 0 1 0\n' +
      '0 1 1 0 1\n' +
      '1 0 0 1 0\n' +
      '1 0 1 0 1\n' +
      '1 1 0 0 1\n' +
      '1 1 1 1 1',
    );
    expect(result.passed).toBe(8);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 8: SR latch from NAND gates (sequential, feedback)
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
  // Test 10: JK flip-flop — all four modes: hold, set, reset, toggle
  // =========================================================================

  test('JK flip-flop: hold, set, reset, toggle', async () => {
    await builder.placeLabeled('In', 3, 5, 'J');
    await builder.placeLabeled('In', 3, 11, 'K');
    await builder.placeLabeled('Clock', 3, 8, 'C');
    await builder.placeLabeled('JK_FF', 10, 7, 'FF');
    await builder.placeLabeled('Out', 18, 5, 'Q');
    await builder.placeLabeled('Out', 18, 10, 'nQ');

    await builder.drawWire('J', 'out', 'FF', 'J');
    await builder.drawWire('K', 'out', 'FF', 'K');
    await builder.drawWire('C', 'out', 'FF', 'C');
    await builder.drawWire('FF', 'Q', 'Q', 'in');
    await builder.drawWire('FF', '~Q', 'nQ', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // J=1,K=0 → set; J=0,K=0 → hold; J=0,K=1 → reset; J=1,K=1 → toggle
    const result = await builder.runTestVectors(
      'J K C Q nQ\n' +
      '1 0 C 1 0\n' +  // set
      '0 0 C 1 0\n' +  // hold (Q stays 1)
      '0 1 C 0 1\n' +  // reset
      '1 1 C 1 0\n' +  // toggle (was 0 → 1)
      '1 1 C 0 1',     // toggle (was 1 → 0)
    );
    expect(result.passed).toBe(5);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 11: T flip-flop ripple counter (4-bit)
  // Chain T_FFs: CLK→T1, T1:Q→T2:C, T2:Q→T3:C, T3:Q→T4:C
  // All T inputs tied high via VDD.
  // =========================================================================

  test('T flip-flop 4-bit ripple counter', async () => {
    // VDD to tie T inputs high (no Label property — use placeComponent)
    await builder.placeComponent('VDD', 3, 3);
    await builder.placeLabeled('Clock', 3, 7, 'CLK');

    // Four T_FFs spaced vertically
    await builder.placeLabeled('T_FF', 10, 5, 'T1');
    await builder.placeLabeled('T_FF', 10, 10, 'T2');
    await builder.placeLabeled('T_FF', 10, 15, 'T3');
    await builder.placeLabeled('T_FF', 10, 20, 'T4');

    // Outputs
    await builder.placeLabeled('Out', 18, 5, 'Q0');
    await builder.placeLabeled('Out', 18, 10, 'Q1');
    await builder.placeLabeled('Out', 18, 15, 'Q2');
    await builder.placeLabeled('Out', 18, 20, 'Q3');

    // VDD → all T inputs (fan-out) — wire via coordinates since VDD has no label
    const vddOut = await builder.getPinPagePositionByTypeIndex('VDD', 0, 'out');
    const t1T = await builder.getPinPagePosition('T1', 'T');
    const t2T = await builder.getPinPagePosition('T2', 'T');
    const t3T = await builder.getPinPagePosition('T3', 'T');
    const t4T = await builder.getPinPagePosition('T4', 'T');
    await builder.drawWireBetweenPoints(vddOut, t1T);
    await builder.drawWireBetweenPoints(vddOut, t2T);
    await builder.drawWireBetweenPoints(vddOut, t3T);
    await builder.drawWireBetweenPoints(vddOut, t4T);

    // Clock chain
    await builder.drawWire('CLK', 'out', 'T1', 'C');
    await builder.drawWire('T1', 'Q', 'T2', 'C');
    await builder.drawWire('T2', 'Q', 'T3', 'C');
    await builder.drawWire('T3', 'Q', 'T4', 'C');

    // Outputs (fan-out from Q — Q also drives next stage clock)
    await builder.drawWire('T1', 'Q', 'Q0', 'in');
    await builder.drawWire('T2', 'Q', 'Q1', 'in');
    await builder.drawWire('T3', 'Q', 'Q2', 'in');
    await builder.drawWire('T4', 'Q', 'Q3', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // After each clock pulse, count increments: 0→1→2→3→4
    const result = await builder.runTestVectors(
      'CLK Q0 Q1 Q2 Q3\n' +
      'C 1 0 0 0\n' +   // count=1
      'C 0 1 0 0\n' +   // count=2
      'C 1 1 0 0\n' +   // count=3
      'C 0 0 1 0',      // count=4
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 12: 4-bit counter (built-in Counter component)
  // =========================================================================

  test('4-bit counter: count sequence via built-in Counter', async () => {
    await builder.placeLabeled('Clock', 3, 7, 'CLK');
    // Use In components for EN and CLR (Const has no Label property)
    await builder.placeLabeled('In', 3, 5, 'EN');
    await builder.placeLabeled('In', 3, 10, 'CLR');
    await builder.placeLabeled('Counter', 10, 7, 'CTR');
    await builder.placeLabeled('Out', 18, 7, 'Q');

    // Set Out to 4-bit to match Counter's default 4-bit output
    await builder.setComponentProperty('Q', 'Bits', 4);

    await builder.drawWire('EN', 'out', 'CTR', 'en');
    await builder.drawWire('CLK', 'out', 'CTR', 'C');
    await builder.drawWire('CLR', 'out', 'CTR', 'clr');
    await builder.drawWire('CTR', 'out', 'Q', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // EN=1, CLR=0 held constant; clock advances count
    const result = await builder.runTestVectors(
      'EN CLR CLK Q\n' +
      '1 0 C 1\n' +
      '1 0 C 2\n' +
      '1 0 C 3\n' +
      '1 0 C 4\n' +
      '1 0 C 5',
    );
    expect(result.passed).toBe(5);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 13: 2:1 Multiplexer
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
  // Test 14: 4:1 Multiplexer (selectorBits=2)
  // =========================================================================

  test('4:1 Mux: 2-bit selector routes one of four inputs', async () => {
    await builder.placeLabeled('In', 3, 4, 'D0');
    await builder.placeLabeled('In', 3, 7, 'D1');
    await builder.placeLabeled('In', 3, 10, 'D2');
    await builder.placeLabeled('In', 3, 13, 'D3');
    await builder.placeLabeled('In', 3, 17, 'Sel');
    await builder.placeLabeled('Multiplexer', 10, 8, 'M');
    await builder.placeLabeled('Out', 18, 8, 'Y');

    // Configure Mux for 4:1 (selectorBits=2) and Sel input for 2 bits
    await builder.setComponentProperty('M', 'Selector Bits', 2);
    await builder.setComponentProperty('Sel', 'Bits', 2);

    await builder.drawWire('D0', 'out', 'M', 'in_0');
    await builder.drawWire('D1', 'out', 'M', 'in_1');
    await builder.drawWire('D2', 'out', 'M', 'in_2');
    await builder.drawWire('D3', 'out', 'M', 'in_3');
    await builder.drawWire('Sel', 'out', 'M', 'sel');
    await builder.drawWire('M', 'out', 'Y', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Sel=0→D0, Sel=1→D1, Sel=2→D2, Sel=3→D3
    const result = await builder.runTestVectors(
      'D0 D1 D2 D3 Sel Y\n' +
      '1 0 0 0 0 1\n' +
      '0 1 0 0 1 1\n' +
      '0 0 1 0 2 1\n' +
      '0 0 0 1 3 1\n' +
      '1 1 1 1 0 1\n' +
      '1 1 1 1 2 1',
    );
    expect(result.passed).toBe(6);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 15: Decoder (2-bit → 4 one-hot outputs)
  // =========================================================================

  test('Decoder: 2-bit input produces one-hot outputs', async () => {
    await builder.placeLabeled('In', 3, 8, 'Sel');
    await builder.placeLabeled('Decoder', 10, 8, 'DEC');
    await builder.placeLabeled('Out', 18, 4, 'Y0');
    await builder.placeLabeled('Out', 18, 7, 'Y1');
    await builder.placeLabeled('Out', 18, 10, 'Y2');
    await builder.placeLabeled('Out', 18, 13, 'Y3');

    // Configure decoder for 2-bit selector (4 outputs)
    await builder.setComponentProperty('DEC', 'Selector Bits', 2);
    await builder.setComponentProperty('Sel', 'Bits', 2);

    await builder.drawWire('Sel', 'out', 'DEC', 'sel');
    await builder.drawWire('DEC', 'out_0', 'Y0', 'in');
    await builder.drawWire('DEC', 'out_1', 'Y1', 'in');
    await builder.drawWire('DEC', 'out_2', 'Y2', 'in');
    await builder.drawWire('DEC', 'out_3', 'Y3', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'Sel Y0 Y1 Y2 Y3\n' +
      '0 1 0 0 0\n' +
      '1 0 1 0 0\n' +
      '2 0 0 1 0\n' +
      '3 0 0 0 1',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 16: 4-bit adder (Add component)
  // =========================================================================

  test('4-bit adder: multi-bit arithmetic with carry', async () => {
    await builder.placeLabeled('In', 3, 5, 'A');
    await builder.placeLabeled('In', 3, 8, 'B');
    await builder.placeLabeled('In', 3, 11, 'Ci');
    await builder.placeLabeled('Add', 10, 7, 'ADD');
    await builder.placeLabeled('Out', 18, 6, 'S');
    await builder.placeLabeled('Out', 18, 9, 'Co');

    // Set widths: A, B, S = 4-bit; Ci, Co = 1-bit (default)
    await builder.setComponentProperty('A', 'Bits', 4);
    await builder.setComponentProperty('B', 'Bits', 4);
    await builder.setComponentProperty('ADD', 'Bits', 4);
    await builder.setComponentProperty('S', 'Bits', 4);

    await builder.drawWire('A', 'out', 'ADD', 'a');
    await builder.drawWire('B', 'out', 'ADD', 'b');
    await builder.drawWire('Ci', 'out', 'ADD', 'c_i');
    await builder.drawWire('ADD', 's', 'S', 'in');
    await builder.drawWire('ADD', 'c_o', 'Co', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'A B Ci S Co\n' +
      '3 5 0 8 0\n' +
      '7 8 0 15 0\n' +
      '15 1 0 0 1\n' +   // overflow: 15+1 = 16 → S=0, Co=1
      '15 0 1 0 1\n' +   // 15+0+1 = 16 → S=0, Co=1
      '0 0 0 0 0\n' +
      '6 6 1 13 0',      // 6+6+1 = 13
    );
    expect(result.passed).toBe(6);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 17: Comparator (4-bit)
  // Pin labels >, =, < are wired to labeled Outs for test vectors.
  // =========================================================================

  test('Comparator: less, equal, greater for 4-bit values', async () => {
    await builder.placeLabeled('In', 3, 5, 'A');
    await builder.placeLabeled('In', 3, 9, 'B');
    await builder.placeLabeled('Comparator', 10, 7, 'CMP');
    await builder.placeLabeled('Out', 18, 4, 'GT');
    await builder.placeLabeled('Out', 18, 7, 'EQ');
    await builder.placeLabeled('Out', 18, 10, 'LT');

    // Set 4-bit width
    await builder.setComponentProperty('A', 'Bits', 4);
    await builder.setComponentProperty('B', 'Bits', 4);
    await builder.setComponentProperty('CMP', 'Bits', 4);

    await builder.drawWire('A', 'out', 'CMP', 'a');
    await builder.drawWire('B', 'out', 'CMP', 'b');
    await builder.drawWire('CMP', '>', 'GT', 'in');
    await builder.drawWire('CMP', '=', 'EQ', 'in');
    await builder.drawWire('CMP', '<', 'LT', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'A B GT EQ LT\n' +
      '5 3 1 0 0\n' +
      '3 5 0 0 1\n' +
      '7 7 0 1 0\n' +
      '0 0 0 1 0\n' +
      '15 0 1 0 0\n' +
      '0 15 0 0 1',
    );
    expect(result.passed).toBe(6);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 18: ROM lookup (preloaded data)
  // ROM with 2-bit address (4 words), 8-bit data, sel tied high.
  // =========================================================================

  test('ROM lookup: read preloaded data by address', async () => {
    await builder.placeLabeled('In', 3, 7, 'A');
    // VDD has no Label property — use placeComponent + coordinate wiring
    await builder.placeComponent('VDD', 3, 10);
    await builder.placeLabeled('ROM', 10, 7, 'ROM');
    await builder.placeLabeled('Out', 18, 7, 'D');

    // Configure ROM: 2-bit address, 8-bit data, preload data
    await builder.setComponentProperty('ROM', 'Address bits', 2);
    await builder.setComponentProperty('ROM', 'Data bits', 8);
    await builder.setComponentProperty('ROM', 'Data', '1,2,3,4');

    // Set input/output widths
    await builder.setComponentProperty('A', 'Bits', 2);
    await builder.setComponentProperty('D', 'Bits', 8);

    await builder.drawWire('A', 'out', 'ROM', 'A');
    // Wire VDD → ROM:sel via coordinates
    const vddOut = await builder.getPinPagePositionByTypeIndex('VDD', 0, 'out');
    const romSel = await builder.getPinPagePosition('ROM', 'sel');
    await builder.drawWireBetweenPoints(vddOut, romSel);
    await builder.drawWire('ROM', 'D', 'D', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors(
      'A D\n' +
      '0 1\n' +
      '1 2\n' +
      '2 3\n' +
      '3 4',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 19: RAM write/read (RAMDualPort — separate Din and D ports)
  // Write values, then read them back.
  // =========================================================================

  test('RAM write/read: store and retrieve values', async () => {
    await builder.placeLabeled('In', 3, 3, 'A');
    await builder.placeLabeled('In', 3, 6, 'Din');
    await builder.placeLabeled('In', 3, 9, 'WE');
    await builder.placeLabeled('Clock', 3, 12, 'C');
    await builder.placeLabeled('In', 3, 15, 'LD');
    await builder.placeLabeled('RAMDualPort', 10, 8, 'RAM');
    await builder.placeLabeled('Out', 18, 8, 'D');

    // Configure: 2-bit address (4 words), 8-bit data
    await builder.setComponentProperty('RAM', 'Address bits', 2);
    await builder.setComponentProperty('RAM', 'Data bits', 8);
    await builder.setComponentProperty('A', 'Bits', 2);
    await builder.setComponentProperty('Din', 'Bits', 8);
    await builder.setComponentProperty('D', 'Bits', 8);

    await builder.drawWire('A', 'out', 'RAM', 'A');
    await builder.drawWire('Din', 'out', 'RAM', 'Din');
    await builder.drawWire('WE', 'out', 'RAM', 'str');
    await builder.drawWire('C', 'out', 'RAM', 'C');
    await builder.drawWire('LD', 'out', 'RAM', 'ld');
    await builder.drawWire('RAM', 'D', 'D', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Write 42 to addr 0, then 99 to addr 1, then read both back
    const result = await builder.runTestVectors(
      'A Din WE LD C D\n' +
      '0 42 1 0 C 0\n' +    // write 42 to addr 0 (ld=0 → D=0)
      '1 99 1 0 C 0\n' +    // write 99 to addr 1
      '0 0 0 1 0 42\n' +    // read addr 0 → D=42 (no clock needed)
      '1 0 0 1 0 99',       // read addr 1 → D=99
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 20: Register file — write to R0 and R1, read back via both ports
  // =========================================================================

  test('Register file: write and read registers', async () => {
    await builder.placeLabeled('In', 3, 3, 'Din');
    await builder.placeLabeled('In', 3, 6, 'WE');
    await builder.placeLabeled('In', 3, 9, 'Rw');
    await builder.placeLabeled('Clock', 3, 12, 'C');
    await builder.placeLabeled('In', 3, 15, 'Ra');
    await builder.placeLabeled('In', 3, 18, 'Rb');
    await builder.placeLabeled('RegisterFile', 10, 10, 'RF');
    await builder.placeLabeled('Out', 18, 8, 'Da');
    await builder.placeLabeled('Out', 18, 13, 'Db');

    // Configure: 8-bit data, 2-bit address (4 registers)
    await builder.setComponentProperty('RF', 'Bits', 8);
    await builder.setComponentProperty('RF', 'Address bits', 2);
    await builder.setComponentProperty('Din', 'Bits', 8);
    await builder.setComponentProperty('Rw', 'Bits', 2);
    await builder.setComponentProperty('Ra', 'Bits', 2);
    await builder.setComponentProperty('Rb', 'Bits', 2);
    await builder.setComponentProperty('Da', 'Bits', 8);
    await builder.setComponentProperty('Db', 'Bits', 8);

    await builder.drawWire('Din', 'out', 'RF', 'Din');
    await builder.drawWire('WE', 'out', 'RF', 'we');
    await builder.drawWire('Rw', 'out', 'RF', 'Rw');
    await builder.drawWire('C', 'out', 'RF', 'C');
    await builder.drawWire('Ra', 'out', 'RF', 'Ra');
    await builder.drawWire('Rb', 'out', 'RF', 'Rb');
    await builder.drawWire('RF', 'Da', 'Da', 'in');
    await builder.drawWire('RF', 'Db', 'Db', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Write 42 to R0, then 99 to R1, then read both
    const result = await builder.runTestVectors(
      'Din WE Rw C Ra Rb Da Db\n' +
      '42 1 0 C 0 1 42 0\n' +   // write 42→R0; Ra=0→Da=42, Rb=1→Db=0
      '99 1 1 C 0 1 42 99\n' +  // write 99→R1; Ra=0→Da=42, Rb=1→Db=99
      '0 0 0 0 1 0 99 42',      // read Ra=1→Da=99, Rb=0→Db=42
    );
    expect(result.passed).toBe(3);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 21: Tunnel wiring (invisible connections via net name)
  // =========================================================================

  test('Tunnel wiring: signal propagates through named tunnels', async () => {
    await builder.placeLabeled('In', 3, 7, 'A');
    await builder.placeLabeled('Out', 20, 7, 'Y');

    // Place tunnels — set Net Name via the double-click popup
    await builder.placeComponent('Tunnel', 8, 7);
    await builder.placeComponent('Tunnel', 14, 7);

    const info = await builder.getCircuitInfo();
    const tunnels = info.elements.filter(e => e.typeId === 'Tunnel');
    expect(tunnels.length).toBe(2);

    // Set Net Name on first tunnel via popup
    const t1Center = await builder.toPageCoords(tunnels[0].center.screenX, tunnels[0].center.screenY);
    await builder.page.mouse.dblclick(t1Center.x, t1Center.y);
    await builder.page.waitForTimeout(200);
    let popup = builder.page.locator('.prop-popup');
    await expect(popup).toBeVisible({ timeout: 3000 });
    let netInput = popup.locator('.prop-row:has(.prop-label:text-is("Net Name")) input').first();
    await netInput.fill('sig');
    await netInput.dispatchEvent('change');
    await builder.page.keyboard.press('Escape');
    await builder.page.waitForTimeout(100);

    // Set Net Name on second tunnel via popup
    const t2Center = await builder.toPageCoords(tunnels[1].center.screenX, tunnels[1].center.screenY);
    await builder.page.mouse.dblclick(t2Center.x, t2Center.y);
    await builder.page.waitForTimeout(200);
    popup = builder.page.locator('.prop-popup');
    await expect(popup).toBeVisible({ timeout: 3000 });
    netInput = popup.locator('.prop-row:has(.prop-label:text-is("Net Name")) input').first();
    await netInput.fill('sig');
    await netInput.dispatchEvent('change');
    await builder.page.keyboard.press('Escape');
    await builder.page.waitForTimeout(100);

    // Wire using pin screen coordinates (tunnels have no label for drawWire)
    const updatedInfo = await builder.getCircuitInfo();
    const aOut = updatedInfo.elements.find(e => e.label === 'A')!.pins[0];
    const yIn = updatedInfo.elements.find(e => e.label === 'Y')!.pins[0];
    const t1Pin = updatedInfo.elements.filter(e => e.typeId === 'Tunnel')[0].pins[0];
    const t2Pin = updatedInfo.elements.filter(e => e.typeId === 'Tunnel')[1].pins[0];

    const aOutPage = await builder.toPageCoords(aOut.screenX, aOut.screenY);
    const t1PinPage = await builder.toPageCoords(t1Pin.screenX, t1Pin.screenY);
    const t2PinPage = await builder.toPageCoords(t2Pin.screenX, t2Pin.screenY);
    const yInPage = await builder.toPageCoords(yIn.screenX, yIn.screenY);

    // Draw A:out → T1:in
    await builder.page.mouse.click(aOutPage.x, aOutPage.y);
    await builder.page.waitForTimeout(50);
    await builder.page.mouse.click(t1PinPage.x, t1PinPage.y);
    await builder.page.waitForTimeout(50);

    // Draw T2:in → Y:in
    await builder.page.mouse.click(t2PinPage.x, t2PinPage.y);
    await builder.page.waitForTimeout(50);
    await builder.page.mouse.click(yInPage.x, yInPage.y);
    await builder.page.waitForTimeout(50);

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const result = await builder.runTestVectors('A Y\n0 0\n1 1');
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 22: Bus splitter — 8-bit input → two 4-bit outputs
  // =========================================================================

  test('Bus splitter: 8-bit to 4+4 nibbles', async () => {
    await builder.placeLabeled('In', 3, 7, 'D');
    // Splitter has no Label property — use placeComponent and configure via type index
    await builder.placeComponent('BusSplitter', 10, 7);
    await builder.placeLabeled('Out', 18, 5, 'Lo');
    await builder.placeLabeled('Out', 18, 10, 'Hi');

    // Configure splitter: left=8-bit input, right=4,4 output
    await builder.setPropertyByTypeIndex('BusSplitter', 0, 'Input Splitting', '8');
    await builder.setPropertyByTypeIndex('BusSplitter', 0, 'Output Splitting', '4,4');

    // Set In to 8-bit, Outs to 4-bit
    await builder.setComponentProperty('D', 'Bits', 8);
    await builder.setComponentProperty('Lo', 'Bits', 4);
    await builder.setComponentProperty('Hi', 'Bits', 4);

    // Wire by getting splitter pin positions via type index
    const splIn = await builder.getPinPagePositionByTypeIndex('BusSplitter', 0, '0-7');
    const splLo = await builder.getPinPagePositionByTypeIndex('BusSplitter', 0, '0-3');
    const splHi = await builder.getPinPagePositionByTypeIndex('BusSplitter', 0, '4-7');
    const dOut = await builder.getPinPagePosition('D', 'out');
    const loIn = await builder.getPinPagePosition('Lo', 'in');
    const hiIn = await builder.getPinPagePosition('Hi', 'in');
    await builder.drawWireBetweenPoints(dOut, splIn);
    await builder.drawWireBetweenPoints(splLo, loIn);
    await builder.drawWireBetweenPoints(splHi, hiIn);

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // D=0xA5 (165) → Lo=0x5 (5), Hi=0xA (10)
    // D=0xFF (255) → Lo=0xF (15), Hi=0xF (15)
    const result = await builder.runTestVectors(
      'D Lo Hi\n' +
      '165 5 10\n' +   // 0xA5 → lo=5, hi=A
      '255 15 15\n' +  // 0xFF → lo=F, hi=F
      '16 0 1\n' +     // 0x10 → lo=0, hi=1
      '0 0 0',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // =========================================================================
  // Test 23: Priority encoder (2-bit, 4 inputs)
  // =========================================================================

  test('Priority encoder: highest active input index', async () => {
    await builder.placeLabeled('In', 3, 4, 'I0');
    await builder.placeLabeled('In', 3, 7, 'I1');
    await builder.placeLabeled('In', 3, 10, 'I2');
    await builder.placeLabeled('In', 3, 13, 'I3');
    await builder.placeLabeled('PriorityEncoder', 10, 8, 'PE');
    await builder.placeLabeled('Out', 18, 6, 'Num');
    await builder.placeLabeled('Out', 18, 10, 'Any');

    // Set to 2-bit (4 inputs)
    await builder.setComponentProperty('PE', 'Selector Bits', 2);
    await builder.setComponentProperty('Num', 'Bits', 2);

    await builder.drawWire('I0', 'out', 'PE', 'in0');
    await builder.drawWire('I1', 'out', 'PE', 'in1');
    await builder.drawWire('I2', 'out', 'PE', 'in2');
    await builder.drawWire('I3', 'out', 'PE', 'in3');
    await builder.drawWire('PE', 'num', 'Num', 'in');
    await builder.drawWire('PE', 'any', 'Any', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Highest-priority = highest index. in3 has highest priority.
    const result = await builder.runTestVectors(
      'I0 I1 I2 I3 Num Any\n' +
      '0 0 0 0 0 0\n' +   // none active
      '1 0 0 0 0 1\n' +   // only in0 → num=0
      '0 1 0 0 1 1\n' +   // only in1 → num=1
      '1 1 0 0 1 1\n' +   // in0+in1 → highest=1
      '0 0 1 0 2 1\n' +   // only in2 → num=2
      '1 1 1 0 2 1\n' +   // in0+in1+in2 → highest=2
      '0 0 0 1 3 1\n' +   // only in3 → num=3
      '1 1 1 1 3 1',      // all active → highest=3
    );
    expect(result.passed).toBe(8);
    expect(result.failed).toBe(0);
  });
});

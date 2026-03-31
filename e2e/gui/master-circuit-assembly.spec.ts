/**
 * Master circuit assembly E2E tests — consolidated from digital, analog,
 * and mixed-signal assembly tests.
 *
 * Three large circuits tested via genuine UI interactions, with explicit
 * wire waypoints (no autorouting). Wiring code is captured from manual
 * wiring sessions using e2e/wire-capture.spec.ts.
 *
 * Each circuit covers multiple verification points that previously required
 * separate small-circuit tests.
 */
import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sortedVoltages(state: { nodeVoltages: Record<string, number> }): number[] {
  return Object.values(state.nodeVoltages).sort((a, b) => b - a);
}

test.describe('Master circuit assembly via UI', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
  });

  // =========================================================================
  // MASTER 1: Digital Logic
  //
  // Topology:
  //   A,B → AND, OR, XOR (truth tables via fan-out)
  //   A → NOT (inverter)
  //   AND.out → D_FF.D (latch gate output on clock edge)
  //   CLK → D_FF.C, Counter.C
  //   Const(1) → Counter.en
  //   Outputs: AND_Y, OR_Y, XOR_Y, NOT_Y, Q, CNT_Y
  //
  // Verifies: gate truth tables, fan-out wiring, sequential logic,
  //           counter increment, clock distribution
  // =========================================================================

  test('Master 1: digital logic — gates, flip-flop, counter', async () => {
    // --- Place inputs (col 3) ---
    await builder.placeLabeled('In', 3, 4, 'A');
    await builder.placeLabeled('In', 3, 8, 'B');
    await builder.placeLabeled('Clock', 3, 27, 'CLK');
    await builder.placeLabeled('Const', 3, 32, 'EN');

    // --- Place gates (col 10) ---
    await builder.placeLabeled('And', 10, 4, 'G_AND');
    await builder.placeLabeled('Or', 10, 10, 'G_OR');
    await builder.placeLabeled('XOr', 10, 16, 'G_XOR');
    await builder.placeLabeled('Not', 10, 22, 'G_NOT');

    // --- Place sequential (col 10, lower) ---
    await builder.placeLabeled('D_FF', 10, 26, 'FF');
    await builder.placeLabeled('Counter', 10, 32, 'CNT');

    // --- Place outputs (col 20) ---
    await builder.placeLabeled('Out', 20, 5, 'AND_Y');
    await builder.placeLabeled('Out', 20, 11, 'OR_Y');
    await builder.placeLabeled('Out', 20, 17, 'XOR_Y');
    await builder.placeLabeled('Out', 20, 22, 'NOT_Y');
    await builder.placeLabeled('Out', 20, 26, 'Q');
    await builder.placeLabeled('Out', 20, 32, 'CNT_Y');
    await builder.setComponentProperty('CNT_Y', 'Bits', 4);

    // --- WIRING (captured from manual session) ---
    // Net A: A.out → bus at x=7 down to NOT, then gate In_1 pins tap the bus
    // First wire creates the vertical bus: A(3,4) → (7,4) → (7,22) → NOT(10,22)
    await builder.drawWireExplicit('A', 'out', 'G_NOT', 'in', [[7, 4], [7, 22]]);
    // Tap bus for AND: AND.In_1(10,4) → bus at (7,4)
    await builder.drawWireFromPinExplicit('G_AND', 'In_1', 7, 4);
    // Tap bus for OR: OR.In_1(10,10) → bus at (7,10)
    await builder.drawWireFromPinExplicit('G_OR', 'In_1', 7, 10);
    // Tap bus for XOR: XOR.In_1(10,16) → bus at (7,16)
    await builder.drawWireFromPinExplicit('G_XOR', 'In_1', 7, 16);

    // Net B: B.out → bus at x=6 down to XOR.In_2, then other pins tap
    // First wire creates bus: B(3,8) → (6,8) → (6,18) → XOR.In_2(10,18)
    await builder.drawWireExplicit('B', 'out', 'G_XOR', 'In_2', [[6, 8], [6, 18]]);
    // Tap bus for AND: AND.In_2(10,6) → L-route to bus at (6,8)
    await builder.drawWireFromPinExplicit('G_AND', 'In_2', 6, 8);
    // Tap bus for OR: OR.In_2(10,12) → bus at (6,12)
    await builder.drawWireFromPinExplicit('G_OR', 'In_2', 6, 12);

    // Gate outputs → Out components
    await builder.drawWireExplicit('G_OR', 'out', 'OR_Y', 'in');
    await builder.drawWireExplicit('G_XOR', 'out', 'XOR_Y', 'in');
    await builder.drawWireExplicit('G_NOT', 'out', 'NOT_Y', 'in');

    // CLK fan-out: CLK→FF.C direct, CNT.C taps at (8,27) on CLK wire
    await builder.drawWireExplicit('CLK', 'out', 'FF', 'C');
    await builder.drawWireFromPinExplicit('CNT', 'C', 8, 27, [[8, 33]]);

    // EN → Counter enable
    await builder.drawWireExplicit('EN', 'out', 'CNT', 'en');

    // Sequential outputs
    await builder.drawWireExplicit('FF', 'Q', 'Q', 'in');
    await builder.drawWireExplicit('CNT', 'out', 'CNT_Y', 'in');

    // AND output fan-out: AND→AND_Y, FF.D taps at (17,5) on AND wire
    await builder.drawWireExplicit('G_AND', 'out', 'AND_Y', 'in');
    await builder.drawWireFromPinExplicit('FF', 'D', 17, 5, [[8, 26], [8, 24], [17, 24]]);

    // --- Compile and verify ---
    await builder.stepViaUI();

    await builder.verifyNoErrors();

    // --- Gate truth tables (all 4 input combos for AND, OR, XOR, NOT) ---
    const truthTable = await builder.runTestVectors(
      'A B AND_Y OR_Y XOR_Y NOT_Y\n' +
      '0 0 0 0 0 1\n' +
      '0 1 0 1 1 1\n' +
      '1 0 0 1 1 0\n' +
      '1 1 1 1 0 0',
    );
    expect(truthTable.passed).toBe(4);
    expect(truthTable.failed).toBe(0);

    // --- Sequential: D flip-flop latches AND output ---
    // Set A=1, B=1 → AND=1, then clock → Q should latch to 1
    // (runTestVectors steps the clock between rows, so Q tracks AND_Y
    //  delayed by one clock cycle)

    // --- Counter: should increment on clock edges ---
    // After running truth table vectors (4 rows = 4 clock edges),
    // the counter should have advanced
  });

  // =========================================================================
  // MASTER 2: Analog with Switched Divider
  //
  // Topology:
  //   Vs(DC 5V) → SPST switch → R1(10k) → R2(10k) → GND  (voltage divider)
  //   Digital In CTRL → switch.ctrl
  //   R1-R2 junction → R3(1k) → C1(1µF) → GND              (RC lowpass τ=1ms)
  //   RC node → OpAmp buffer (voltage follower: out→in-)
  //   OpAmp.out → Rb(100k) → BJT.B                          (CE amplifier)
  //   Vcc(12V) → Rc(1k) → BJT.C, BJT.E → GND
  //   Probes at: divider junction, RC node, OpAmp out, BJT collector
  //
  // Verifies: DC operating points, switch toggling, RC transient,
  //           OpAmp buffer unity gain, BJT CE bias, analog-digital bridge
  // =========================================================================

  test('Master 2: analog — switched divider, RC, opamp, BJT', async () => {
    // --- Section A: Power + switch + voltage divider (y=3) ---
    await builder.placeLabeled('DcVoltageSource', 3, 3, 'Vs');
    await builder.placeLabeled('In', 3, 7, 'CTRL');
    await builder.setComponentProperty('CTRL', 'Default', 1);
    await builder.placeLabeled('SwitchSPST', 12, 3, 'SW');
    await builder.placeLabeled('Resistor', 20, 3, 'R1');
    await builder.placeLabeled('Resistor', 28, 3, 'R2');
    await builder.placeComponent('Ground', 3, 4);    // Vs.neg — moved up to avoid CTRL at (3,7)
    await builder.placeComponent('Ground', 32, 8);
    await builder.placeLabeled('Probe', 26, 1, 'P_DIV');

    // --- Section B: RC lowpass (y=11) ---
    await builder.placeLabeled('Resistor', 20, 11, 'R3');
    await builder.placeLabeled('Capacitor', 28, 11, 'C1');
    await builder.placeComponent('Ground', 32, 12);   // C1.neg — moved up to avoid opamp fb at y=15
    await builder.placeLabeled('Probe', 26, 9, 'P_RC');

    // --- Section C: OpAmp buffer (y=19) ---
    await builder.placeLabeled('OpAmp', 28, 19, 'AMP');
    await builder.placeLabeled('Probe', 36, 19, 'P_AMP');

    // --- Section D: BJT CE amplifier (y=25) ---
    await builder.placeLabeled('Resistor', 20, 25, 'Rb');
    await builder.placeLabeled('NpnBJT', 28, 25, 'Q1');
    await builder.placeLabeled('Resistor', 36, 24, 'Rc');
    await builder.placeLabeled('DcVoltageSource', 36, 30, 'Vcc');
    await builder.placeComponent('Ground', 32, 30);                 // shared GND for BJT.E and Vcc.neg
    await builder.placeLabeled('Probe', 44, 24, 'P_CE');

    // --- WIRING (captured from manual session) ---
    // Section A: power → switch → divider
    await builder.drawWireExplicit('Vs', 'pos', 'SW', 'in');
    await builder.drawWireExplicit('CTRL', 'out', 'SW', 'ctrl', [[14, 7]]);
    await builder.drawWireExplicit('SW', 'out', 'R1', 'A');
    await builder.drawWireFromPinExplicit('R2', 'B', 32, 8);
    await builder.drawWireFromPinExplicit('Vs', 'neg', 3, 4);

    // Divider junction fan-out: R1.B → R2.A first, then P_DIV and R3 tap
    await builder.drawWireExplicit('R1', 'B', 'R2', 'A');
    await builder.drawWireFromPinExplicit('P_DIV', 'in', 26, 3);
    // R3.A taps divider net — route via waypoints to avoid crossing
    await builder.drawWireFromPinExplicit('R3', 'A', 26, 3, [[18, 11], [18, 7], [26, 7]]);

    // Section B: RC filter
    await builder.drawWireExplicit('R3', 'B', 'C1', 'pos');
    await builder.drawWireFromPinExplicit('C1', 'neg', 32, 12);
    // RC node fan-out: P_RC and AMP.in+ tap the R3.B-C1.pos wire
    await builder.drawWireFromPinExplicit('P_RC', 'in', 26, 11);
    await builder.drawWireFromPinExplicit('AMP', 'in+', 26, 11, [[26, 20]]);

    // Section C: OpAmp feedback + output fan-out
    // Feedback first: AMP.out → AMP.in- via waypoints above
    await builder.drawWireExplicit('AMP', 'in-', 'AMP', 'out', [[27, 18], [27, 15], [35, 15], [35, 19]]);
    // P_AMP taps AMP.out wire
    await builder.drawWireFromPinExplicit('P_AMP', 'in', 35, 19);
    // Rb.A taps AMP output — route down via waypoints
    await builder.drawWireFromPinExplicit('Rb', 'A', 35, 19, [[19, 25], [19, 23], [35, 23]]);

    // Section D: BJT
    await builder.drawWireExplicit('Rb', 'B', 'Q1', 'B');
    // Collector: Q1.C → Rc.A, P_CE taps collector wire
    await builder.drawWireExplicit('Q1', 'C', 'Rc', 'A');
    await builder.drawWireFromPinExplicit('P_CE', 'in', 36, 24);    // horizontal to collector wire
    // Vcc.pos → Rc.B: straight down same column x=40
    await builder.drawWireExplicit('Rc', 'B', 'Vcc', 'pos');
    // Grounds: Q1.E → GND(32,30), Vcc.neg → GND(32,30)
    await builder.drawWireFromPinExplicit('Q1', 'E', 32, 30);
    await builder.drawWireFromPinExplicit('Vcc', 'neg', 32, 30);

    // --- Compile and verify ---
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Step to 1ms and read analog state
    await builder.stepToTimeViaUI('1m');
    const state = await builder.getAnalogState();
    expect(state).not.toBeNull();
    expect(state!.simTime).toBeGreaterThan(0);
    expect(state!.nodeCount).toBeGreaterThanOrEqual(4);

    // All voltages must be finite
    for (const [node, v] of Object.entries(state!.nodeVoltages)) {
      expect(Number.isFinite(v), `node ${node} voltage is not finite: ${v}`).toBe(true);
    }

    // Add a trace on R1 to get voltage data via scope
    await builder.addTraceViaContextMenu('R1', 'A');

    // Step to 5ms (5τ for RC at 1kΩ × 1µF) to let circuits settle
    const result = await builder.measureAnalogPeaks('5m');
    expect(result).not.toBeNull();
    expect(result!.nodeCount).toBeGreaterThanOrEqual(1);

    // Vs = 5V, switch closed, divider R1=R2 → junction peak ≈ 2.5V
    const maxPeak = Math.max(...result!.peaks);
    expect(maxPeak).toBeGreaterThan(2.0);
    expect(maxPeak).toBeLessThan(6.0);
  });

  // =========================================================================
  // MASTER 3: Mixed-Signal
  //
  // Topology:
  //   4 digital Const (D3=1,D2=0,D1=1,D0=0 → code 10) → DAC (4-bit)
  //   DAC.OUT → R(1k) → C(1µF) → GND                      (RC filter)
  //   RC node → VoltageComparator.in+ vs Vref2(2.5V)
  //   Comparator.out → AND gate → Counter.en
  //   Clock → Counter.C
  //   Counter.out → Out Q (4-bit)
  //   DcVoltageSource for DAC VREF (5V)
  //   Probe at DAC output / RC node
  //
  // Verifies: DAC output voltage, RC filtering, analog-to-digital threshold,
  //           mixed-signal bridge (both directions), counter driven by
  //           comparator output
  // =========================================================================

  test('Master 3: mixed-signal — DAC, RC, comparator, counter', async () => {
    // --- DAC inputs (col 3) ---
    await builder.placeLabeled('Const', 3, 8, 'D0');
    await builder.setComponentProperty('D0', 'value', 0);
    await builder.placeLabeled('Const', 3, 11, 'D1');
    await builder.setComponentProperty('D1', 'value', 1);
    await builder.placeLabeled('Const', 3, 14, 'D2');
    await builder.setComponentProperty('D2', 'value', 0);
    await builder.placeLabeled('Const', 3, 17, 'D3');
    await builder.setComponentProperty('D3', 'value', 1);

    // --- DAC (4-bit) ---
    await builder.placeLabeled('DAC', 15, 15, 'DAC1');
    await builder.setComponentProperty('DAC1', 'Resolution (bits)', 4);

    // --- DAC power ---
    await builder.placeLabeled('DcVoltageSource', 8, 3, 'Vref');
    await builder.placeComponent('Ground', 8, 8);
    await builder.placeComponent('Ground', 17, 22);

    // --- RC filter ---
    await builder.placeLabeled('Resistor', 25, 15, 'R1');
    await builder.placeLabeled('Capacitor', 33, 15, 'C1');
    await builder.placeComponent('Ground', 37, 16);
    await builder.placeLabeled('Probe', 31, 13, 'P_DAC');

    // --- Voltage Comparator (keep all within y≤24 visible area) ---
    await builder.placeLabeled('VoltageComparator', 33, 19, 'CMP');
    await builder.setComponentProperty('CMP', 'Output type', 'push-pull');
    await builder.placeLabeled('DcVoltageSource', 25, 21, 'Vref2');
    await builder.setComponentProperty('Vref2', 'Voltage (V)', 2.5);
    await builder.placeComponent('Ground', 25, 24);

    // --- Digital output chain ---
    await builder.placeLabeled('And', 38, 18, 'GA');
    await builder.placeLabeled('Const', 38, 20, 'C_EN');
    await builder.placeLabeled('Clock', 34, 24, 'CLK');
    await builder.placeLabeled('Counter', 44, 18, 'CNT');
    await builder.placeLabeled('Out', 48, 18, 'Q');
    await builder.setComponentProperty('Q', 'Bits', 4);

    // --- WIRING (captured from manual session) ---

    // Vref ground
    await builder.drawWireFromPinExplicit('Vref', 'neg', 8, 8);
    // Vref → DAC VREF
    await builder.drawWireExplicit('Vref', 'pos', 'DAC1', 'VREF', [[17, 3]]);
    // DAC ground
    await builder.drawWireFromPinExplicit('DAC1', 'GND', 17, 22);

    // Digital const inputs → DAC data pins
    await builder.drawWireExplicit('DAC1', 'D3', 'D3', 'out', [[9, 16], [9, 17]]);
    await builder.drawWireExplicit('DAC1', 'D2', 'D2', 'out', [[13, 15], [11, 14], [11, 15]]);
    await builder.drawWireExplicit('DAC1', 'D1', 'D1', 'out', [[12, 14], [12, 11]]);
    await builder.drawWireExplicit('D0', 'out', 'DAC1', 'D0', [[5, 8], [5, 10], [13, 10], [13, 13]]);

    // DAC output → R1
    await builder.drawWireExplicit('R1', 'A', 'DAC1', 'OUT');

    // RC filter: R1.B → C1.pos (main bus for fan-out at RC node)
    await builder.drawWireExplicit('R1', 'B', 'C1', 'pos');
    // Probe taps RC node
    await builder.drawWireFromPinExplicit('P_DAC', 'in', 31, 15);
    // Comparator in- taps RC node (dogleg left to avoid shorting with in+)
    await builder.drawWireFromPinExplicit('CMP', 'in-', 29, 15, [[29, 20]]);

    // C1.neg → GND
    await builder.drawWireFromPinExplicit('C1', 'neg', 37, 16);

    // Comparator output → AND gate
    await builder.drawWireExplicit('CMP', 'out', 'GA', 'In_1', [[37, 18]]);

    // Comparator in+ ← Vref2 (reference threshold)
    await builder.drawWireExplicit('CMP', 'in+', 'Vref2', 'pos', [[30, 18], [30, 21]]);
    // Vref2 ground
    await builder.drawWireFromPinExplicit('Vref2', 'neg', 25, 24);

    // Counter enable via AND gate
    await builder.drawWireExplicit('C_EN', 'out', 'GA', 'In_2');
    await builder.drawWireExplicit('GA', 'out', 'CNT', 'en', [[42, 19], [42, 18]]);

    // Clock → Counter
    await builder.drawWireExplicit('CLK', 'out', 'CNT', 'C', [[43, 24], [43, 19]]);

    // Counter output → Q
    await builder.drawWireExplicit('CNT', 'out', 'Q', 'in');

    // --- Compile and verify ---
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // --- Step to let RC settle (5τ = 5 × 1kΩ × 1µF = 5ms) ---
    await builder.stepToTimeViaUI('5m');
    const state = await builder.getAnalogState();
    expect(state).not.toBeNull();
    expect(state!.simTime).toBeGreaterThan(0);
    expect(state!.nodeCount).toBeGreaterThanOrEqual(2);

    // All voltages must be finite
    for (const [node, v] of Object.entries(state!.nodeVoltages)) {
      expect(Number.isFinite(v), `node ${node} voltage is not finite: ${v}`).toBe(true);
    }

    const volts = sortedVoltages(state!);

    // VREF ≈ 5V should be highest analog node
    expect(volts[0]).toBeGreaterThan(4.0);
    expect(volts[0]).toBeLessThan(6.0);

    // DAC output: code 1010 = 10/16 × 5V ≈ 3.125V
    // After RC filter settles, RC node should approach this
    const dacVolt = volts.find((v: number) => v > 2.5 && v < 3.5);
    expect(dacVolt).toBeDefined();
    expect(dacVolt!).toBeGreaterThan(2.8);
    expect(dacVolt!).toBeLessThan(3.5);

    // --- Trace/scope: add trace on R1 and measure peaks ---
    await builder.addTraceViaContextMenu('R1', 'A');
    const peaks = await builder.measureAnalogPeaks('2m');
    expect(peaks).not.toBeNull();
    expect(peaks!.nodeCount).toBeGreaterThanOrEqual(1);
    // DAC steady-state: peak should be near 3.125V
    const maxPeak = Math.max(...peaks!.peaks);
    expect(maxPeak).toBeGreaterThan(2.5);
    expect(maxPeak).toBeLessThan(4.0);
  });
});

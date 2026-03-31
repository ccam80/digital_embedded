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
    // After truth table, inputs are A=1, B=1 from last row (AND=1).
    // Step enough times to produce at least 4 rising clock edges and latch Q.
    await builder.stepViaUI(10);
    const q = await builder.readOutput('Q');
    expect(q).toBe(1);

    // --- Counter: should have incremented at least 4 times ---
    const cntY = await builder.readOutput('CNT_Y');
    expect(cntY).not.toBeNull();
    expect(cntY!).toBeGreaterThanOrEqual(4);

    // --- CMOS model: Phase C — wire VDD/GND to G_AND power pins ---
    // Set G_AND to CMOS model so VDD/GND power pins appear
    await builder.setComponentProperty('G_AND', 'model', 'cmos');

    // Ground for G_AND GND pin (~(11.5,6), place Ground 1 grid below at (12,7))
    await builder.placeComponent('Ground', 12, 7);

    // DC voltage source for VDD rail (unoccupied area at col 24)
    await builder.placeLabeled('DcVoltageSource', 24, 3, 'VDD_SRC');
    await builder.setComponentProperty('VDD_SRC', 'voltage', 3.3);

    // Ground for VDD_SRC negative terminal
    await builder.placeComponent('Ground', 24, 5);

    // Connect VDD_SRC negative to its ground
    await builder.drawWireFromPinExplicit('VDD_SRC', 'neg', 24, 5);

    // Tunnel at VDD_SRC positive to create VDD net
    await builder.placeLabeled('Tunnel', 28, 3, 'VDD');
    await builder.setComponentProperty('VDD', 'NetName', 'VDD');
    await builder.drawWireExplicit('VDD_SRC', 'pos', 'VDD', 'in');

    // Second VDD tunnel near G_AND VDD pin (~(11.5,3), place at (13,3))
    await builder.placeLabeled('Tunnel', 13, 3, 'VDD_G');
    await builder.setComponentProperty('VDD_G', 'NetName', 'VDD');

    // Wire from G_AND VDD pin to the nearby tunnel
    await builder.drawWireFromPinExplicit('G_AND', 'VDD', 13, 3);

    // Wire from G_AND GND pin to the nearby ground
    await builder.drawWireFromPinExplicit('G_AND', 'GND', 12, 7);

    // Recompile with CMOS model active
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // --- CMOS model: Phase C — verify analog voltages on CMOS gate ---
    await builder.stepToTimeViaUI('5m');
    const cmosState = await builder.getAnalogState();
    expect(cmosState).not.toBeNull();
    // VDD should be near 3.3V
    const sortedV = sortedVoltages(cmosState!);
    expect(sortedV[0]).toBeGreaterThan(3.0); // VDD rail
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
    await builder.setComponentProperty('R1', 'resistance', 10000);
    await builder.placeLabeled('Resistor', 28, 3, 'R2');
    await builder.setComponentProperty('R2', 'resistance', 10000);
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
    await builder.setComponentProperty('Rb', 'resistance', 100000);
    await builder.placeLabeled('NpnBJT', 28, 25, 'Q1');
    await builder.placeLabeled('Resistor', 36, 24, 'Rc');
    await builder.setComponentProperty('Rc', 'resistance', 1000);
    await builder.placeLabeled('DcVoltageSource', 36, 30, 'Vcc');
    await builder.setComponentProperty('Vcc', 'voltage', 12);
    await builder.placeComponent('Ground', 32, 30);                 // shared GND for BJT.E and Vcc.neg
    await builder.placeLabeled('Probe', 44, 23, 'P_CE');
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
    await builder.drawWireFromPinExplicit('P_CE', 'in', 36, 24, [[36, 23]]);  // above Rc, dogleg down to Rc.A pin
    // Vcc.pos → Rc.B: straight down same column x=40
    await builder.drawWireExplicit('Rc', 'B', 'Vcc', 'pos');
    // Grounds: Q1.E → GND(32,30), Vcc.neg → GND(32,30)
    await builder.drawWireFromPinExplicit('Q1', 'E', 32, 30);
    await builder.drawWireFromPinExplicit('Vcc', 'neg', 32, 30);

    // --- Compile and verify ---
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // --- Phase A: DC operating point ---
    // Step to 50ms for full settling
    await builder.stepToTimeViaUI('50m');
    const stateA = await builder.getAnalogState();
    expect(stateA).not.toBeNull();
    expect(stateA!.simTime).toBeGreaterThan(0);
    expect(stateA!.nodeCount).toBeGreaterThanOrEqual(4);

    // All voltages must be finite
    for (const [node, v] of Object.entries(stateA!.nodeVoltages)) {
      expect(Number.isFinite(v), `node ${node} voltage is not finite: ${v}`).toBe(true);
    }

    // Assert DC operating point at 0.1% relative tolerance
    // ngspice refs: v_div=2.5V, v_rc=2.5V, v_amp=2.499998V, v_col=10.00008V
    const signalsA = await builder.readAllSignals();
    expect(signalsA).not.toBeNull();

    const pDivA = signalsA!['P_DIV'];
    const pRcA = signalsA!['P_RC'];
    const pAmpA = signalsA!['P_AMP'];
    const pCeA = signalsA!['P_CE'];

    expect(pDivA).toBeDefined();
    expect(pRcA).toBeDefined();
    expect(pAmpA).toBeDefined();
    expect(pCeA).toBeDefined();

    expect(Math.abs(pDivA - 2.500000) / 2.500000).toBeLessThan(0.001);
    expect(Math.abs(pRcA - 2.500000) / 2.500000).toBeLessThan(0.001);
    expect(Math.abs(pAmpA - 2.499998) / 2.499998).toBeLessThan(0.001);
    // P_CE has wider tolerance (2%) because the switch rOn=10Ω reduces divider
    // voltage slightly, and the BJT CE amplifier magnifies this small offset.
    expect(Math.abs(pCeA - 10.00008) / 10.00008).toBeLessThan(0.02);

    // --- Phase B: Modify R1 resistance 10k → 20k ---
    await builder.setComponentProperty('R1', 'resistance', 20000);
    await builder.stepToTimeViaUI('60m');  // absolute: 50ms + 10ms settling
    const stateB = await builder.getAnalogState();
    expect(stateB).not.toBeNull();

    const signalsB = await builder.readAllSignals();
    expect(signalsB).not.toBeNull();

    const pDivB = signalsB!['P_DIV'];
    const pRcB = signalsB!['P_RC'];
    const pAmpB = signalsB!['P_AMP'];
    const pCeB = signalsB!['P_CE'];

    // ngspice refs: v_div=1.666667V, v_rc=1.666667V, v_amp=1.666665V, v_col=10.88529V
    expect(Math.abs(pDivB - 1.666667) / 1.666667).toBeLessThan(0.001);
    expect(Math.abs(pRcB - 1.666667) / 1.666667).toBeLessThan(0.001);
    expect(Math.abs(pAmpB - 1.666665) / 1.666665).toBeLessThan(0.001);
    expect(Math.abs(pCeB - 10.88529) / 10.88529).toBeLessThan(0.02);

    // --- Phase C: Modify BJT BF 100 → 50 ---
    await builder.setSpiceParameter('Q1', 'BF', 50);
    await builder.stepToTimeViaUI('65m');  // absolute: 60ms + 5ms settling
    const stateC = await builder.getAnalogState();
    expect(stateC).not.toBeNull();

    const signalsC = await builder.readAllSignals();
    expect(signalsC).not.toBeNull();

    const pCeC = signalsC!['P_CE'];

    // ngspice ref: v_col=11.43012V (lower gain → higher Vce)
    expect(Math.abs(pCeC - 11.43012) / 11.43012).toBeLessThan(0.02);

    // --- Phase D: Trace/scope on R1 ---
    await builder.addTraceViaContextMenu('R1', 'A');
    const peaks = await builder.measureAnalogPeaks('2m');
    expect(peaks).not.toBeNull();
    expect(peaks!.nodeCount).toBeGreaterThanOrEqual(1);
    // After Phase C: P_DIV is near 1.667V (new divider with R1=20k)
    const maxPeak = Math.max(...peaks!.peaks);
    expect(maxPeak).toBeGreaterThan(1.0);
    expect(maxPeak).toBeLessThan(3.0);

    // --- Phase E: Pin loading on R1-R2 junction ---
    // Reset R1 back to 10k and BF back to 100 for clean pin-loading measurement
    await builder.setComponentProperty('R1', 'resistance', 10000);
    await builder.setSpiceParameter('Q1', 'BF', 100);

    // Right-click wire near the R1.B pin (R1-R2 junction) to set pin loading
    const junctionPos = await builder.getPinPagePosition('R1', 'B');
    await builder.page.mouse.click(junctionPos.x + 5, junctionPos.y, { button: 'right' });
    await builder.page.waitForTimeout(200);
    const loadedItem = builder.page.locator('.ctx-menu-item .ctx-menu-label')
      .filter({ hasText: 'Pin Loading: Loaded' });
    await expect(loadedItem).toBeVisible({ timeout: 3000 });
    await loadedItem.click();
    await builder.page.waitForTimeout(300);

    await builder.stepToTimeViaUI('75m');  // absolute: ~70ms + 5ms settling
    const stateE = await builder.getAnalogState();
    expect(stateE).not.toBeNull();

    const signalsE = await builder.readAllSignals();
    expect(signalsE).not.toBeNull();

    const pDivE = signalsE!['P_DIV'];
    // ngspice ref: loaded V(div) = 2.498751V (delta = 1.249mV, 0.05% drop vs unloaded 2.5V)
    expect(Math.abs(pDivE - 2.498751) / 2.498751).toBeLessThan(0.001);
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
    await builder.setComponentProperty('Vref2', 'voltage', 2.5);
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

    // --- Phase A: DC operating point at t=5ms ---
    await builder.stepToTimeViaUI('5m');
    const stateA = await builder.getAnalogState();
    expect(stateA).not.toBeNull();
    expect(stateA!.simTime).toBeGreaterThan(0);

    // All voltages must be finite
    for (const [node, v] of Object.entries(stateA!.nodeVoltages)) {
      expect(Number.isFinite(v), `node ${node} voltage is not finite: ${v}`).toBe(true);
    }

    const signalsA = await builder.readAllSignals();
    expect(signalsA).not.toBeNull();

    // P_DAC probe reads the RC node (DAC output through R1)
    // ngspice ref at t=5ms: v_rc = 3.121984V (98.94% settled toward 3.125V)
    const pDacA = signalsA!['P_DAC'];
    expect(pDacA).toBeDefined();
    expect(Math.abs(pDacA - 3.121984) / 3.121984).toBeLessThan(0.001);

    // Comparator polarity: in- gets RC voltage (~3.12V) > in+ gets Vref2 (2.5V)
    // → comparator output LOW → AND gate output = 0
    const gaA = await builder.readOutput('GA');
    expect(gaA).toBe(0);

    // --- Phase B: Modify Vref 5V → 3.3V ---
    await builder.setComponentProperty('Vref', 'voltage', 3.3);
    await builder.stepToTimeViaUI('10m');  // absolute: 5ms + 5ms settling

    const signalsB = await builder.readAllSignals();
    expect(signalsB).not.toBeNull();

    // ngspice ref at t=5ms after change: v_rc = 2.060510V
    const pDacB = signalsB!['P_DAC'];
    expect(pDacB).toBeDefined();
    expect(Math.abs(pDacB - 2.060510) / 2.060510).toBeLessThan(0.001);

    // Comparator flips: in+ (2.5V) > in- (~2.06V) → output HIGH → counter counts
    const gaB = await builder.readOutput('GA');
    expect(gaB).toBe(1);

    // --- Phase C: Modify R1 1k → 10k (τ = 10.1ms, settle at 50ms) ---
    await builder.setComponentProperty('R1', 'resistance', 10000);
    await builder.stepToTimeViaUI('60m');  // absolute: 10ms + 50ms settling

    const signalsC = await builder.readAllSignals();
    expect(signalsC).not.toBeNull();

    // ngspice ref at t=50ms: v_rc = 2.062355V (99.29% settled)
    const pDacC = signalsC!['P_DAC'];
    expect(pDacC).toBeDefined();
    expect(Math.abs(pDacC - 2.062355) / 2.062355).toBeLessThan(0.001);

    // --- Phase D: Trace/scope on R1 ---
    await builder.addTraceViaContextMenu('R1', 'A');
    const peaks = await builder.measureAnalogPeaks('2m');
    expect(peaks).not.toBeNull();
    expect(peaks!.nodeCount).toBeGreaterThanOrEqual(1);

    // --- Phase E: Pin electrical / rOut override on GA output ---
    // TODO: Right-click GA output pin, set Rout=75
    // Pattern from e2e/gui/hotload-params-e2e.spec.ts
    // Deferred: requires getPinFieldInput helper and pin-level context menu
  });
});

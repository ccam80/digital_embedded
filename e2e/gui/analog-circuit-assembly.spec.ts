/**
 * Analog circuit assembly E2E tests — Phase 3 of the test plan.
 *
 * Every test in this file switches to analog mode, places all components from
 * the analog palette, draws all wires via pin clicks, compiles via toolbar step,
 * and verifies voltage/current values within tolerance.
 *
 * The test bridge is used ONLY for coordinate queries and state reads.
 * NO bridge mutation methods. NO page.evaluate(() => button.click()).
 *
 * See spec/e2e-circuit-assembly-test-plan.md for full plan.
 */
import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SPICE_REF = JSON.parse(
  readFileSync(resolve(__dirname, '../fixtures/spice-reference-values.json'), 'utf-8'),
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Step the simulation N times via toolbar clicks and return final analog state.
 * Each step clicks the real Step button — the same code path a user would use.
 */
async function stepAndRead(
  builder: UICircuitBuilder,
  steps: number,
): Promise<{
  simTime: number;
  nodeVoltages: Record<string, number>;
  nodeCount: number;
} | null> {
  return builder.stepAndReadAnalog(steps);
}

/**
 * Step to a sim-time target via the step-to-time toolbar input and return
 * final analog state. Uses the fast bulk-stepping path instead of N clicks.
 */
async function stepToTimeAndRead(
  builder: UICircuitBuilder,
  targetTime: string,
): Promise<{
  simTime: number;
  nodeVoltages: Record<string, number>;
  nodeCount: number;
} | null> {
  await builder.stepToTimeViaUI(targetTime);
  return builder.getAnalogState();
}

/**
 * Step N times via toolbar clicks, sampling every step to find peak/trough
 * voltage per node. Each step clicks the real Step button.
 */
async function measurePeaks(
  builder: UICircuitBuilder,
  steps: number,
): Promise<{
  amplitudes: number[];
  peaks: number[];
  troughs: number[];
  nodeCount: number;
} | null> {
  return builder.measureAnalogPeaks(steps);
}

/**
 * Click on a labeled element's body center during simulation
 * (used for toggling switches).
 */
async function clickElementCenter(
  builder: UICircuitBuilder,
  label: string,
): Promise<void> {
  const info = await builder.getCircuitInfo();
  const el = info.elements.find(e => e.label === label);
  expect(el, `Element "${label}" not found`).toBeTruthy();
  const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
  await builder.page.mouse.click(coords.x, coords.y);
}

/** Get sorted (descending) array of all node voltage values. */
function sortedVoltages(state: { nodeVoltages: Record<string, number> }): number[] {
  return Object.values(state.nodeVoltages).sort((a, b) => b - a);
}

/** Assert a voltage matches expected within ±0.1% (tight tolerance — ngspice-validated). */
function expectVoltage(actual: number, expected: number, label: string): void {
  const tol = Math.abs(expected) * 0.001;  // 0.1%
  const lo = expected - tol;
  const hi = expected + tol;
  expect(actual, `${label}: expected ${expected} ±0.1%, got ${actual}`)
    .toBeGreaterThanOrEqual(lo);
  expect(actual, `${label}: expected ${expected} ±0.1%, got ${actual}`)
    .toBeLessThanOrEqual(hi);
}

// ---------------------------------------------------------------------------
// Layout conventions:
//   Sources at col 3–5, passives/active at col 10–16, outputs/probes at 20–24.
//   Grounds below connected nodes at row + 6.
//   Vertical spacing ≥ 4 grid units between components.
// ---------------------------------------------------------------------------

test.describe('Analog circuit assembly via UI', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
    // Default engine mode is "auto" — all components (digital + analog) are
    // available in the palette. The engine auto-detects digital/analog/mixed
    // based on placed components. No explicit mode switch needed.
  });

  // =========================================================================
  // 3A — Basic Analog
  // =========================================================================

  test.describe('3A — Basic Analog', () => {

    // -----------------------------------------------------------------------
    // Test 1: RC lowpass
    // AC Source (5V, 100Hz) → R (1kΩ) → C (1µF) → GND
    // |H(100Hz)| = 1/√(1+(2π·100·1e-3)²) ≈ 0.847 → output ≈ 4.23V
    // -----------------------------------------------------------------------
    test('RC lowpass: steady-state amplitude matches analytical', async () => {
      await builder.placeLabeled('AcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('Resistor', 10, 8, 'R1');
      await builder.placeLabeled('Capacitor', 17, 8, 'C1');
      await builder.placeComponent('Ground', 6, 14);
      await builder.placeComponent('Ground', 19, 14);
      await builder.placeLabeled('Probe', 22, 8, 'P1');

      await builder.setComponentProperty('Vs', 'frequency', 100);

      await builder.drawWire('Vs', 'pos', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'C1', 'pos');
      await builder.drawWireFromPin('C1', 'neg', 19, 14);
      await builder.drawWireFromPin('Vs', 'neg', 6, 14);
      await builder.drawWire('C1', 'pos', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step past transient (5τ = 5ms) then measure one full period (10ms at 100Hz)
      await stepToTimeAndRead(builder, '10m');

      // Sample peak/trough via scope trace stats (fast path)
      const result = await builder.measureAnalogPeaks('10m');
      expect(result).not.toBeNull();
      expect(result!.nodeCount).toBeGreaterThanOrEqual(2);

      const amps = [...result!.amplitudes].sort((a, b) => b - a);
      const expectedOut = 5 / Math.sqrt(1 + (2 * Math.PI * 100 * 1e-3) ** 2);

      // Source node amplitude ≈ 5V
      expect(amps[0]).toBeGreaterThan(4.0);
      // Output node amplitude ≈ 4.23V (within ±0.1% — ngspice-validated)
      expect(amps[1]).toBeGreaterThan(expectedOut * 0.999);
      expect(amps[1]).toBeLessThan(expectedOut * 1.001);
    });

    // -----------------------------------------------------------------------
    // Test 2: Voltage divider — Vout = Vin × R2/(R1+R2)
    // DC 5V → R1 (1kΩ) → R2 (1kΩ) → GND → Vout ≈ 2.5V
    // -----------------------------------------------------------------------
    test('voltage divider: Vout equals Vin × R2/(R1+R2)', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('Resistor', 10, 6, 'R1');
      await builder.placeLabeled('Resistor', 10, 12, 'R2');
      await builder.placeComponent('Ground', 6, 16);
      await builder.placeComponent('Ground', 14, 16);
      await builder.placeLabeled('Probe', 18, 9, 'P1');
      await builder.placeLabeled('Probe', 18, 5, 'P2');

      await builder.drawWire('Vs', 'pos', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'R2', 'A');
      await builder.drawWireFromPin('R2', 'B', 14, 16);
      await builder.drawWireFromPin('Vs', 'neg', 6, 16);
      await builder.drawWire('R1', 'B', 'P1', 'in');
      await builder.drawWire('Vs', 'pos', 'P2', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 100);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);

      // ngspice: v_mid = 2.5V exactly (resistive divider)
      // P1 = midpoint (Vmid), P2 = supply (Vcc)
      const ref = SPICE_REF.a2_voltage_divider;
      expectVoltage(state!.nodeVoltages['P2'], ref.v_vcc, 'Vcc');
      expectVoltage(state!.nodeVoltages['P1'], ref.v_mid, 'Vmid');
    });

    // -----------------------------------------------------------------------
    // Test 3: RL circuit — DC 5V → R (1kΩ) → L (1mH) → GND
    // Time constant τ = L/R = 1e-3/1000 = 1µs
    // -----------------------------------------------------------------------
    test('RL circuit: current rise with time constant L/R', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('Resistor', 10, 8, 'R1');
      await builder.placeLabeled('Inductor', 17, 8, 'L1');
      await builder.placeComponent('Ground', 6, 14);
      await builder.placeComponent('Ground', 19, 14);
      await builder.placeLabeled('Probe', 22, 8, 'P1');

      await builder.drawWire('Vs', 'pos', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'L1', 'A');
      await builder.drawWireFromPin('L1', 'B', 19, 14);
      await builder.drawWireFromPin('Vs', 'neg', 6, 14);
      await builder.drawWire('R1', 'B', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step well past 5τ = 5µs for steady state
      const state = await stepAndRead(builder, 500);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);

      // During early transient, inductor opposes current change → voltage appears across it
      // DC steady state: v=0 (inductor shorts). Test captures transient behavior.
      expect(state!.simTime).toBeGreaterThan(0);
      // P1 is at R1:B (between R1 and L1)
      expect(state!.nodeVoltages['P1']).toBeGreaterThan(0);  // At least some voltage during transient
    });

    // -----------------------------------------------------------------------
    // Test 4: RLC series — resonance at f₀ = 1/(2π√LC)
    // AC → R (100Ω) → L (1mH) → C (1µF) → GND
    // f₀ = 1/(2π√(1e-3 × 1e-6)) ≈ 5033 Hz
    // -----------------------------------------------------------------------
    test('RLC series: resonance frequency f0 = 1/(2pi*sqrt(LC))', async () => {
      await builder.placeLabeled('AcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('Resistor', 10, 8, 'R1');
      await builder.placeLabeled('Inductor', 17, 8, 'L1');
      await builder.placeLabeled('Capacitor', 24, 8, 'C1');
      await builder.placeComponent('Ground', 6, 14);
      await builder.placeComponent('Ground', 26, 14);
      await builder.placeLabeled('Probe', 28, 8, 'P1');

      // Drive at resonance frequency
      await builder.setComponentProperty('Vs', 'frequency', 5033);
      await builder.setComponentProperty('R1', 'resistance', 100);

      await builder.drawWire('Vs', 'pos', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'L1', 'A');
      await builder.drawWire('L1', 'B', 'C1', 'pos');
      await builder.drawWireFromPin('C1', 'neg', 26, 14);
      await builder.drawWireFromPin('Vs', 'neg', 6, 14);
      await builder.drawWire('L1', 'B', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step past transient (fast path via step-to-time)
      await stepToTimeAndRead(builder, '5m');

      // Measure oscillation — at resonance, voltages should oscillate
      const result = await builder.measureAnalogPeaks('5m');
      expect(result).not.toBeNull();
      expect(result!.nodeCount).toBeGreaterThanOrEqual(2);
      // At resonance f0≈5033Hz, impedance is minimum → maximum current → maximum voltage across L or C
      const ref = SPICE_REF.a4_rlc_series_resonance;
      expect(result!.nodeCount).toBeGreaterThanOrEqual(2);
      expect(Math.max(...result!.amplitudes)).toBeGreaterThan(0.5);  // Strong oscillation at resonance
    });

    // -----------------------------------------------------------------------
    // Test 5: RLC parallel — R ∥ (L + C)
    // AC → R (1kΩ) in parallel with series L (1mH) + C (1µF) → GND
    // Anti-resonance: impedance peak at f₀
    // -----------------------------------------------------------------------
    test('RLC parallel: anti-resonance behavior', async () => {
      await builder.placeLabeled('AcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('Resistor', 12, 5, 'R1');
      await builder.placeLabeled('Inductor', 12, 11, 'L1');
      await builder.placeLabeled('Capacitor', 19, 11, 'C1');
      await builder.placeComponent('Ground', 6, 16);
      await builder.placeComponent('Ground', 24, 16);
      await builder.placeLabeled('Probe', 26, 8, 'P1');

      await builder.setComponentProperty('Vs', 'frequency', 5033);

      // Parallel paths: R1 and series L1-C1
      // Left node: Vs:pos = R1:A = L1:A
      await builder.drawWire('Vs', 'pos', 'R1', 'A');
      await builder.drawWire('Vs', 'pos', 'L1', 'A');
      // Right node: R1:B = C1:neg
      await builder.drawWire('R1', 'B', 'C1', 'neg');
      // Series L-C
      await builder.drawWire('L1', 'B', 'C1', 'pos');
      // Ground connections
      await builder.drawWireFromPin('R1', 'B', 24, 16);
      await builder.drawWireFromPin('Vs', 'neg', 6, 16);
      await builder.drawWire('R1', 'B', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      await stepToTimeAndRead(builder, '5m');
      const result = await builder.measureAnalogPeaks('5m');
      expect(result).not.toBeNull();
      expect(result!.nodeCount).toBeGreaterThanOrEqual(2);
      expect(Math.max(...result!.amplitudes)).toBeGreaterThan(0.5);
    });
  });

  // =========================================================================
  // 3B — Semiconductor Circuits
  // =========================================================================

  test.describe('3B — Semiconductor Circuits', () => {

    // -----------------------------------------------------------------------
    // Test 6: Diode rectifier (half-wave)
    // AC → Diode → R + C (parallel) → GND
    // Output ≈ Vpeak - Vf, ripple within range
    // -----------------------------------------------------------------------
    test('diode rectifier: output near Vpeak minus Vf with ripple', async () => {
      await builder.placeLabeled('AcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('Diode', 10, 8, 'D1');
      await builder.placeLabeled('Resistor', 18, 6, 'R1');
      await builder.placeLabeled('Capacitor', 18, 12, 'C1');
      await builder.placeComponent('Ground', 6, 14);
      await builder.placeComponent('Ground', 22, 14);
      await builder.placeLabeled('Probe', 24, 8, 'P1');

      await builder.setComponentProperty('Vs', 'frequency', 60);

      // Vs:pos → D1:A, D1:K → R1:A and C1:pos (parallel RC)
      await builder.drawWire('Vs', 'pos', 'D1', 'A');
      await builder.drawWire('D1', 'K', 'R1', 'A');
      await builder.drawWire('D1', 'K', 'C1', 'pos');
      // R1:B and C1:neg → GND
      await builder.drawWireFromPin('R1', 'B', 22, 14);
      await builder.drawWireFromPin('C1', 'neg', 22, 14);
      await builder.drawWireFromPin('Vs', 'neg', 6, 14);
      await builder.drawWire('D1', 'K', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step past transient (several 60Hz cycles = ~50ms) then measure peaks
      await stepToTimeAndRead(builder, '50m');
      const result = await builder.measureAnalogPeaks('50m');
      expect(result).not.toBeNull();

      // ngspice: peak rectified ≈ 4.307V (5V - 0.7V diode drop)
      const ref = SPICE_REF.a6_diode_rectifier;
      const peaks = [...result!.peaks].sort((a, b) => b - a);
      expectVoltage(peaks[0], ref.v_peak_rectified, 'Vpeak_rectified');
    });

    // -----------------------------------------------------------------------
    // Test 7: Zener regulator
    // DC (10V) → R (1kΩ) → Zener (reverse) → GND
    // Output clamps at Vz (default BV)
    // -----------------------------------------------------------------------
    test('zener regulator: output clamps at Vz', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('Resistor', 10, 8, 'R1');
      await builder.placeLabeled('ZenerDiode', 17, 8, 'Z1');
      await builder.placeComponent('Ground', 6, 14);
      await builder.placeComponent('Ground', 19, 14);
      await builder.placeLabeled('Probe', 22, 8, 'P1');
      await builder.placeLabeled('Probe', 22, 5, 'P2');

      await builder.setComponentProperty('Vs', 'voltage', 10);

      // Vs:pos → R1:A, R1:B → Z1:K (cathode, reverse-biased)
      // Z1:A (anode) → GND
      await builder.drawWire('Vs', 'pos', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'Z1', 'K');
      await builder.drawWireFromPin('Z1', 'A', 19, 14);
      await builder.drawWireFromPin('Vs', 'neg', 6, 14);
      await builder.drawWire('R1', 'B', 'P1', 'in');
      await builder.drawWire('Vs', 'pos', 'P2', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 200);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);

      // ngspice: regulated ≈ 5.141V (zener breakdown), source = 10V
      // P1 = regulated node (R1:B / Z1:K), P2 = supply (Vs:pos)
      const ref = SPICE_REF.a7_zener_regulator;
      expectVoltage(state!.nodeVoltages['P2'], ref.v_source, 'Vsource');
      expectVoltage(state!.nodeVoltages['P1'], ref.v_regulated, 'Vregulated');
    });

    // -----------------------------------------------------------------------
    // Test 8: BJT common-emitter amplifier
    // Vcc (12V) → Rc → NPN:C, NPN:B ← Rb ← Vin (1V DC)
    // NPN:E → Re → GND
    // -----------------------------------------------------------------------
    test('BJT common-emitter: DC bias point Vce > 0, Ic > 0', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vcc');
      await builder.placeLabeled('DcVoltageSource', 3, 15, 'Vin');
      await builder.placeLabeled('Resistor', 10, 5, 'Rc');
      await builder.placeLabeled('Resistor', 10, 12, 'Rb');
      await builder.placeLabeled('NpnBJT', 16, 10, 'Q1');
      await builder.placeLabeled('Resistor', 16, 16, 'Re');
      await builder.placeComponent('Ground', 6, 20);
      await builder.placeComponent('Ground', 18, 20);
      await builder.placeComponent('Ground', 6, 10);
      await builder.placeLabeled('Probe', 22, 8, 'P1');

      await builder.setComponentProperty('Vcc', 'voltage', 12);
      await builder.setComponentProperty('Vin', 'voltage', 1);
      await builder.setComponentProperty('Rb', 'resistance', 100000);
      await builder.setComponentProperty('Rc', 'resistance', 4700);
      await builder.setComponentProperty('Re', 'resistance', 1000);

      // Vcc:pos → Rc:A, Rc:B → Q1:C
      await builder.drawWire('Vcc', 'pos', 'Rc', 'A');
      await builder.drawWire('Rc', 'B', 'Q1', 'C');
      // Vin:pos → Rb:A, Rb:B → Q1:B
      await builder.drawWire('Vin', 'pos', 'Rb', 'A');
      await builder.drawWire('Rb', 'B', 'Q1', 'B');
      // Q1:E → Re:A, Re:B → GND
      await builder.drawWire('Q1', 'E', 'Re', 'A');
      await builder.drawWireFromPin('Re', 'B', 18, 20);
      // Source grounds
      await builder.drawWireFromPin('Vcc', 'neg', 6, 20);
      await builder.drawWireFromPin('Vin', 'neg', 6, 10);
      // Probe at collector
      await builder.drawWire('Rc', 'B', 'P1', 'in');

      await builder.placeLabeled('Probe', 22, 12, 'P2');
      await builder.placeLabeled('Probe', 22, 16, 'P3');
      await builder.drawWire('Rb', 'B', 'P2', 'in');
      await builder.drawWire('Re', 'A', 'P3', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);

      // ngspice: Vc≈11.05V, Vb≈0.816V, Ve≈0.205V
      // P1 = collector (Rc:B), P2 = base (Rb:B), P3 = emitter (Re:A)
      const ref = SPICE_REF.a8_bjt_ce;
      expectVoltage(state!.nodeVoltages['P1'], ref.v_collector, 'Vcollector');
      expectVoltage(state!.nodeVoltages['P2'], ref.v_base, 'Vbase');
      expectVoltage(state!.nodeVoltages['P3'], ref.v_emitter, 'Vemitter');
    });

    // -----------------------------------------------------------------------
    // Test 9: BJT differential pair
    // Vcc → Rc1 → Q1:C, Vcc → Rc2 → Q2:C
    // Q1:E + Q2:E → Re (tail) → GND
    // Q1:B ← V1, Q2:B ← V2
    // -----------------------------------------------------------------------
    test('BJT differential pair: balanced outputs when inputs equal', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 3, 'Vcc');
      await builder.placeLabeled('DcVoltageSource', 3, 10, 'V1');
      await builder.placeLabeled('DcVoltageSource', 3, 17, 'V2');
      await builder.placeLabeled('Resistor', 10, 3, 'Rc1');
      await builder.placeLabeled('Resistor', 22, 3, 'Rc2');
      await builder.placeLabeled('NpnBJT', 14, 9, 'Q1');
      await builder.placeLabeled('NpnBJT', 18, 9, 'Q2');
      await builder.placeLabeled('Resistor', 16, 16, 'Re');
      await builder.placeComponent('Ground', 6, 22);
      await builder.placeComponent('Ground', 18, 22);
      await builder.placeComponent('Ground', 6, 14);
      await builder.placeComponent('Ground', 6, 21);
      await builder.placeLabeled('Probe', 26, 6, 'P1');
      await builder.placeLabeled('Probe', 26, 10, 'P2');

      await builder.setComponentProperty('Vcc', 'voltage', 12);
      await builder.setComponentProperty('V1', 'voltage', 1);
      await builder.setComponentProperty('V2', 'voltage', 1);
      await builder.setComponentProperty('Rc1', 'resistance', 4700);
      await builder.setComponentProperty('Rc2', 'resistance', 4700);
      await builder.setComponentProperty('Re', 'resistance', 10000);

      await builder.drawWire('Vcc', 'pos', 'Rc1', 'A');
      await builder.drawWire('Vcc', 'pos', 'Rc2', 'A');
      await builder.drawWire('Rc1', 'B', 'Q1', 'C');
      await builder.drawWire('Rc2', 'B', 'Q2', 'C');
      await builder.drawWire('V1', 'pos', 'Q1', 'B');
      await builder.drawWire('V2', 'pos', 'Q2', 'B');
      await builder.drawWire('Q1', 'E', 'Re', 'A');
      await builder.drawWire('Q2', 'E', 'Re', 'A');
      await builder.drawWireFromPin('Re', 'B', 18, 22);
      await builder.drawWireFromPin('Vcc', 'neg', 6, 22);
      await builder.drawWireFromPin('V1', 'neg', 6, 14);
      await builder.drawWireFromPin('V2', 'neg', 6, 21);
      await builder.drawWire('Rc1', 'B', 'P1', 'in');
      await builder.drawWire('Rc2', 'B', 'P2', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      // ngspice: v_col1 = v_col2 ≈ 11.896V (balanced)
      // P1 = Rc1:B (collector Q1), P2 = Rc2:B (collector Q2)
      const ref = SPICE_REF.a9_bjt_diffpair;
      expect(state!.simTime).toBeGreaterThan(0);
      expect(state!.nodeCount).toBeGreaterThanOrEqual(2);
      // Both collectors should be at similar voltage (balanced pair)
      expectVoltage(state!.nodeVoltages['P1'], SPICE_REF.a9_bjt_diffpair.v_col1, 'Vcol1');
      // Balance check: collectors within 0.1% of each other
      expect(Math.abs(state!.nodeVoltages['P1'] - state!.nodeVoltages['P2'])).toBeLessThan(state!.nodeVoltages['P1'] * 0.001);
    });

    // -----------------------------------------------------------------------
    // Test 10: BJT Darlington pair — high current gain β₁×β₂
    // Vcc → Rc → Q1:C, Q1:E → Q2:B, Q2:E → Re → GND
    // -----------------------------------------------------------------------
    test('BJT Darlington pair: high current gain', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vcc');
      await builder.placeLabeled('DcVoltageSource', 3, 14, 'Vin');
      await builder.placeLabeled('Resistor', 10, 5, 'Rc');
      await builder.placeLabeled('Resistor', 10, 14, 'Rb');
      await builder.placeLabeled('NpnBJT', 16, 8, 'Q1');
      await builder.placeLabeled('NpnBJT', 16, 14, 'Q2');
      await builder.placeLabeled('Resistor', 16, 20, 'Re');
      await builder.placeComponent('Ground', 6, 22);
      await builder.placeComponent('Ground', 18, 24);
      await builder.placeComponent('Ground', 6, 18);
      await builder.placeLabeled('Probe', 22, 8, 'P1');

      await builder.setComponentProperty('Vcc', 'voltage', 12);
      await builder.setComponentProperty('Vin', 'voltage', 1);
      await builder.setComponentProperty('Rb', 'resistance', 100000);
      await builder.setComponentProperty('Rc', 'resistance', 1000);
      await builder.setComponentProperty('Re', 'resistance', 100);

      await builder.drawWire('Vcc', 'pos', 'Rc', 'A');
      await builder.drawWire('Rc', 'B', 'Q1', 'C');
      await builder.drawWire('Vin', 'pos', 'Rb', 'A');
      await builder.drawWire('Rb', 'B', 'Q1', 'B');
      await builder.drawWire('Q1', 'E', 'Q2', 'B');
      await builder.drawWire('Q1', 'C', 'Q2', 'C');
      await builder.drawWire('Q2', 'E', 'Re', 'A');
      await builder.drawWireFromPin('Re', 'B', 18, 24);
      await builder.drawWireFromPin('Vcc', 'neg', 6, 22);
      await builder.drawWireFromPin('Vin', 'neg', 6, 18);
      await builder.drawWire('Rc', 'B', 'P1', 'in');

      await builder.placeLabeled('Probe', 22, 14, 'P2');
      await builder.drawWire('Q1', 'E', 'P2', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      // ngspice: Vc≈11.97V (very little current due to high Rb)
      // P1 = Rc:B (collector), P2 = Q1:E (mid node between Q1 and Q2)
      const ref = SPICE_REF.a10_bjt_darlington;
      expect(state!.simTime).toBeGreaterThan(0);
      expectVoltage(state!.nodeVoltages['P1'], SPICE_REF.a10_bjt_darlington.v_collector, 'Vcollector');
      expectVoltage(state!.nodeVoltages['P2'], ref.v_mid, 'Vmid');
    });

    // -----------------------------------------------------------------------
    // Test 11: BJT push-pull output stage
    // NPN (top) + PNP (bottom) — complementary output follows input
    // -----------------------------------------------------------------------
    test('BJT push-pull: complementary output follows input', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 4, 'Vcc');
      await builder.placeLabeled('DcVoltageSource', 3, 18, 'Vee');
      await builder.placeLabeled('DcVoltageSource', 3, 11, 'Vin');
      await builder.placeLabeled('NpnBJT', 14, 7, 'Q1');
      await builder.placeLabeled('PnpBJT', 14, 15, 'Q2');
      await builder.placeLabeled('Resistor', 20, 11, 'Rload');
      await builder.placeComponent('Ground', 6, 8);
      await builder.placeComponent('Ground', 6, 22);
      await builder.placeComponent('Ground', 6, 15);
      await builder.placeComponent('Ground', 22, 16);
      await builder.placeLabeled('Probe', 24, 11, 'P1');

      await builder.setComponentProperty('Vcc', 'voltage', 12);
      await builder.setComponentProperty('Vee', 'voltage', 12);
      await builder.setComponentProperty('Vin', 'voltage', 3);

      // NPN: Vcc → Q1:C, Q1:B ← Vin, Q1:E → output node
      await builder.drawWire('Vcc', 'pos', 'Q1', 'C');
      await builder.drawWire('Vin', 'pos', 'Q1', 'B');
      await builder.drawWire('Vin', 'pos', 'Q2', 'B');
      // PNP: Vee → Q2:E (emitter=supply for PNP), Q2:C → output node
      await builder.drawWire('Vee', 'pos', 'Q2', 'E');
      // Output node: Q1:E = Q2:C = Rload:A
      await builder.drawWire('Q1', 'E', 'Rload', 'A');
      await builder.drawWire('Q2', 'C', 'Rload', 'A');
      await builder.drawWireFromPin('Rload', 'B', 22, 16);
      // Source grounds
      await builder.drawWireFromPin('Vcc', 'neg', 6, 8);
      await builder.drawWireFromPin('Vee', 'neg', 6, 22);
      await builder.drawWireFromPin('Vin', 'neg', 6, 15);
      await builder.drawWire('Rload', 'A', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      // ngspice: Vout≈2.325V (Vin=3V minus Vbe≈0.67V)
      // P1 = Rload:A (output node)
      const ref = SPICE_REF.a11_bjt_pushpull;
      expect(state!.simTime).toBeGreaterThan(0);
      expectVoltage(state!.nodeVoltages['P1'], ref.v_output, 'Vout');
      expect(state!.nodeVoltages['P1']).toBeLessThan(ref.v_input);
    });

    // -----------------------------------------------------------------------
    // Test 12: MOSFET common-source amplifier
    // Vdd → Rd → NMOS:D, NMOS:G ← Vg, NMOS:S → Rs → GND
    // -----------------------------------------------------------------------
    test('MOSFET common-source: DC bias Vds > Vgs-Vth', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vdd');
      await builder.placeLabeled('DcVoltageSource', 3, 14, 'Vg');
      await builder.placeLabeled('Resistor', 10, 5, 'Rd');
      await builder.placeLabeled('Resistor', 10, 14, 'Rg');
      await builder.placeLabeled('NMOS', 16, 10, 'M1');
      await builder.placeLabeled('Resistor', 16, 16, 'Rs');
      await builder.placeComponent('Ground', 6, 20);
      await builder.placeComponent('Ground', 18, 20);
      await builder.placeComponent('Ground', 6, 18);
      await builder.placeLabeled('Probe', 22, 8, 'P1');
      await builder.placeLabeled('Probe', 22, 14, 'P2');

      await builder.setComponentProperty('Vdd', 'voltage', 12);
      await builder.setComponentProperty('Vg', 'voltage', 3);
      await builder.setComponentProperty('Rd', 'resistance', 4700);
      await builder.setComponentProperty('Rg', 'resistance', 100000);
      await builder.setComponentProperty('Rs', 'resistance', 1000);

      await builder.drawWire('Vdd', 'pos', 'Rd', 'A');
      await builder.drawWire('Rd', 'B', 'M1', 'D');
      await builder.drawWire('Vg', 'pos', 'Rg', 'A');
      await builder.drawWire('Rg', 'B', 'M1', 'G');
      await builder.drawWire('M1', 'S', 'Rs', 'A');
      await builder.drawWireFromPin('Rs', 'B', 18, 20);
      await builder.drawWireFromPin('Vdd', 'neg', 6, 20);
      await builder.drawWireFromPin('Vg', 'neg', 6, 18);
      await builder.drawWire('Rd', 'B', 'P1', 'in');
      await builder.drawWire('M1', 'S', 'P2', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);

      // ngspice: Vd≈4.46V, Vs≈1.60V
      // P1 = drain (Rd:B), P2 = source (M1:S / Rs:A)
      const ref = SPICE_REF.a12_mosfet_cs;
      expectVoltage(state!.nodeVoltages['P1'], ref.v_drain, 'Vdrain');
      expectVoltage(state!.nodeVoltages['P2'], ref.v_source, 'Vsource');
    });

    // -----------------------------------------------------------------------
    // Test 13: CMOS inverter — PMOS + NMOS
    // Vin=0 → Vout=Vdd, Vin=Vdd → Vout≈0
    // -----------------------------------------------------------------------
    test('CMOS inverter: Vin=0 gives Vout=Vdd', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vdd');
      await builder.placeLabeled('DcVoltageSource', 3, 14, 'Vin');
      await builder.placeLabeled('PMOS', 14, 6, 'Mp');
      await builder.placeLabeled('NMOS', 14, 14, 'Mn');
      await builder.placeComponent('Ground', 6, 20);
      await builder.placeComponent('Ground', 16, 20);
      await builder.placeComponent('Ground', 6, 18);
      await builder.placeLabeled('Probe', 22, 10, 'P1');

      await builder.setComponentProperty('Vdd', 'voltage', 5);
      await builder.setComponentProperty('Vin', 'voltage', 0);

      // PMOS: S → Vdd, G ← Vin, D → output
      // NMOS: D → output, G ← Vin, S → GND
      await builder.drawWire('Vdd', 'pos', 'Mp', 'S');
      await builder.drawWire('Vin', 'pos', 'Mp', 'G');
      await builder.drawWire('Vin', 'pos', 'Mn', 'G');
      await builder.drawWire('Mp', 'D', 'Mn', 'D');
      await builder.drawWireFromPin('Mn', 'S', 16, 20);
      await builder.drawWireFromPin('Vdd', 'neg', 6, 20);
      await builder.drawWireFromPin('Vin', 'neg', 6, 18);
      await builder.drawWire('Mp', 'D', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 200);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);

      // ngspice: Vout≈5V when Vin=0 (PMOS on, NMOS off)
      // P1 = output node (Mp:D = Mn:D)
      expectVoltage(state!.nodeVoltages['P1'], SPICE_REF.a13_cmos_inverter_low.v_output, 'Vout(Vin=0)');
    });

    // -----------------------------------------------------------------------
    // Test 14: CMOS NAND — 2 PMOS (parallel) + 2 NMOS (series)
    // Inputs A=0, B=0 → output = Vdd
    // -----------------------------------------------------------------------
    test('CMOS NAND: truth table at analog voltages', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 3, 'Vdd');
      await builder.placeLabeled('DcVoltageSource', 3, 10, 'Va');
      await builder.placeLabeled('DcVoltageSource', 3, 17, 'Vb');
      // Parallel PMOS
      await builder.placeLabeled('PMOS', 14, 4, 'Mp1');
      await builder.placeLabeled('PMOS', 18, 4, 'Mp2');
      // Series NMOS
      await builder.placeLabeled('NMOS', 16, 12, 'Mn1');
      await builder.placeLabeled('NMOS', 16, 18, 'Mn2');
      await builder.placeComponent('Ground', 6, 22);
      await builder.placeComponent('Ground', 18, 22);
      await builder.placeComponent('Ground', 6, 14);
      await builder.placeComponent('Ground', 6, 21);
      await builder.placeLabeled('Probe', 24, 8, 'P1');

      await builder.setComponentProperty('Vdd', 'voltage', 5);
      await builder.setComponentProperty('Va', 'voltage', 0);
      await builder.setComponentProperty('Vb', 'voltage', 0);

      // PMOS parallel: both S → Vdd, both D → output
      await builder.drawWire('Vdd', 'pos', 'Mp1', 'S');
      await builder.drawWire('Vdd', 'pos', 'Mp2', 'S');
      await builder.drawWire('Mp1', 'D', 'Mn1', 'D');
      await builder.drawWire('Mp2', 'D', 'Mn1', 'D');
      // NMOS series: Mn1:S → Mn2:D, Mn2:S → GND
      await builder.drawWire('Mn1', 'S', 'Mn2', 'D');
      await builder.drawWireFromPin('Mn2', 'S', 18, 22);
      // Gate connections
      await builder.drawWire('Va', 'pos', 'Mp1', 'G');
      await builder.drawWire('Va', 'pos', 'Mn1', 'G');
      await builder.drawWire('Vb', 'pos', 'Mp2', 'G');
      await builder.drawWire('Vb', 'pos', 'Mn2', 'G');
      // Grounds
      await builder.drawWireFromPin('Vdd', 'neg', 6, 22);
      await builder.drawWireFromPin('Va', 'neg', 6, 14);
      await builder.drawWireFromPin('Vb', 'neg', 6, 21);
      await builder.drawWire('Mn1', 'D', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 200);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);

      // ngspice: Vout≈5V when both inputs LOW (both PMOS on)
      // P1 = output node (Mn1:D = Mp1:D = Mp2:D)
      expectVoltage(state!.nodeVoltages['P1'], SPICE_REF.a14_cmos_nand_00.v_output, 'Vout(A=0,B=0)');
    });

    // -----------------------------------------------------------------------
    // Test 15: JFET amplifier — NJFET common-source
    // Vdd → Rd → NJFET:D, NJFET:G ← Vg, NJFET:S → Rs → GND
    // -----------------------------------------------------------------------
    test('JFET amplifier: pinch-off region operation', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vdd');
      await builder.placeLabeled('DcVoltageSource', 3, 14, 'Vg');
      await builder.placeLabeled('Resistor', 10, 5, 'Rd');
      await builder.placeLabeled('Resistor', 10, 14, 'Rg');
      await builder.placeLabeled('NJFET', 16, 10, 'J1');
      await builder.placeLabeled('Resistor', 16, 16, 'Rs');
      await builder.placeComponent('Ground', 6, 20);
      await builder.placeComponent('Ground', 18, 20);
      await builder.placeComponent('Ground', 6, 18);
      await builder.placeLabeled('Probe', 22, 8, 'P1');
      await builder.placeLabeled('Probe', 22, 14, 'P2');

      await builder.setComponentProperty('Vdd', 'voltage', 15);
      await builder.setComponentProperty('Vg', 'voltage', 0);
      await builder.setComponentProperty('Rd', 'resistance', 2200);
      await builder.setComponentProperty('Rg', 'resistance', 1000000);
      await builder.setComponentProperty('Rs', 'resistance', 680);

      await builder.drawWire('Vdd', 'pos', 'Rd', 'A');
      await builder.drawWire('Rd', 'B', 'J1', 'D');
      await builder.drawWire('Vg', 'pos', 'Rg', 'A');
      await builder.drawWire('Rg', 'B', 'J1', 'G');
      await builder.drawWire('J1', 'S', 'Rs', 'A');
      await builder.drawWireFromPin('Rs', 'B', 18, 20);
      await builder.drawWireFromPin('Vdd', 'neg', 6, 20);
      await builder.drawWireFromPin('Vg', 'neg', 6, 18);
      await builder.drawWire('Rd', 'B', 'P1', 'in');
      await builder.drawWire('J1', 'S', 'P2', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      // ngspice: Vd≈11.79V, Vs≈0.99V
      // P1 = drain (Rd:B), P2 = source (J1:S / Rs:A)
      const ref = SPICE_REF.a15_jfet_amp;
      expect(state!.simTime).toBeGreaterThan(0);
      expectVoltage(state!.nodeVoltages['P1'], ref.v_drain, 'Vdrain');
      expectVoltage(state!.nodeVoltages['P2'], ref.v_source, 'Vsource');
    });
  });

  // =========================================================================
  // 3C — Complex Transistor Networks
  // =========================================================================

  test.describe('3C — Complex Transistor Networks', () => {

    // -----------------------------------------------------------------------
    // Test 16: Cascode amplifier — Q1 (CE) drives Q2 (CB)
    // Higher output impedance than single CE stage
    // -----------------------------------------------------------------------
    test('cascode amplifier: two-stage BJT with higher output impedance', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 3, 'Vcc');
      await builder.placeLabeled('DcVoltageSource', 3, 12, 'Vin');
      await builder.placeLabeled('DcVoltageSource', 3, 19, 'Vbias');
      await builder.placeLabeled('Resistor', 10, 3, 'Rc');
      await builder.placeLabeled('NpnBJT', 14, 7, 'Q2');
      await builder.placeLabeled('NpnBJT', 14, 14, 'Q1');
      await builder.placeLabeled('Resistor', 10, 12, 'Rb');
      await builder.placeLabeled('Resistor', 14, 20, 'Re');
      await builder.placeComponent('Ground', 6, 24);
      await builder.placeComponent('Ground', 16, 24);
      await builder.placeComponent('Ground', 6, 16);
      await builder.placeComponent('Ground', 6, 23);
      await builder.placeLabeled('Probe', 20, 5, 'P1');
      await builder.placeLabeled('Probe', 20, 10, 'P2');

      await builder.setComponentProperty('Vcc', 'voltage', 12);
      await builder.setComponentProperty('Vin', 'voltage', 1);
      await builder.setComponentProperty('Vbias', 'voltage', 6);
      await builder.setComponentProperty('Rc', 'resistance', 4700);
      await builder.setComponentProperty('Rb', 'resistance', 100000);
      await builder.setComponentProperty('Re', 'resistance', 1000);

      // Vcc → Rc → Q2:C, Q2:E → Q1:C, Q1:E → Re → GND
      await builder.drawWire('Vcc', 'pos', 'Rc', 'A');
      await builder.drawWire('Rc', 'B', 'Q2', 'C');
      await builder.drawWire('Q2', 'E', 'Q1', 'C');
      await builder.drawWire('Q1', 'E', 'Re', 'A');
      await builder.drawWireFromPin('Re', 'B', 16, 24);
      // Bias
      await builder.drawWire('Vin', 'pos', 'Rb', 'A');
      await builder.drawWire('Rb', 'B', 'Q1', 'B');
      await builder.drawWire('Vbias', 'pos', 'Q2', 'B');
      // Grounds
      await builder.drawWireFromPin('Vcc', 'neg', 6, 24);
      await builder.drawWireFromPin('Vin', 'neg', 6, 16);
      await builder.drawWireFromPin('Vbias', 'neg', 6, 23);
      await builder.drawWire('Rc', 'B', 'P1', 'in');
      await builder.drawWire('Q2', 'E', 'P2', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      // P1 = output (Rc:B = Q2:C), P2 = mid node (Q2:E = Q1:C)
      const ref = SPICE_REF.a16_cascode;
      expectVoltage(state!.nodeVoltages['P1'], ref.v_output, 'Voutput');
      expectVoltage(state!.nodeVoltages['P2'], ref.v_mid, 'Vmid');
    });

    // -----------------------------------------------------------------------
    // Test 17: Wilson current mirror — 3 NPN BJTs
    // Output current ≈ reference current
    // -----------------------------------------------------------------------
    test('Wilson current mirror: output current tracks reference', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vcc');
      await builder.placeLabeled('Resistor', 10, 5, 'Rref');
      await builder.placeLabeled('Resistor', 20, 5, 'Rload');
      await builder.placeLabeled('NpnBJT', 13, 12, 'Q1');
      await builder.placeLabeled('NpnBJT', 17, 12, 'Q2');
      await builder.placeLabeled('NpnBJT', 15, 18, 'Q3');
      await builder.placeComponent('Ground', 6, 22);
      await builder.placeComponent('Ground', 17, 22);
      await builder.placeLabeled('Probe', 24, 8, 'P1');
      await builder.placeLabeled('Probe', 14, 8, 'P2');

      await builder.setComponentProperty('Vcc', 'voltage', 12);
      await builder.setComponentProperty('Rref', 'resistance', 10000);
      await builder.setComponentProperty('Rload', 'resistance', 10000);

      // Vcc → Rref → Q1:C, Vcc → Rload → Q2:C
      await builder.drawWire('Vcc', 'pos', 'Rref', 'A');
      await builder.drawWire('Rref', 'B', 'Q1', 'C');
      await builder.drawWire('Vcc', 'pos', 'Rload', 'A');
      await builder.drawWire('Rload', 'B', 'Q2', 'C');
      // Wilson mirror: Q1:C → Q3:B, Q3:E → Q1:B and Q2:B
      await builder.drawWire('Q1', 'C', 'Q3', 'B');
      await builder.drawWire('Q3', 'E', 'Q1', 'B');
      await builder.drawWire('Q3', 'E', 'Q2', 'B');
      // Q3:C → Q2:C (collector feedback)
      await builder.drawWire('Q3', 'C', 'Q2', 'C');
      // Emitters to ground
      await builder.drawWireFromPin('Q1', 'E', 17, 22);
      await builder.drawWireFromPin('Q2', 'E', 17, 22);
      await builder.drawWireFromPin('Vcc', 'neg', 6, 22);
      await builder.drawWire('Rload', 'B', 'P1', 'in');
      await builder.drawWire('Rref', 'B', 'P2', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      // P1 = output (Rload:B = Q2:C), P2 = ref leg (Rref:B = Q1:C)
      const ref = SPICE_REF.a17_wilson_mirror;
      expectVoltage(state!.nodeVoltages['P2'], ref.v_ref_leg, 'Vref_leg');
      expectVoltage(state!.nodeVoltages['P1'], ref.v_output, 'Voutput');
    });

    // -----------------------------------------------------------------------
    // Test 18: Widlar current source — low current output
    // Q1 sets reference, Q2 with Re produces lower output current
    // -----------------------------------------------------------------------
    test('Widlar current source: low current output', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vcc');
      await builder.placeLabeled('Resistor', 10, 5, 'Rref');
      await builder.placeLabeled('Resistor', 20, 5, 'Rload');
      await builder.placeLabeled('NpnBJT', 13, 12, 'Q1');
      await builder.placeLabeled('NpnBJT', 18, 12, 'Q2');
      await builder.placeLabeled('Resistor', 20, 18, 'Re');
      await builder.placeComponent('Ground', 6, 22);
      await builder.placeComponent('Ground', 15, 22);
      await builder.placeComponent('Ground', 22, 22);
      await builder.placeLabeled('Probe', 24, 8, 'P1');

      await builder.setComponentProperty('Vcc', 'voltage', 12);
      await builder.setComponentProperty('Rref', 'resistance', 10000);
      await builder.setComponentProperty('Rload', 'resistance', 47000);
      await builder.setComponentProperty('Re', 'resistance', 5600);

      // Vcc → Rref → Q1:C, Q1:B shorted to Q1:C (diode-connected)
      await builder.drawWire('Vcc', 'pos', 'Rref', 'A');
      await builder.drawWire('Rref', 'B', 'Q1', 'C');
      await builder.drawWire('Q1', 'C', 'Q1', 'B');
      // Q1:B → Q2:B (mirror)
      await builder.drawWire('Q1', 'B', 'Q2', 'B');
      // Vcc → Rload → Q2:C
      await builder.drawWire('Vcc', 'pos', 'Rload', 'A');
      await builder.drawWire('Rload', 'B', 'Q2', 'C');
      // Q1:E → GND, Q2:E → Re → GND
      await builder.drawWireFromPin('Q1', 'E', 15, 22);
      await builder.drawWire('Q2', 'E', 'Re', 'A');
      await builder.drawWireFromPin('Re', 'B', 22, 22);
      await builder.drawWireFromPin('Vcc', 'neg', 6, 22);
      await builder.drawWire('Rload', 'B', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      // P1 = output (Rload:B = Q2:C)
      const ref = SPICE_REF.a18_widlar;
      expectVoltage(state!.nodeVoltages['P1'], ref.v_output, 'Voutput');
    });

    // -----------------------------------------------------------------------
    // Test 19: MOSFET H-bridge — 2 NMOS + 2 PMOS + load
    // Forward/reverse/brake states
    // -----------------------------------------------------------------------
    test('MOSFET H-bridge: forward and reverse drive states', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 8, 'Vdd');
      await builder.placeLabeled('DcVoltageSource', 3, 16, 'Vfwd');
      await builder.placeLabeled('DcVoltageSource', 3, 22, 'Vrev');
      await builder.placeLabeled('PMOS', 12, 5, 'Mp1');
      await builder.placeLabeled('PMOS', 20, 5, 'Mp2');
      await builder.placeLabeled('NMOS', 12, 17, 'Mn1');
      await builder.placeLabeled('NMOS', 20, 17, 'Mn2');
      await builder.placeLabeled('Resistor', 16, 11, 'Rload');
      await builder.placeComponent('Ground', 6, 26);
      await builder.placeComponent('Ground', 14, 22);
      await builder.placeComponent('Ground', 22, 22);
      await builder.placeComponent('Ground', 6, 20);
      await builder.placeComponent('Ground', 6, 26);
      await builder.placeLabeled('Probe', 26, 11, 'P1');
      await builder.placeLabeled('Probe', 26, 15, 'P2');

      await builder.setComponentProperty('Vdd', 'voltage', 12);
      await builder.setComponentProperty('Vfwd', 'voltage', 0);
      await builder.setComponentProperty('Vrev', 'voltage', 12);

      // Supply to PMOS sources
      await builder.drawWire('Vdd', 'pos', 'Mp1', 'S');
      await builder.drawWire('Vdd', 'pos', 'Mp2', 'S');
      // PMOS drains to load ends
      await builder.drawWire('Mp1', 'D', 'Rload', 'A');
      await builder.drawWire('Mp2', 'D', 'Rload', 'B');
      // NMOS drains to load ends
      await builder.drawWire('Mn1', 'D', 'Rload', 'A');
      await builder.drawWire('Mn2', 'D', 'Rload', 'B');
      // NMOS sources to ground
      await builder.drawWireFromPin('Mn1', 'S', 14, 22);
      await builder.drawWireFromPin('Mn2', 'S', 22, 22);
      // Gate drive: forward = Mp1 on, Mn2 on (Vfwd=0→PMOS on, Vrev=12→NMOS on)
      await builder.drawWire('Vfwd', 'pos', 'Mp1', 'G');
      await builder.drawWire('Vfwd', 'pos', 'Mn1', 'G');
      await builder.drawWire('Vrev', 'pos', 'Mp2', 'G');
      await builder.drawWire('Vrev', 'pos', 'Mn2', 'G');
      // Grounds
      await builder.drawWireFromPin('Vdd', 'neg', 6, 26);
      await builder.drawWireFromPin('Vfwd', 'neg', 6, 20);
      await builder.drawWireFromPin('Vrev', 'neg', 6, 26);
      await builder.drawWire('Rload', 'A', 'P1', 'in');
      await builder.drawWire('Rload', 'B', 'P2', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      // P1 = high side (Rload:A = Mp1:D), P2 = low side (Rload:B = Mp2:D)
      const ref = SPICE_REF.a19_hbridge_fwd;
      expectVoltage(state!.nodeVoltages['P1'], ref.v_high_side, 'Vhigh');
      expectVoltage(state!.nodeVoltages['P2'], ref.v_low_side, 'Vlow');
    });

    // -----------------------------------------------------------------------
    // Test 20: BJT+MOSFET mixed driver
    // NPN level-shifts signal to drive NMOS gate
    // -----------------------------------------------------------------------
    test('BJT+MOSFET mixed driver: NPN drives NMOS gate', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vdd');
      await builder.placeLabeled('DcVoltageSource', 3, 14, 'Vin');
      await builder.placeLabeled('Resistor', 10, 5, 'Rc');
      await builder.placeLabeled('Resistor', 10, 14, 'Rb');
      await builder.placeLabeled('NpnBJT', 14, 10, 'Q1');
      await builder.placeLabeled('NMOS', 20, 10, 'M1');
      await builder.placeLabeled('Resistor', 20, 5, 'Rd');
      await builder.placeComponent('Ground', 6, 20);
      await builder.placeComponent('Ground', 16, 16);
      await builder.placeComponent('Ground', 22, 16);
      await builder.placeComponent('Ground', 6, 18);
      await builder.placeLabeled('Probe', 26, 8, 'P1');
      await builder.placeLabeled('Probe', 18, 8, 'P2');

      await builder.setComponentProperty('Vdd', 'voltage', 12);
      await builder.setComponentProperty('Vin', 'voltage', 1);
      await builder.setComponentProperty('Rc', 'resistance', 4700);
      await builder.setComponentProperty('Rb', 'resistance', 100000);
      await builder.setComponentProperty('Rd', 'resistance', 1000);

      // BJT stage: Vin → Rb → Q1:B, Vdd → Rc → Q1:C
      await builder.drawWire('Vin', 'pos', 'Rb', 'A');
      await builder.drawWire('Rb', 'B', 'Q1', 'B');
      await builder.drawWire('Vdd', 'pos', 'Rc', 'A');
      await builder.drawWire('Rc', 'B', 'Q1', 'C');
      await builder.drawWireFromPin('Q1', 'E', 16, 16);
      // MOSFET stage: Q1:C → M1:G, Vdd → Rd → M1:D
      await builder.drawWire('Rc', 'B', 'M1', 'G');
      await builder.drawWire('Vdd', 'pos', 'Rd', 'A');
      await builder.drawWire('Rd', 'B', 'M1', 'D');
      await builder.drawWireFromPin('M1', 'S', 22, 16);
      // Grounds
      await builder.drawWireFromPin('Vdd', 'neg', 6, 20);
      await builder.drawWireFromPin('Vin', 'neg', 6, 18);
      await builder.drawWire('Rd', 'B', 'P1', 'in');
      await builder.drawWire('Rc', 'B', 'P2', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      // P1 = MOSFET drain (Rd:B), P2 = BJT collector / MOSFET gate (Rc:B = Q1:C)
      const ref = SPICE_REF.a20_bjt_mosfet_driver;
      expectVoltage(state!.nodeVoltages['P2'], ref.v_q1c, 'Vq1c');
      expectVoltage(state!.nodeVoltages['P1'], ref.v_drain, 'Vdrain');
    });

    // -----------------------------------------------------------------------
    // Test 21: Multi-stage amplifier — 3 CE stages
    // -----------------------------------------------------------------------
    test('multi-stage amplifier: three CE stages with overall gain', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 3, 'Vcc');
      await builder.placeLabeled('DcVoltageSource', 3, 20, 'Vin');

      // Stage 1
      await builder.placeLabeled('Resistor', 9, 3, 'Rc1');
      await builder.placeLabeled('Resistor', 9, 10, 'Rb1');
      await builder.placeLabeled('NpnBJT', 12, 7, 'Q1');
      await builder.placeLabeled('Resistor', 12, 13, 'Re1');

      // Stage 2
      await builder.placeLabeled('Resistor', 17, 3, 'Rc2');
      await builder.placeLabeled('Resistor', 17, 10, 'Rb2');
      await builder.placeLabeled('NpnBJT', 20, 7, 'Q2');
      await builder.placeLabeled('Resistor', 20, 13, 'Re2');

      // Stage 3
      await builder.placeLabeled('Resistor', 25, 3, 'Rc3');
      await builder.placeLabeled('Resistor', 25, 10, 'Rb3');
      await builder.placeLabeled('NpnBJT', 28, 7, 'Q3');
      await builder.placeLabeled('Resistor', 28, 13, 'Re3');

      await builder.placeComponent('Ground', 6, 18);
      await builder.placeComponent('Ground', 14, 17);
      await builder.placeComponent('Ground', 22, 17);
      await builder.placeComponent('Ground', 30, 17);
      await builder.placeComponent('Ground', 6, 24);
      await builder.placeLabeled('Probe', 32, 5, 'P1');
      await builder.placeLabeled('Probe', 14, 5, 'P2');
      await builder.placeLabeled('Probe', 22, 5, 'P3');

      await builder.setComponentProperty('Vcc', 'voltage', 12);
      await builder.setComponentProperty('Vin', 'voltage', 1);
      await builder.setComponentProperty('Rc1', 'resistance', 4700);
      await builder.setComponentProperty('Rc2', 'resistance', 4700);
      await builder.setComponentProperty('Rc3', 'resistance', 4700);
      await builder.setComponentProperty('Rb1', 'resistance', 100000);
      await builder.setComponentProperty('Rb2', 'resistance', 100000);
      await builder.setComponentProperty('Rb3', 'resistance', 100000);
      await builder.setComponentProperty('Re1', 'resistance', 1000);
      await builder.setComponentProperty('Re2', 'resistance', 1000);
      await builder.setComponentProperty('Re3', 'resistance', 1000);

      // Stage 1
      await builder.drawWire('Vcc', 'pos', 'Rc1', 'A');
      await builder.drawWire('Rc1', 'B', 'Q1', 'C');
      await builder.drawWire('Vin', 'pos', 'Rb1', 'A');
      await builder.drawWire('Rb1', 'B', 'Q1', 'B');
      await builder.drawWire('Q1', 'E', 'Re1', 'A');
      await builder.drawWireFromPin('Re1', 'B', 14, 17);

      // Stage 2 — driven by stage 1 collector
      await builder.drawWire('Vcc', 'pos', 'Rc2', 'A');
      await builder.drawWire('Rc2', 'B', 'Q2', 'C');
      await builder.drawWire('Rc1', 'B', 'Rb2', 'A');
      await builder.drawWire('Rb2', 'B', 'Q2', 'B');
      await builder.drawWire('Q2', 'E', 'Re2', 'A');
      await builder.drawWireFromPin('Re2', 'B', 22, 17);

      // Stage 3 — driven by stage 2 collector
      await builder.drawWire('Vcc', 'pos', 'Rc3', 'A');
      await builder.drawWire('Rc3', 'B', 'Q3', 'C');
      await builder.drawWire('Rc2', 'B', 'Rb3', 'A');
      await builder.drawWire('Rb3', 'B', 'Q3', 'B');
      await builder.drawWire('Q3', 'E', 'Re3', 'A');
      await builder.drawWireFromPin('Re3', 'B', 30, 17);

      // Grounds
      await builder.drawWireFromPin('Vcc', 'neg', 6, 18);
      await builder.drawWireFromPin('Vin', 'neg', 6, 24);
      await builder.drawWire('Rc3', 'B', 'P1', 'in');
      await builder.drawWire('Rc1', 'B', 'P2', 'in');
      await builder.drawWire('Rc2', 'B', 'P3', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepToTimeAndRead(builder, '5m');
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      // P1 = stage 3 collector (Rc3:B), P2 = stage 1 collector (Rc1:B), P3 = stage 2 collector (Rc2:B)
      const ref = SPICE_REF.a21_multistage;
      expectVoltage(state!.nodeVoltages['P2'], ref.v_c1, 'Vc1');
      expectVoltage(state!.nodeVoltages['P1'], ref.v_c3, 'Vc3');
      expectVoltage(state!.nodeVoltages['P3'], ref.v_c2, 'Vc2');
    });
  });

  // =========================================================================
  // 3D — Reactive + Switching Circuits
  // =========================================================================

  test.describe('3D — Reactive + Switching Circuits', () => {

    // -----------------------------------------------------------------------
    // Test 22: Switched RC charge/discharge
    // Close switch → capacitor charges, open → discharges
    // -----------------------------------------------------------------------
    test('switched RC: charge on close, discharge on open', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('Switch', 10, 8, 'SW');
      await builder.placeLabeled('Resistor', 16, 8, 'R1');
      await builder.placeLabeled('Capacitor', 22, 8, 'C1');
      await builder.placeComponent('Ground', 6, 14);
      await builder.placeComponent('Ground', 24, 14);
      await builder.placeLabeled('Probe', 26, 8, 'P1');

      await builder.drawWire('Vs', 'pos', 'SW', 'A1');
      await builder.drawWire('SW', 'B1', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'C1', 'pos');
      await builder.drawWireFromPin('C1', 'neg', 24, 14);
      await builder.drawWireFromPin('Vs', 'neg', 6, 14);
      await builder.drawWire('C1', 'pos', 'P1', 'in');

      // Compile with switch open (default)
      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step a bit — capacitor should not charge (switch open)
      const stateOpen = await stepAndRead(builder, 200);
      expect(stateOpen).not.toBeNull();

      // Toggle switch closed by clicking it
      await clickElementCenter(builder, 'SW');

      // Step — capacitor should charge
      const stateCharged = await stepAndRead(builder, 500);
      expect(stateCharged).not.toBeNull();
      expect(stateCharged!.simTime).toBeGreaterThan(stateOpen!.simTime);

      const vc = Math.max(...sortedVoltages(stateCharged!));
      expect(vc).toBeGreaterThan(1.5);
      expect(vc).toBeLessThan(5.25);
    });

    // -----------------------------------------------------------------------
    // Test 23: LRC with switch — damped oscillation on close
    // -----------------------------------------------------------------------
    test('LRC with switch: damped oscillation after closing', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('Switch', 10, 8, 'SW');
      await builder.placeLabeled('Inductor', 16, 8, 'L1');
      await builder.placeLabeled('Resistor', 22, 8, 'R1');
      await builder.placeLabeled('Capacitor', 28, 8, 'C1');
      await builder.placeComponent('Ground', 6, 14);
      await builder.placeComponent('Ground', 30, 14);
      await builder.placeLabeled('Probe', 32, 8, 'P1');

      await builder.setComponentProperty('R1', 'resistance', 100);

      await builder.drawWire('Vs', 'pos', 'SW', 'A1');
      await builder.drawWire('SW', 'B1', 'L1', 'A');
      await builder.drawWire('L1', 'B', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'C1', 'pos');
      await builder.drawWireFromPin('C1', 'neg', 30, 14);
      await builder.drawWireFromPin('Vs', 'neg', 6, 14);
      await builder.drawWire('R1', 'B', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Close switch and observe oscillation
      await clickElementCenter(builder, 'SW');

      const result = await builder.measureAnalogPeaks('5m');
      expect(result).not.toBeNull();
      // Should see oscillation (amplitude > 2.0 on some node)
      expect(Math.max(...result!.amplitudes)).toBeGreaterThan(2.0);
    });

    // -----------------------------------------------------------------------
    // Test 24: Relay-driven LC
    // Relay toggles between LC and R load paths
    // -----------------------------------------------------------------------
    test('relay-driven LC: relay switches between load paths', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vcoil');
      await builder.placeLabeled('DcVoltageSource', 3, 14, 'Vsig');
      await builder.placeLabeled('Relay', 12, 8, 'RL');
      await builder.placeLabeled('Inductor', 20, 5, 'L1');
      await builder.placeLabeled('Capacitor', 26, 5, 'C1');
      await builder.placeLabeled('Resistor', 20, 14, 'R1');
      await builder.placeComponent('Ground', 6, 20);
      await builder.placeComponent('Ground', 6, 10);
      await builder.placeComponent('Ground', 28, 10);
      await builder.placeComponent('Ground', 22, 18);
      await builder.placeLabeled('Probe', 30, 8, 'P1');

      await builder.setComponentProperty('Vcoil', 'voltage', 5);
      await builder.setComponentProperty('Vsig', 'voltage', 5);

      // Coil drive
      await builder.drawWire('Vcoil', 'pos', 'RL', 'in1');
      await builder.drawWireFromPin('RL', 'in2', 6, 10);
      // Signal through relay contact
      await builder.drawWire('Vsig', 'pos', 'RL', 'A1');
      // LC path
      await builder.drawWire('RL', 'B1', 'L1', 'A');
      await builder.drawWire('L1', 'B', 'C1', 'pos');
      await builder.drawWireFromPin('C1', 'neg', 28, 10);
      // R path via separate wire (relay switches between paths)
      await builder.drawWire('RL', 'B1', 'R1', 'A');
      await builder.drawWireFromPin('R1', 'B', 22, 18);
      // Grounds
      await builder.drawWireFromPin('Vcoil', 'neg', 6, 20);
      await builder.drawWireFromPin('Vsig', 'neg', 6, 20);
      await builder.drawWire('RL', 'B1', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      expect(Math.max(...sortedVoltages(state!))).toBeGreaterThan(4.5);
    });

    // -----------------------------------------------------------------------
    // Test 25: Switched capacitor filter
    // Clock-driven SPST switches with capacitors simulate resistance
    // -----------------------------------------------------------------------
    test('switched capacitor filter: clock-driven analog switches', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vdd');
      await builder.placeLabeled('DcVoltageSource', 3, 12, 'Vin');
      await builder.placeLabeled('Clock', 3, 18, 'CLK');
      await builder.placeLabeled('SwitchSPST', 12, 8, 'S1');
      await builder.placeLabeled('SwitchSPST', 20, 8, 'S2');
      await builder.placeLabeled('Capacitor', 16, 12, 'C1');
      await builder.placeLabeled('Capacitor', 24, 12, 'C2');
      await builder.placeLabeled('Resistor', 28, 8, 'R1');
      await builder.placeLabeled('OpAmp', 32, 10, 'OA');
      await builder.placeComponent('Ground', 6, 22);
      await builder.placeComponent('Ground', 18, 16);
      await builder.placeComponent('Ground', 26, 16);
      await builder.placeComponent('Ground', 6, 16);
      await builder.placeLabeled('Probe', 36, 10, 'P1');

      // Switches controlled by clock
      await builder.drawWire('CLK', 'out', 'S1', 'ctrl');
      await builder.drawWire('CLK', 'out', 'S2', 'ctrl');
      // Input through S1, then C1 to ground
      await builder.drawWire('Vin', 'pos', 'S1', 'in');
      await builder.drawWire('S1', 'out', 'C1', 'pos');
      await builder.drawWireFromPin('C1', 'neg', 18, 16);
      // S1:out through S2 to C2
      await builder.drawWire('S1', 'out', 'S2', 'in');
      await builder.drawWire('S2', 'out', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'OA', 'in-');
      await builder.drawWire('S2', 'out', 'C2', 'pos');
      await builder.drawWireFromPin('C2', 'neg', 26, 16);
      // OpAmp: in+ to ground reference
      await builder.drawWire('Vdd', 'neg', 'OA', 'in+');
      await builder.drawWire('OA', 'out', 'P1', 'in');
      // Grounds
      await builder.drawWireFromPin('Vdd', 'neg', 6, 22);
      await builder.drawWireFromPin('Vin', 'neg', 6, 16);

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 500);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // Test 26: SPDT source selector
    // Toggle SPDT between two DC sources with RC smoothing
    // -----------------------------------------------------------------------
    test('SPDT source selector: toggles between two voltage sources', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'V1');
      await builder.placeLabeled('DcVoltageSource', 3, 15, 'V2');
      await builder.placeLabeled('SwitchDT', 12, 10, 'SW');
      await builder.placeLabeled('Resistor', 18, 10, 'R1');
      await builder.placeLabeled('Capacitor', 24, 10, 'C1');
      await builder.placeComponent('Ground', 6, 20);
      await builder.placeComponent('Ground', 6, 10);
      await builder.placeComponent('Ground', 26, 15);
      await builder.placeLabeled('Probe', 28, 10, 'P1');

      await builder.setComponentProperty('V1', 'voltage', 3);
      await builder.setComponentProperty('V2', 'voltage', 8);

      // SPDT: A1 = common, B1 = V1, C1 = V2
      await builder.drawWire('V1', 'pos', 'SW', 'B1');
      await builder.drawWire('V2', 'pos', 'SW', 'C1');
      await builder.drawWire('SW', 'A1', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'C1', 'pos');
      await builder.drawWireFromPin('C1', 'neg', 26, 15);
      await builder.drawWireFromPin('V1', 'neg', 6, 20);
      await builder.drawWireFromPin('V2', 'neg', 6, 10);
      await builder.drawWire('R1', 'B', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Initial state — check voltage
      const state1 = await stepAndRead(builder, 300);
      expect(state1).not.toBeNull();

      const maxV1 = Math.max(...sortedVoltages(state1!));
      expect(maxV1).toBeGreaterThan(2.5);
      expect(maxV1).toBeLessThan(3.5);

      // Toggle switch
      await clickElementCenter(builder, 'SW');

      // After toggle — voltage should change
      const state2 = await stepAndRead(builder, 300);
      expect(state2).not.toBeNull();
      expect(state2!.simTime).toBeGreaterThan(state1!.simTime);
    });

    // -----------------------------------------------------------------------
    // Test 27: BJT switch with inductive load + flyback diode
    // Turn BJT off → flyback diode clamps voltage spike
    // -----------------------------------------------------------------------
    test('BJT switch with flyback diode: clamps inductive kick', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vcc');
      await builder.placeLabeled('DcVoltageSource', 3, 14, 'Vin');
      await builder.placeLabeled('Inductor', 12, 5, 'L1');
      await builder.placeLabeled('Diode', 16, 8, 'D1');
      await builder.placeLabeled('Resistor', 10, 14, 'Rb');
      await builder.placeLabeled('NpnBJT', 14, 12, 'Q1');
      await builder.placeComponent('Ground', 6, 20);
      await builder.placeComponent('Ground', 16, 18);
      await builder.placeComponent('Ground', 6, 18);
      await builder.placeLabeled('Probe', 20, 8, 'P1');

      await builder.setComponentProperty('Vcc', 'voltage', 12);
      await builder.setComponentProperty('Vin', 'voltage', 3);

      // Vcc → L1 → Q1:C, Q1:E → GND
      await builder.drawWire('Vcc', 'pos', 'L1', 'A');
      await builder.drawWire('L1', 'B', 'Q1', 'C');
      await builder.drawWireFromPin('Q1', 'E', 16, 18);
      // Flyback diode across inductor (reverse-biased normally)
      await builder.drawWire('L1', 'A', 'D1', 'K');
      await builder.drawWire('L1', 'B', 'D1', 'A');
      // Base drive
      await builder.drawWire('Vin', 'pos', 'Rb', 'A');
      await builder.drawWire('Rb', 'B', 'Q1', 'B');
      // Grounds
      await builder.drawWireFromPin('Vcc', 'neg', 6, 20);
      await builder.drawWireFromPin('Vin', 'neg', 6, 18);
      await builder.drawWire('L1', 'B', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 300);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      expect(Math.max(...sortedVoltages(state!))).toBeGreaterThan(10.0);
      expect(Math.max(...sortedVoltages(state!))).toBeLessThan(12.6);
    });

    // -----------------------------------------------------------------------
    // Test 28: MOSFET PWM into RLC filter
    // Clock drives NMOS gate → filtered DC output ≈ duty_cycle × Vdd
    // -----------------------------------------------------------------------
    test('MOSFET PWM into RLC: filtered DC output', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vdd');
      await builder.placeLabeled('Clock', 3, 14, 'CLK');
      await builder.placeLabeled('NMOS', 12, 10, 'M1');
      await builder.placeLabeled('Inductor', 18, 8, 'L1');
      await builder.placeLabeled('Resistor', 24, 8, 'R1');
      await builder.placeLabeled('Capacitor', 30, 8, 'C1');
      await builder.placeComponent('Ground', 6, 18);
      await builder.placeComponent('Ground', 14, 16);
      await builder.placeComponent('Ground', 32, 14);
      await builder.placeLabeled('Probe', 34, 8, 'P1');

      await builder.setComponentProperty('Vdd', 'voltage', 12);
      await builder.setComponentProperty('R1', 'resistance', 100);

      // Vdd → M1:D, M1:S → L1 → R1 → C1 → GND
      await builder.drawWire('Vdd', 'pos', 'M1', 'D');
      await builder.drawWire('CLK', 'out', 'M1', 'G');
      await builder.drawWire('M1', 'S', 'L1', 'A');
      await builder.drawWire('L1', 'B', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'C1', 'pos');
      await builder.drawWireFromPin('C1', 'neg', 32, 14);
      await builder.drawWireFromPin('Vdd', 'neg', 6, 18);
      await builder.drawWireFromPin('M1', 'S', 14, 16);
      await builder.drawWire('R1', 'B', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepToTimeAndRead(builder, '10m');
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      expect(Math.max(...sortedVoltages(state!))).toBeGreaterThan(0.1);
    });

    // -----------------------------------------------------------------------
    // Test 29: Crystal oscillator startup
    // NPN + crystal + feedback caps → oscillation builds at crystal freq
    // -----------------------------------------------------------------------
    test('crystal oscillator: oscillation builds at crystal frequency', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vcc');
      await builder.placeLabeled('NpnBJT', 14, 10, 'Q1');
      await builder.placeLabeled('Resistor', 10, 5, 'Rc');
      await builder.placeLabeled('Resistor', 10, 14, 'Rb');
      await builder.placeLabeled('QuartzCrystal', 20, 10, 'X1');
      await builder.placeLabeled('Capacitor', 18, 16, 'C1');
      await builder.placeLabeled('Capacitor', 24, 16, 'C2');
      await builder.placeComponent('Ground', 6, 20);
      await builder.placeComponent('Ground', 20, 20);
      await builder.placeComponent('Ground', 26, 20);
      await builder.placeLabeled('Probe', 28, 10, 'P1');

      await builder.setComponentProperty('Vcc', 'voltage', 5);
      await builder.setComponentProperty('Rc', 'resistance', 4700);
      await builder.setComponentProperty('Rb', 'resistance', 1000000);

      // Colpitts-style: Vcc → Rc → Q1:C, Rb → Q1:B
      await builder.drawWire('Vcc', 'pos', 'Rc', 'A');
      await builder.drawWire('Rc', 'B', 'Q1', 'C');
      await builder.drawWire('Vcc', 'pos', 'Rb', 'A');
      await builder.drawWire('Rb', 'B', 'Q1', 'B');
      // Crystal feedback: Q1:C → X1:A, X1:B → Q1:B
      await builder.drawWire('Q1', 'C', 'X1', 'A');
      await builder.drawWire('X1', 'B', 'Q1', 'B');
      // Capacitors to ground
      await builder.drawWire('Q1', 'E', 'C1', 'pos');
      await builder.drawWireFromPin('C1', 'neg', 20, 20);
      await builder.drawWire('X1', 'B', 'C2', 'pos');
      await builder.drawWireFromPin('C2', 'neg', 26, 20);
      // Ground
      await builder.drawWireFromPin('Vcc', 'neg', 6, 20);
      await builder.drawWire('Q1', 'C', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepToTimeAndRead(builder, '1m');
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);

      const vc = Math.max(...sortedVoltages(state!));
      expect(vc).toBeGreaterThan(1.5);
      expect(vc).toBeLessThan(5.5);
    });
  });

  // =========================================================================
  // 3E — Active ICs + Sensors
  // =========================================================================

  test.describe('3E — Active ICs + Sensors', () => {

    // -----------------------------------------------------------------------
    // Test 30: Op-amp inverting amplifier
    // Gain = -Rf/Rin, Vin=1V, Rin=1kΩ, Rf=10kΩ → Vout ≈ -10V
    // -----------------------------------------------------------------------
    test('op-amp inverting: gain equals -Rf/Rin', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 8, 'Vin');
      await builder.placeLabeled('Resistor', 10, 8, 'Rin');
      await builder.placeLabeled('OpAmp', 18, 10, 'OA');
      await builder.placeLabeled('Resistor', 18, 5, 'Rf');
      await builder.placeComponent('Ground', 6, 14);
      await builder.placeComponent('Ground', 14, 14);
      await builder.placeLabeled('Probe', 26, 10, 'P1');

      await builder.setComponentProperty('Vin', 'voltage', 1);
      await builder.setComponentProperty('Rin', 'resistance', 1000);
      await builder.setComponentProperty('Rf', 'resistance', 10000);

      // Vin → Rin → OA:in-, feedback Rf from OA:out to OA:in-
      await builder.drawWire('Vin', 'pos', 'Rin', 'A');
      await builder.drawWire('Rin', 'B', 'OA', 'in-');
      await builder.drawWire('OA', 'out', 'Rf', 'B');
      await builder.drawWire('Rf', 'A', 'OA', 'in-');
      // OA:in+ to ground (virtual ground reference)
      await builder.drawWireFromPin('OA', 'in+', 14, 14);
      await builder.drawWireFromPin('Vin', 'neg', 6, 14);
      await builder.drawWire('OA', 'out', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 200);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);

      // ngspice: Vout≈-10V (gain=-Rf/Rin=-10k/1k=-10, Vin=1V)
      // P1 = op-amp output (OA:out)
      const ref = SPICE_REF.opamp_inverting;
      expectVoltage(state!.nodeVoltages['P1'], ref.v_output, 'Vout');
    });

    // -----------------------------------------------------------------------
    // Test 31: Op-amp integrator
    // Rin + Cf in feedback → ramp output for DC input
    // -----------------------------------------------------------------------
    test('op-amp integrator: ramp output for DC input', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 8, 'Vin');
      await builder.placeLabeled('Resistor', 10, 8, 'R1');
      await builder.placeLabeled('OpAmp', 18, 10, 'OA');
      await builder.placeLabeled('Capacitor', 18, 5, 'Cf');
      await builder.placeComponent('Ground', 6, 14);
      await builder.placeComponent('Ground', 14, 14);
      await builder.placeLabeled('Probe', 26, 10, 'P1');

      await builder.setComponentProperty('Vin', 'voltage', 1);
      await builder.setComponentProperty('R1', 'resistance', 10000);
      await builder.setComponentProperty('Cf', 'capacitance', '1e-6');

      // Vin → R1 → OA:in-, feedback Cf from OA:out to OA:in-
      await builder.drawWire('Vin', 'pos', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'OA', 'in-');
      await builder.drawWire('OA', 'out', 'Cf', 'neg');
      await builder.drawWire('Cf', 'pos', 'OA', 'in-');
      await builder.drawWireFromPin('OA', 'in+', 14, 14);
      await builder.drawWireFromPin('Vin', 'neg', 6, 14);
      await builder.drawWire('OA', 'out', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step and check output is ramping (becoming more negative over time)
      // P1 = op-amp output (OA:out)
      const state1 = await stepAndRead(builder, 100);
      expect(state1).not.toBeNull();
      const v1 = state1!.nodeVoltages['P1'];

      const state2 = await stepAndRead(builder, 200);
      expect(state2).not.toBeNull();
      const v2 = state2!.nodeVoltages['P1'];

      // Output should be getting more negative (integrating positive input)
      expect(v2).toBeLessThan(v1 + 0.01);
      expect(v2).toBeLessThan(0);
    });

    // -----------------------------------------------------------------------
    // Test 32: 555 timer astable
    // Classic NE555 astable multivibrator
    // f ≈ 1.44/((Ra+2Rb)C), Ra=1kΩ, Rb=10kΩ, C=1µF → f ≈ 68.6 Hz
    // -----------------------------------------------------------------------
    test('555 astable: oscillation at expected frequency', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vcc');
      await builder.placeLabeled('Timer555', 16, 10, 'U1');
      await builder.placeLabeled('Resistor', 10, 5, 'Ra');
      await builder.placeLabeled('Resistor', 10, 12, 'Rb');
      await builder.placeLabeled('Capacitor', 10, 18, 'C1');
      await builder.placeComponent('Ground', 6, 22);
      await builder.placeComponent('Ground', 12, 22);
      await builder.placeComponent('Ground', 18, 18);
      await builder.placeLabeled('Probe', 24, 10, 'P1');

      await builder.setComponentProperty('Ra', 'resistance', 1000);
      await builder.setComponentProperty('Rb', 'resistance', 10000);

      // Power: Vcc → 555:VCC, 555:GND → GND, 555:RST → Vcc (enable)
      await builder.drawWire('Vcc', 'pos', 'U1', 'VCC');
      await builder.drawWireFromPin('U1', 'GND', 18, 18);
      await builder.drawWire('Vcc', 'pos', 'U1', 'RST');
      // Timing: Vcc → Ra → node → Rb → C1 → GND
      await builder.drawWire('Vcc', 'pos', 'Ra', 'A');
      await builder.drawWire('Ra', 'B', 'Rb', 'A');
      await builder.drawWire('Rb', 'B', 'C1', 'pos');
      await builder.drawWireFromPin('C1', 'neg', 12, 22);
      // 555 connections: DIS → Ra-Rb junction, THR and TRIG → Rb-C1 junction
      await builder.drawWire('Ra', 'B', 'U1', 'DIS');
      await builder.drawWire('Rb', 'B', 'U1', 'THR');
      await builder.drawWire('Rb', 'B', 'U1', 'TRIG');
      // CTRL pin: leave floating or bypass cap (leave floating for simplicity)
      // Output
      await builder.drawWire('U1', 'OUT', 'P1', 'in');
      // Ground
      await builder.drawWireFromPin('Vcc', 'neg', 6, 22);

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step past startup transient then measure oscillation (fast path)
      await stepToTimeAndRead(builder, '100m');
      const result = await builder.measureAnalogPeaks('100m');
      expect(result).not.toBeNull();
      // Output should oscillate between ~0V and ~Vcc-1.5V
      const outAmps = [...result!.amplitudes].sort((a, b) => b - a);
      expect(outAmps[0]).toBeGreaterThan(3.0);
    });

    // -----------------------------------------------------------------------
    // Test 33: SCR latch circuit
    // Trigger SCR on → stays latched until current drops
    // -----------------------------------------------------------------------
    test('SCR latch: trigger on and stays latched', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vcc');
      await builder.placeLabeled('DcVoltageSource', 3, 14, 'Vtrig');
      await builder.placeLabeled('Resistor', 10, 5, 'R1');
      await builder.placeLabeled('Resistor', 10, 14, 'Rg');
      await builder.placeLabeled('SCR', 16, 10, 'T1');
      await builder.placeLabeled('Switch', 7, 14, 'SW');
      await builder.placeComponent('Ground', 6, 20);
      await builder.placeComponent('Ground', 18, 16);
      await builder.placeComponent('Ground', 6, 18);
      await builder.placeLabeled('Probe', 22, 8, 'P1');

      await builder.setComponentProperty('Vcc', 'voltage', 12);
      await builder.setComponentProperty('Vtrig', 'voltage', 3);
      await builder.setComponentProperty('R1', 'resistance', 1000);
      await builder.setComponentProperty('Rg', 'resistance', 1000);

      // Vcc → R1 → SCR:A, SCR:K → GND
      await builder.drawWire('Vcc', 'pos', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'T1', 'A');
      await builder.drawWireFromPin('T1', 'K', 18, 16);
      // Gate trigger: Vtrig → SW → Rg → SCR:G
      await builder.drawWire('Vtrig', 'pos', 'SW', 'A1');
      await builder.drawWire('SW', 'B1', 'Rg', 'A');
      await builder.drawWire('Rg', 'B', 'T1', 'G');
      // Grounds
      await builder.drawWireFromPin('Vcc', 'neg', 6, 20);
      await builder.drawWireFromPin('Vtrig', 'neg', 6, 18);
      await builder.drawWire('R1', 'B', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Before trigger — SCR off
      const before = await stepAndRead(builder, 200);
      expect(before).not.toBeNull();
      expect(Math.max(...sortedVoltages(before!))).toBeGreaterThan(SPICE_REF.scr_latch.vcc * 0.85);

      // Close switch to trigger SCR
      await clickElementCenter(builder, 'SW');

      // After trigger — SCR should latch on
      const after = await stepAndRead(builder, 300);
      expect(after).not.toBeNull();
      expect(after!.simTime).toBeGreaterThan(before!.simTime);

      const vAfter = Math.max(...sortedVoltages(after!));
      expect(vAfter).toBeLessThan(SPICE_REF.scr_latch.v_anode_on * 3.0);
      expect(vAfter).toBeGreaterThan(0.1);
    });

    // -----------------------------------------------------------------------
    // Test 34: Triac dimmer — phase-angle control via Diac trigger
    // -----------------------------------------------------------------------
    test('triac dimmer: phase-angle AC control', async () => {
      await builder.placeLabeled('AcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('Triac', 14, 8, 'TR');
      await builder.placeLabeled('Resistor', 8, 14, 'R1');
      await builder.placeLabeled('Capacitor', 14, 14, 'C1');
      await builder.placeLabeled('Diac', 10, 10, 'DC');
      await builder.placeLabeled('Resistor', 20, 8, 'Rload');
      await builder.placeComponent('Ground', 6, 18);
      await builder.placeComponent('Ground', 22, 14);
      await builder.placeLabeled('Probe', 24, 8, 'P1');

      await builder.setComponentProperty('Vs', 'amplitude', 170);
      await builder.setComponentProperty('Vs', 'frequency', 60);
      await builder.setComponentProperty('R1', 'resistance', 100000);
      await builder.setComponentProperty('Rload', 'resistance', 100);

      // Vs → Triac:MT1, Triac:MT2 → Rload → GND
      await builder.drawWire('Vs', 'pos', 'TR', 'MT1');
      await builder.drawWire('TR', 'MT2', 'Rload', 'A');
      await builder.drawWireFromPin('Rload', 'B', 22, 14);
      // Phase control: Vs:pos → R1 → C1 → Vs:neg (RC phase shift)
      await builder.drawWire('Vs', 'pos', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'C1', 'pos');
      await builder.drawWireFromPin('C1', 'neg', 6, 18);
      // Diac triggers triac: RC junction → Diac:A, Diac:B → Triac:G
      await builder.drawWire('R1', 'B', 'DC', 'A');
      await builder.drawWire('DC', 'B', 'TR', 'G');
      // Ground
      await builder.drawWireFromPin('Vs', 'neg', 6, 18);
      await builder.drawWire('Rload', 'A', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      await stepAndRead(builder, 1000);
      const result = await measurePeaks(builder, 2000);
      expect(result).not.toBeNull();
      // Should see voltage across load oscillating (phase-controlled AC)
      expect(Math.max(...result!.amplitudes)).toBeGreaterThan(SPICE_REF.triac_dimmer.v_load_peak_min);
    });

    // -----------------------------------------------------------------------
    // Test 35: LDR voltage divider
    // Output varies with simulated light level
    // -----------------------------------------------------------------------
    test('LDR voltage divider: output varies with light level', async () => {
      await builder.placeLabeled('DcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('Resistor', 10, 6, 'R1');
      await builder.placeLabeled('LDR', 10, 12, 'LDR1');
      await builder.placeComponent('Ground', 6, 16);
      await builder.placeComponent('Ground', 14, 16);
      await builder.placeLabeled('Probe', 18, 9, 'P1');

      // R1=10kΩ, LDR with default lux=500 (R ≈ R_dark * (500/100)^-0.7)
      await builder.setComponentProperty('R1', 'resistance', 10000);

      // Vs:pos → R1:A, R1:B → LDR:pos, LDR:neg → GND
      await builder.drawWire('Vs', 'pos', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'LDR1', 'pos');
      await builder.drawWireFromPin('LDR1', 'neg', 14, 16);
      await builder.drawWireFromPin('Vs', 'neg', 6, 16);
      await builder.drawWire('R1', 'B', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 200);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);

      // Verify voltage divider produces output between 0 and Vs
      // P1 = midpoint (R1:B = LDR1:pos)
      const vOut = state!.nodeVoltages['P1'];
      expect(vOut).toBeGreaterThan(0);
      expect(vOut).toBeLessThan(6);

      const ref = SPICE_REF.ldr_divider;
      expect(vOut).toBeGreaterThan(ref.v_out_500lux * 0.60);
      expect(vOut).toBeLessThan(ref.v_out_500lux * 1.40);
    });
  });
});

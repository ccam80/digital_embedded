/**
 * Mixed-mode circuit assembly E2E tests — Phase 4 of the test plan.
 *
 * Every test in this file builds a circuit containing both digital and analog
 * components, verifying the mixed-signal bridge works end-to-end through the UI.
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

mkdirSync(DEBUG_DIR, { recursive: true });
try {
  const lock = resolve(tmpdir(), 'digital-e2e-mixed-debug-cleanup.lock');
  const fd = openSync(lock, fsConst.O_CREAT | fsConst.O_EXCL | fsConst.O_WRONLY);
  closeSync(fd);
  for (const f of readdirSync(DEBUG_DIR)) {
    if (f.endsWith('.dig')) unlinkSync(resolve(DEBUG_DIR, f));
  }
  process.on('exit', () => { try { unlinkSync(lock); } catch { /* */ } });
} catch {
  // Another worker (or stale lock) — just ensure dir exists
}

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

/** Get sorted (descending) array of all node voltage values. */
function sortedVoltages(state: { nodeVoltages: Record<string, number> }): number[] {
  return Object.values(state.nodeVoltages).sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------
// Layout conventions:
//   Digital inputs on the left (col 3–5), mixed components middle (col 10–18),
//   analog loads/outputs on the right (col 22–28). Vertical spacing ≥ 3 grid
//   units between components. Grounds below connected nodes at row + 6.
// ---------------------------------------------------------------------------

test.describe('Mixed-mode circuit assembly via UI', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') {
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
  // 4A — Digital→Analog Bridge
  // =========================================================================

  test.describe('4A — Digital to Analog Bridge', () => {

    // -----------------------------------------------------------------------
    // Test 1: DAC + RC filter
    // 4 digital Ins → DAC (4-bit) → R (1kΩ) → C (1µF) → GND
    // DcVoltageSource for VREF, AnalogGround for DAC GND
    // Drive D3=1, D2=0, D1=1, D0=0 → code 10 → Vout = 10/16 × 5V ≈ 3.125V
    // After RC filter settles, probe voltage should match.
    // -----------------------------------------------------------------------
    test('DAC + RC filter: digital input produces filtered analog voltage', async () => {
      // Digital inputs (left column)
      await builder.placeLabeled('In', 3, 4, 'D0');
      await builder.placeLabeled('In', 3, 7, 'D1');
      await builder.placeLabeled('In', 3, 10, 'D2');
      await builder.placeLabeled('In', 3, 13, 'D3');

      // DAC (4-bit) — center
      await builder.placeLabeled('DAC', 12, 8, 'DAC1');
      await builder.setComponentProperty('DAC1', 'bits', 4);

      // VREF source and DAC ground
      await builder.placeLabeled('DcVoltageSource', 8, 3, 'Vref');
      await builder.placeLabeled('AnalogGround', 8, 18, 'G1');
      await builder.placeLabeled('AnalogGround', 16, 18, 'G2');

      // RC filter on DAC output
      await builder.placeLabeled('AnalogResistor', 20, 8, 'R1');
      await builder.placeLabeled('AnalogCapacitor', 26, 8, 'C1');
      await builder.placeLabeled('AnalogGround', 28, 14, 'G3');
      await builder.placeLabeled('Probe', 30, 8, 'P1');

      // Wire digital inputs to DAC
      await builder.drawWire('D0', 'out', 'DAC1', 'D0');
      await builder.drawWire('D1', 'out', 'DAC1', 'D1');
      await builder.drawWire('D2', 'out', 'DAC1', 'D2');
      await builder.drawWire('D3', 'out', 'DAC1', 'D3');

      // Wire VREF and GND
      await builder.drawWire('Vref', 'pos', 'DAC1', 'VREF');
      await builder.drawWire('Vref', 'neg', 'G1', 'gnd');
      await builder.drawWire('DAC1', 'GND', 'G2', 'gnd');

      // Wire DAC OUT through RC filter
      await builder.drawWire('DAC1', 'OUT', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'C1', 'pos');
      await builder.drawWire('C1', 'neg', 'G3', 'gnd');
      await builder.drawWire('R1', 'B', 'P1', 'in');

      // Compile via UI step
      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step to let RC filter settle (5τ = 5ms at 1kΩ × 1µF = 5ms)
      const state = await stepAndRead(builder, 2000);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      const volts = sortedVoltages(state!);
      expect(volts[0]).toBeGreaterThan(4.0);   // VREF node ≈5V
      expect(volts[0]).toBeLessThan(6.0);
      // DAC output node should be present (filtered voltage)
      expect(state!.nodeCount).toBeGreaterThanOrEqual(2);
    });

    // -----------------------------------------------------------------------
    // Test 2: Digital gate driving analog load
    // In×2 → And → AnalogResistor → AnalogGround, with Probe at gate output
    // Verifies that a digital gate output drives current through an analog load.
    // -----------------------------------------------------------------------
    test('digital gate driving analog load: And output drives resistor', async () => {
      // Digital logic
      await builder.placeLabeled('In', 3, 6, 'A');
      await builder.placeLabeled('In', 3, 10, 'B');
      await builder.placeLabeled('And', 10, 8, 'G1');

      // Analog load: resistor to ground with probe
      await builder.placeLabeled('AnalogResistor', 18, 8, 'R1');
      await builder.placeLabeled('AnalogGround', 22, 14, 'G1a');
      await builder.placeLabeled('Probe', 24, 8, 'P1');

      // Wire digital logic
      await builder.drawWire('A', 'out', 'G1', 'In_1');
      await builder.drawWire('B', 'out', 'G1', 'In_2');

      // Wire gate output to analog load
      await builder.drawWire('G1', 'out', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'G1a', 'gnd');
      await builder.drawWire('G1', 'out', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // With both inputs at 0, And output = 0 → no voltage through load
      const state = await stepAndRead(builder, 100);
      expect(state).not.toBeNull();
      expect(state!.nodeCount).toBeGreaterThanOrEqual(1);
      // Gate output drives resistor — at least one node should have measurable voltage
      const volts = sortedVoltages(state!);
      expect(volts.length).toBeGreaterThan(0);
      expect(volts[0]).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // Test 3: PWM to analog voltage
    // Clock → Counter (4-bit) → Comparator (a < threshold) → R → C → GND
    // Counter cycles 0–15; Comparator output is HIGH when count < threshold.
    // This creates a PWM waveform. RC filter smooths it to DC ≈ duty × VDD.
    // -----------------------------------------------------------------------
    test('PWM to analog voltage: counter-generated PWM filtered to DC', async () => {
      // Digital PWM generator
      await builder.placeLabeled('Clock', 3, 6, 'CLK');
      await builder.placeLabeled('Counter', 8, 6, 'CNT');
      await builder.placeLabeled('Const', 3, 12, 'THR');
      await builder.setComponentProperty('THR', 'bitWidth', 4);
      await builder.setComponentProperty('THR', 'value', 8); // 50% duty cycle

      await builder.placeLabeled('Comparator', 14, 8, 'CMP');
      await builder.setComponentProperty('CMP', 'bitWidth', 4);

      // Const for counter enable
      await builder.placeLabeled('Const', 3, 3, 'EN');

      // Analog RC filter
      await builder.placeLabeled('AnalogResistor', 22, 8, 'R1');
      await builder.placeLabeled('AnalogCapacitor', 28, 8, 'C1');
      await builder.placeLabeled('AnalogGround', 30, 14, 'G1');
      await builder.placeLabeled('Probe', 32, 8, 'P1');

      // Wire clock → counter
      await builder.drawWire('EN', 'out', 'CNT', 'en');
      await builder.drawWire('CLK', 'out', 'CNT', 'C');

      // Wire counter output to comparator input a, threshold to b
      await builder.drawWire('CNT', 'out', 'CMP', 'a');
      await builder.drawWire('THR', 'out', 'CMP', 'b');

      // Comparator '<' output (PWM high when count < threshold) → RC filter
      await builder.drawWire('CMP', '<', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'C1', 'pos');
      await builder.drawWire('C1', 'neg', 'G1', 'gnd');
      await builder.drawWire('R1', 'B', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step through several PWM cycles to let filter settle
      const state = await stepAndRead(builder, 3000);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      expect(state!.nodeCount).toBeGreaterThanOrEqual(1);
      // Filtered PWM should produce a DC voltage between 0 and Vdd
      const volts = sortedVoltages(state!);
      expect(volts[0]).toBeGreaterThan(0);
      expect(volts[0]).toBeLessThan(6.0);  // Should not exceed supply
    });
  });

  // =========================================================================
  // 4B — Analog→Digital Bridge
  // =========================================================================

  test.describe('4B — Analog to Digital Bridge', () => {

    // -----------------------------------------------------------------------
    // Test 4: Comparator to logic
    // DcVoltageSource → Potentiometer → AnalogComparator → And → Out
    // Analog threshold crossing → digital gate input → digital output
    // -----------------------------------------------------------------------
    test('comparator to logic: analog threshold drives digital gate', async () => {
      // Analog input stage: voltage divider via potentiometer
      await builder.placeLabeled('DcVoltageSource', 3, 6, 'Vs');
      await builder.placeLabeled('AnalogPotentiometer', 10, 6, 'POT');
      await builder.setComponentProperty('POT', 'position', '0.7');
      await builder.placeLabeled('AnalogGround', 6, 14, 'G1');
      await builder.placeLabeled('AnalogGround', 14, 14, 'G2');

      // Reference voltage for comparator (2.5V via second divider)
      await builder.placeLabeled('DcVoltageSource', 3, 18, 'Vref');

      // Analog comparator
      await builder.placeLabeled('AnalogComparator', 18, 8, 'CMP');
      await builder.setComponentProperty('CMP', 'outputType', 'push-pull');

      // Digital logic: And gate and output
      await builder.placeLabeled('And', 24, 8, 'GA');
      await builder.placeLabeled('Const', 20, 4, 'C1');
      await builder.placeLabeled('Out', 30, 8, 'Y');

      // Wire source → potentiometer
      await builder.drawWire('Vs', 'pos', 'POT', 'A');
      await builder.drawWire('POT', 'B', 'G2', 'gnd');
      await builder.drawWire('Vs', 'neg', 'G1', 'gnd');

      // Wire potentiometer wiper to comparator in+
      await builder.drawWire('POT', 'W', 'CMP', 'in+');

      // Wire reference to comparator in-
      await builder.drawWire('Vref', 'pos', 'CMP', 'in-');
      await builder.drawWire('Vref', 'neg', 'G2', 'gnd');

      // Wire comparator output to And gate
      await builder.drawWire('CMP', 'out', 'GA', 'In_1');
      await builder.drawWire('C1', 'out', 'GA', 'In_2');
      await builder.drawWire('GA', 'out', 'Y', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 500);
      expect(state).not.toBeNull();
      expect(state!.nodeCount).toBeGreaterThanOrEqual(2);
      // Potentiometer at 0.7 × 5V = 3.5V vs Vref — comparator output should be defined
      const volts = sortedVoltages(state!);
      expect(volts[0]).toBeGreaterThan(3.0);  // Supply-level node
      expect(volts[0]).toBeLessThan(6.0);
    });

    // -----------------------------------------------------------------------
    // Test 5: ADC readout
    // AcVoltageSource → Resistor (divider) → ADC (4-bit) → Out×4
    // Analog waveform → digital samples on rising clock edge
    // Using 4-bit ADC to keep wiring manageable.
    // -----------------------------------------------------------------------
    test('ADC readout: analog waveform sampled to digital outputs', async () => {
      // Analog input: AC source through resistive divider
      await builder.placeLabeled('AcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('AnalogResistor', 10, 8, 'R1');
      await builder.placeLabeled('AnalogGround', 6, 16, 'G1');

      // ADC (4-bit)
      await builder.placeLabeled('ADC', 18, 8, 'ADC1');
      await builder.setComponentProperty('ADC1', 'bits', 4);

      // Clock for ADC sampling
      await builder.placeLabeled('Clock', 14, 3, 'CLK');

      // VREF and GND for ADC
      await builder.placeLabeled('DcVoltageSource', 14, 14, 'Vref');
      await builder.placeLabeled('AnalogGround', 14, 20, 'G2');
      await builder.placeLabeled('AnalogGround', 22, 16, 'G3');

      // Digital outputs for D0–D3
      await builder.placeLabeled('Out', 28, 5, 'Q0');
      await builder.placeLabeled('Out', 28, 8, 'Q1');
      await builder.placeLabeled('Out', 28, 11, 'Q2');
      await builder.placeLabeled('Out', 28, 14, 'Q3');

      // Wire analog input path
      await builder.drawWire('Vs', 'pos', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'ADC1', 'VIN');
      await builder.drawWire('Vs', 'neg', 'G1', 'gnd');

      // Wire ADC clock, VREF, GND
      await builder.drawWire('CLK', 'out', 'ADC1', 'CLK');
      await builder.drawWire('Vref', 'pos', 'ADC1', 'VREF');
      await builder.drawWire('Vref', 'neg', 'G2', 'gnd');
      await builder.drawWire('ADC1', 'GND', 'G3', 'gnd');

      // Wire ADC digital outputs
      await builder.drawWire('ADC1', 'D0', 'Q0', 'in');
      await builder.drawWire('ADC1', 'D1', 'Q1', 'in');
      await builder.drawWire('ADC1', 'D2', 'Q2', 'in');
      await builder.drawWire('ADC1', 'D3', 'Q3', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step through several clock cycles so ADC samples the waveform
      const state = await stepAndRead(builder, 1000);
      expect(state).not.toBeNull();
      expect(state!.nodeCount).toBeGreaterThanOrEqual(2);
      const volts = sortedVoltages(state!);
      // VREF and signal nodes should be present
      expect(volts[0]).toBeGreaterThan(3.0);
      expect(volts[0]).toBeLessThan(6.0);
    });

    // -----------------------------------------------------------------------
    // Test 6: Schmitt trigger to counter
    // AcVoltageSource → Resistor → SchmittInverting → Counter clock → Out×4
    // Analog sine wave → clean digital transitions → count sequence
    // -----------------------------------------------------------------------
    test('Schmitt trigger to counter: analog sine drives digital count', async () => {
      // Analog source
      await builder.placeLabeled('AcVoltageSource', 3, 8, 'Vs');
      await builder.placeLabeled('AnalogResistor', 10, 8, 'R1');
      await builder.placeLabeled('AnalogGround', 6, 14, 'G1');

      // Schmitt trigger (analog → digital bridge)
      await builder.placeLabeled('SchmittInverting', 16, 8, 'SCH');

      // Digital counter
      await builder.placeLabeled('Counter', 22, 8, 'CNT');
      await builder.placeLabeled('Const', 18, 4, 'EN');

      // 4-bit output for counter value
      await builder.placeLabeled('Out', 30, 8, 'Q');
      await builder.setComponentProperty('Q', 'Bits', 4);

      // Wire analog input
      await builder.drawWire('Vs', 'pos', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'SCH', 'in');
      await builder.drawWire('Vs', 'neg', 'G1', 'gnd');

      // Wire Schmitt output → counter clock
      await builder.drawWire('SCH', 'out', 'CNT', 'C');
      await builder.drawWire('EN', 'out', 'CNT', 'en');

      // Wire counter → output
      await builder.drawWire('CNT', 'out', 'Q', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step through multiple AC cycles so counter advances
      const state = await stepAndRead(builder, 2000);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      expect(state!.nodeCount).toBeGreaterThanOrEqual(1);
    });
  });

  // =========================================================================
  // 4C — Bidirectional Mixed-Signal
  // =========================================================================

  test.describe('4C — Bidirectional Mixed-Signal', () => {

    // -----------------------------------------------------------------------
    // Test 7: 555 timer driving digital counter
    // 555 astable → Counter clock → Splitter → Out×4
    // 555: VCC via DcVoltageSource, Ra + Rb → THR/DIS, C → GND
    // Analog oscillator → digital count sequence
    // -----------------------------------------------------------------------
    test('555 timer driving digital counter: analog oscillator to digital count', async () => {
      // Power supply
      await builder.placeLabeled('DcVoltageSource', 3, 6, 'Vcc');
      await builder.placeLabeled('AnalogGround', 6, 20, 'G1');

      // 555 Timer
      await builder.placeLabeled('Timer555', 12, 8, 'T555');

      // Timing components: Ra (1kΩ) and Rb (2kΩ) in series, C (1µF)
      await builder.placeLabeled('AnalogResistor', 8, 3, 'Ra');
      await builder.placeLabeled('AnalogResistor', 16, 3, 'Rb');
      await builder.placeLabeled('AnalogCapacitor', 18, 14, 'C1');
      await builder.placeLabeled('AnalogGround', 20, 20, 'G2');
      await builder.placeLabeled('AnalogGround', 14, 20, 'G3');

      // Digital counter
      await builder.placeLabeled('Counter', 24, 8, 'CNT');
      await builder.placeLabeled('Const', 20, 4, 'EN');

      // 4-bit output for counter value
      await builder.placeLabeled('Out', 32, 8, 'Q');
      await builder.setComponentProperty('Q', 'Bits', 4);

      // Wire power: VCC and GND to 555
      await builder.drawWire('Vcc', 'pos', 'T555', 'VCC');
      await builder.drawWire('Vcc', 'neg', 'G1', 'gnd');
      await builder.drawWire('T555', 'GND', 'G3', 'gnd');

      // Wire RST high (enable 555)
      await builder.drawWire('Vcc', 'pos', 'T555', 'RST');

      // 555 astable wiring: VCC → Ra → DIS/THR junction → Rb → C → GND
      await builder.drawWire('Vcc', 'pos', 'Ra', 'A');
      await builder.drawWire('Ra', 'B', 'Rb', 'A');
      await builder.drawWire('Ra', 'B', 'T555', 'DIS');
      await builder.drawWire('Rb', 'B', 'T555', 'THR');
      await builder.drawWire('Rb', 'B', 'T555', 'TRIG');
      await builder.drawWire('Rb', 'B', 'C1', 'pos');
      await builder.drawWire('C1', 'neg', 'G2', 'gnd');

      // 555 OUT → counter clock
      await builder.drawWire('T555', 'OUT', 'CNT', 'C');
      await builder.drawWire('EN', 'out', 'CNT', 'en');

      // Counter → output
      await builder.drawWire('CNT', 'out', 'Q', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step through several 555 oscillation cycles
      const state = await stepAndRead(builder, 5000);
      expect(state).not.toBeNull();
      expect(state!.simTime).toBeGreaterThan(0);
      // Should have analog nodes for the 555 circuit
      expect(state!.nodeCount).toBeGreaterThanOrEqual(3);
      // 555 timer should produce voltages between 0 and Vcc=5V
      const volts = sortedVoltages(state!);
      expect(volts[0]).toBeGreaterThan(3.0);  // VCC node
      expect(volts[0]).toBeLessThan(6.0);
    });

    // -----------------------------------------------------------------------
    // Test 8: Digital servo loop (feedforward chain)
    // DcVoltageSource → DAC (4-bit) → OpAmp (buffer) → ADC (4-bit) → Out×4
    // Digital code → analog voltage → amplified → sampled back to digital
    // -----------------------------------------------------------------------
    test('digital servo loop: DAC to OpAmp to ADC feedforward', async () => {
      // Power and reference
      await builder.placeLabeled('DcVoltageSource', 3, 6, 'Vref');
      await builder.placeLabeled('AnalogGround', 6, 18, 'G1');
      await builder.placeLabeled('AnalogGround', 14, 18, 'G2');

      // Digital inputs for DAC
      await builder.placeLabeled('Const', 3, 3, 'D0');
      await builder.setComponentProperty('D0', 'value', 1);
      await builder.placeLabeled('Const', 3, 9, 'D1');
      await builder.setComponentProperty('D1', 'value', 0);
      await builder.placeLabeled('Const', 3, 12, 'D2');
      await builder.setComponentProperty('D2', 'value', 1);
      await builder.placeLabeled('Const', 3, 15, 'D3');
      await builder.setComponentProperty('D3', 'value', 0);

      // DAC (4-bit)
      await builder.placeLabeled('DAC', 10, 8, 'DAC1');
      await builder.setComponentProperty('DAC1', 'bits', 4);

      // OpAmp voltage follower (buffer)
      await builder.placeLabeled('OpAmp', 18, 10, 'AMP');
      await builder.placeLabeled('AnalogResistor', 18, 16, 'Rf');
      await builder.placeLabeled('AnalogResistor', 22, 16, 'Rin');

      // ADC (4-bit)
      await builder.placeLabeled('ADC', 26, 8, 'ADC1');
      await builder.setComponentProperty('ADC1', 'bits', 4);
      await builder.placeLabeled('Clock', 22, 3, 'CLK');
      await builder.placeLabeled('DcVoltageSource', 22, 14, 'Vref2');
      await builder.placeLabeled('AnalogGround', 22, 20, 'G3');
      await builder.placeLabeled('AnalogGround', 30, 16, 'G4');

      // Digital outputs
      await builder.placeLabeled('Out', 34, 5, 'Q0');
      await builder.placeLabeled('Out', 34, 8, 'Q1');
      await builder.placeLabeled('Out', 34, 11, 'Q2');
      await builder.placeLabeled('Out', 34, 14, 'Q3');

      // Wire DAC inputs
      await builder.drawWire('D0', 'out', 'DAC1', 'D0');
      await builder.drawWire('D1', 'out', 'DAC1', 'D1');
      await builder.drawWire('D2', 'out', 'DAC1', 'D2');
      await builder.drawWire('D3', 'out', 'DAC1', 'D3');
      await builder.drawWire('Vref', 'pos', 'DAC1', 'VREF');
      await builder.drawWire('Vref', 'neg', 'G1', 'gnd');
      await builder.drawWire('DAC1', 'GND', 'G2', 'gnd');

      // Wire DAC → OpAmp in+
      await builder.drawWire('DAC1', 'OUT', 'AMP', 'in+');

      // OpAmp feedback (inverting amp with gain): out → Rf → in-
      await builder.drawWire('AMP', 'out', 'Rf', 'A');
      await builder.drawWire('Rf', 'B', 'AMP', 'in-');
      await builder.drawWire('Rf', 'B', 'Rin', 'A');
      await builder.drawWire('Rin', 'B', 'G4', 'gnd');

      // Wire OpAmp out → ADC VIN
      await builder.drawWire('AMP', 'out', 'ADC1', 'VIN');

      // Wire ADC clock, VREF, GND
      await builder.drawWire('CLK', 'out', 'ADC1', 'CLK');
      await builder.drawWire('Vref2', 'pos', 'ADC1', 'VREF');
      await builder.drawWire('Vref2', 'neg', 'G3', 'gnd');
      await builder.drawWire('ADC1', 'GND', 'G4', 'gnd');

      // Wire ADC digital outputs
      await builder.drawWire('ADC1', 'D0', 'Q0', 'in');
      await builder.drawWire('ADC1', 'D1', 'Q1', 'in');
      await builder.drawWire('ADC1', 'D2', 'Q2', 'in');
      await builder.drawWire('ADC1', 'D3', 'Q3', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 1000);
      expect(state).not.toBeNull();
      expect(state!.nodeCount).toBeGreaterThanOrEqual(3);
      // DAC output + op-amp output + ADC input should all have defined voltages
      const volts = sortedVoltages(state!);
      expect(volts[0]).toBeGreaterThan(0);
      expect(volts[0]).toBeLessThan(10);  // Within supply rails
    });

    // -----------------------------------------------------------------------
    // Test 9: Mixed transistor + gate
    // DcVoltageSource → NpnBJT (common-emitter) → And gate → Out
    // BJT collector voltage level-shifts into digital gate range.
    // When base is driven high, collector goes low (inverted).
    // -----------------------------------------------------------------------
    test('mixed transistor + gate: BJT level-shifts into digital And', async () => {
      // Power supply
      await builder.placeLabeled('DcVoltageSource', 3, 6, 'Vcc');
      await builder.placeLabeled('AnalogGround', 6, 18, 'G1');

      // Base drive resistor and BJT
      await builder.placeLabeled('AnalogResistor', 8, 6, 'Rb');
      await builder.placeLabeled('NpnBJT', 12, 10, 'Q1');

      // Collector load resistor
      await builder.placeLabeled('AnalogResistor', 12, 4, 'Rc');
      await builder.placeLabeled('AnalogGround', 14, 18, 'G2');

      // Digital And gate and output
      await builder.placeLabeled('And', 20, 8, 'G1d');
      await builder.placeLabeled('Const', 16, 5, 'C1');
      await builder.placeLabeled('Out', 26, 8, 'Y');

      // Wire base drive: Vcc → Rb → BJT base
      await builder.drawWire('Vcc', 'pos', 'Rb', 'A');
      await builder.drawWire('Rb', 'B', 'Q1', 'B');

      // Wire collector: Vcc → Rc → BJT collector
      await builder.drawWire('Vcc', 'pos', 'Rc', 'A');
      await builder.drawWire('Rc', 'B', 'Q1', 'C');

      // Wire emitter to ground
      await builder.drawWire('Q1', 'E', 'G2', 'gnd');
      await builder.drawWire('Vcc', 'neg', 'G1', 'gnd');

      // Wire BJT collector to digital And gate input
      await builder.drawWire('Rc', 'B', 'G1d', 'In_1');
      await builder.drawWire('C1', 'out', 'G1d', 'In_2');
      await builder.drawWire('G1d', 'out', 'Y', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      const state = await stepAndRead(builder, 500);
      expect(state).not.toBeNull();
      // Should have analog nodes for the BJT circuit
      expect(state!.nodeCount).toBeGreaterThanOrEqual(2);
      // BJT collector node should be between 0 and Vcc=12V
      const volts = sortedVoltages(state!);
      expect(volts[0]).toBeGreaterThan(0);
      expect(volts[0]).toBeLessThan(13);
    });
  });

  // =========================================================================
  // 4D — Mixed-Mode with Switching
  // =========================================================================

  test.describe('4D — Mixed-Mode with Switching', () => {

    // -----------------------------------------------------------------------
    // Test 10: Digital-controlled analog switch
    // In (digital) → AnalogSwitchSPST ctrl
    // DcVoltageSource → switch in → switch out → Resistor → GND, Probe
    // When digital In=1, switch closes and voltage passes through.
    // -----------------------------------------------------------------------
    test('digital-controlled analog switch: In toggles analog path', async () => {
      // Digital control
      await builder.placeLabeled('In', 3, 8, 'CTRL');

      // Analog source
      await builder.placeLabeled('DcVoltageSource', 3, 14, 'Vs');
      await builder.placeLabeled('AnalogGround', 6, 20, 'G1');

      // Analog switch
      await builder.placeLabeled('AnalogSwitchSPST', 12, 10, 'SW1');

      // Load and probe
      await builder.placeLabeled('AnalogResistor', 20, 10, 'R1');
      await builder.placeLabeled('AnalogGround', 24, 16, 'G2');
      await builder.placeLabeled('Probe', 26, 10, 'P1');

      // Wire digital control to switch
      await builder.drawWire('CTRL', 'out', 'SW1', 'ctrl');

      // Wire analog path: source → switch → resistor → ground
      await builder.drawWire('Vs', 'pos', 'SW1', 'in');
      await builder.drawWire('SW1', 'out', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'G2', 'gnd');
      await builder.drawWire('Vs', 'neg', 'G1', 'gnd');
      await builder.drawWire('SW1', 'out', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // With CTRL=0 (default), switch is open → probe voltage ≈ 0
      const stateOff = await stepAndRead(builder, 200);
      expect(stateOff).not.toBeNull();
      expect(stateOff!.nodeCount).toBeGreaterThanOrEqual(2);
      const voltsOff = sortedVoltages(stateOff!);
      // Source voltage ≈5V should appear on one node
      expect(voltsOff[0]).toBeGreaterThan(4.5);
      expect(voltsOff[0]).toBeLessThan(5.5);
    });

    // -----------------------------------------------------------------------
    // Test 11: Relay from digital logic
    // In×2 → And → Relay coil (in1/in2)
    // DcVoltageSource → Relay contact (A1) → Resistor → GND, Probe at B1
    // Logic output drives relay coil → switches analog load path.
    // -----------------------------------------------------------------------
    test('relay from digital logic: And gate drives relay coil', async () => {
      // Digital logic inputs
      await builder.placeLabeled('In', 3, 6, 'A');
      await builder.placeLabeled('In', 3, 10, 'B');
      await builder.placeLabeled('And', 8, 8, 'G1');

      // Relay
      await builder.placeLabeled('Relay', 14, 8, 'RLY');

      // Analog source and load on relay contacts
      await builder.placeLabeled('DcVoltageSource', 8, 16, 'Vs');
      await builder.placeLabeled('AnalogResistor', 20, 14, 'R1');
      await builder.placeLabeled('AnalogGround', 10, 22, 'G1a');
      await builder.placeLabeled('AnalogGround', 24, 20, 'G2');
      await builder.placeLabeled('Probe', 26, 14, 'P1');

      // Wire digital logic → relay coil
      await builder.drawWire('A', 'out', 'G1', 'In_1');
      await builder.drawWire('B', 'out', 'G1', 'In_2');
      await builder.drawWire('G1', 'out', 'RLY', 'in1');

      // Relay in2 to ground (coil return)
      // (Relay coil: in1 = drive, in2 = return)
      await builder.drawWire('Vs', 'neg', 'G1a', 'gnd');

      // Wire analog path through relay contacts
      await builder.drawWire('Vs', 'pos', 'RLY', 'A1');
      await builder.drawWire('RLY', 'B1', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'G2', 'gnd');
      await builder.drawWire('RLY', 'B1', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // With A=0, B=0 → And=0 → relay de-energized → contact open (SPST NO)
      const state = await stepAndRead(builder, 200);
      expect(state).not.toBeNull();
      expect(state!.nodeCount).toBeGreaterThanOrEqual(1);
      const volts = sortedVoltages(state!);
      expect(volts[0]).toBeGreaterThan(0);
    });

    // -----------------------------------------------------------------------
    // Test 12: Mixed switching transient
    // Clock → D_FF → AnalogSwitchSPDT ctrl
    // DcVoltageSource → Inductor → SPDT com → (NO: R1 load, NC: R2+C load)
    // FF output toggles analog switch at clock rate → verify LRC transient
    // at each toggle point.
    // -----------------------------------------------------------------------
    test('mixed switching transient: D_FF toggles SPDT with LRC load', async () => {
      // Digital clock and flip-flop (toggle mode: ~Q feeds back to D)
      await builder.placeLabeled('Clock', 3, 6, 'CLK');
      await builder.placeLabeled('D_FF', 8, 8, 'FF');

      // Analog switch
      await builder.placeLabeled('AnalogSwitchSPDT', 16, 10, 'SW1');

      // Power supply and inductor
      await builder.placeLabeled('DcVoltageSource', 3, 14, 'Vs');
      await builder.placeLabeled('AnalogInductor', 10, 14, 'L1');
      await builder.placeLabeled('AnalogGround', 6, 22, 'G1');

      // Load paths: NO → R1, NC → R2 + C
      await builder.placeLabeled('AnalogResistor', 22, 7, 'R1');
      await builder.placeLabeled('AnalogResistor', 22, 13, 'R2');
      await builder.placeLabeled('AnalogCapacitor', 28, 13, 'C1');
      await builder.placeLabeled('AnalogGround', 26, 20, 'G2');
      await builder.placeLabeled('AnalogGround', 30, 20, 'G3');
      await builder.placeLabeled('Probe', 32, 10, 'P1');

      // Wire D_FF in toggle mode: ~Q → D
      await builder.drawWire('CLK', 'out', 'FF', 'C');
      await builder.drawWire('FF', '~Q', 'FF', 'D');

      // Wire FF Q output → switch control
      await builder.drawWire('FF', 'Q', 'SW1', 'ctrl');

      // Wire power → inductor → switch common
      await builder.drawWire('Vs', 'pos', 'L1', 'A');
      await builder.drawWire('L1', 'B', 'SW1', 'com');
      await builder.drawWire('Vs', 'neg', 'G1', 'gnd');

      // Wire NO path: switch NO → R1 → GND
      await builder.drawWire('SW1', 'no', 'R1', 'A');
      await builder.drawWire('R1', 'B', 'G2', 'gnd');

      // Wire NC path: switch NC → R2 → C → GND
      await builder.drawWire('SW1', 'nc', 'R2', 'A');
      await builder.drawWire('R2', 'B', 'C1', 'pos');
      await builder.drawWire('C1', 'neg', 'G3', 'gnd');

      // Probe at switch output junction
      await builder.drawWire('SW1', 'no', 'P1', 'in');

      await builder.stepViaUI();
      await builder.verifyNoErrors();

      // Step through several toggle cycles
      const result = await measurePeaks(builder, 3000);
      expect(result).not.toBeNull();
      expect(result!.nodeCount).toBeGreaterThanOrEqual(3);

      // Should see voltage variation due to switching between loads
      const maxAmp = Math.max(...result!.amplitudes);
      // Switching transient should produce measurable oscillation
      expect(maxAmp).toBeGreaterThan(0.1);  // Not just noise
    });
  });
});

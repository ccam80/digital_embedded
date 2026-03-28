/**
 * E2E tests — analog RC circuit via GUI interactions.
 *
 * Tests the full pipeline: circuit building via palette clicks → compilation
 * (domain auto-detected as analog from component models) → simulation stepping
 * → voltage reading.
 *
 * Circuit: AC Source (5V, 100Hz) → R (1kΩ) → C (1µF) → GND
 * Analytical: |H(100Hz)| = 1/√(1 + (2π·100·1e-3)²) ≈ 0.847
 *   → output amplitude ≈ 4.23V (source amplitude = 5V)
 *
 * No explicit mode switching — the compiler auto-detects analog from the
 * component models (AcVoltageSource, Resistor, Capacitor).
 */
import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * Build an RC lowpass circuit using UICircuitBuilder palette clicks and wire
 * drawing. Returns after all components are placed and wired but before any
 * simulation step.
 *
 * Topology:
 *   Vs(pos) → R1(A) → R1(B) → C1(pos) → C1(neg) → G2(gnd)
 *   Vs(neg) → G1(gnd)
 *   C1(pos) → P1(in)   [probe for output measurement]
 */
async function buildRcCircuit(builder: UICircuitBuilder): Promise<void> {
  await builder.placeLabeled('AcVoltageSource', 3, 8, 'Vs');
  await builder.placeLabeled('Resistor', 10, 8, 'R1');
  await builder.placeLabeled('Capacitor', 17, 8, 'C1');
  await builder.placeComponent('Ground', 6, 14);
  await builder.placeComponent('Ground', 19, 14);
  await builder.placeLabeled('Probe', 22, 8, 'P1');

  // Default AcVoltageSource amplitude is 5V; set frequency to 100 Hz
  await builder.setComponentProperty('Vs', 'frequency', 100);

  await builder.drawWire('Vs', 'pos', 'R1', 'A');
  await builder.drawWire('R1', 'B', 'C1', 'pos');
  await builder.drawWireFromPin('C1', 'neg', 19, 14);
  await builder.drawWireFromPin('Vs', 'neg', 6, 14);
  await builder.drawWire('C1', 'pos', 'P1', 'in');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('GUI: analog RC circuit', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
    // Default engine mode is "auto" — all components (digital + analog) are
    // available in the palette. The engine auto-detects analog from placed
    // components. No explicit mode switch needed.
  });

  test('analog palette contains analog component types', async () => {
    // All palette items are available without any mode switch. Verify that
    // the palette exposes the analog component types we will use.
    const hasResistor = await builder['page'].locator('[data-component="Resistor"]').count();
    const hasCapacitor = await builder['page'].locator('[data-component="Capacitor"]').count();
    const hasAcSource = await builder['page'].locator('[data-component="AcVoltageSource"]').count();

    const totalAnalog = hasResistor + hasCapacitor + hasAcSource;
    expect(totalAnalog).toBeGreaterThan(0);
  });

  test('circuit domain is auto-derived as analog after placing analog components', async () => {
    // Place a single analog component — domain derivation reads component models
    await builder.placeLabeled('Resistor', 5, 5, 'R1');

    const domain = await builder.getCircuitDomain();
    expect(domain).toBe('analog');
  });

  test('empty circuit has digital domain (no analog components)', async () => {
    // Before placing any components the circuit is empty — defaults to digital
    const domain = await builder.getCircuitDomain();
    expect(domain).toBe('digital');
  });

  test('build RC circuit via UI and verify all elements are present', async () => {
    await buildRcCircuit(builder);

    // After placing analog components the domain should be auto-detected
    const domain = await builder.getCircuitDomain();
    expect(domain).toBe('analog');

    // Verify element count: AC source + resistor + capacitor + 2 grounds + probe = 6
    const info = await builder.getCircuitInfo();
    expect(info.elementCount).toBe(6);

    const labels = info.elements.map(e => e.label).filter(Boolean);
    expect(labels).toContain('Vs');
    expect(labels).toContain('R1');
    expect(labels).toContain('C1');
  });

  test('compile and step analog RC circuit — simTime advances', async () => {
    await buildRcCircuit(builder);

    // First step triggers compilation; compiler auto-detects analog from models
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Analog state should now be available
    const state0 = await builder.getAnalogState();
    expect(state0).not.toBeNull();
    expect(state0!.simTime).toBeGreaterThan(0);
    expect(state0!.nodeCount).toBeGreaterThanOrEqual(1);

    // Step further and verify time advances
    const timeBefore = state0!.simTime;
    await builder.stepViaUI(10);
    const state1 = await builder.getAnalogState();
    expect(state1).not.toBeNull();
    expect(state1!.simTime).toBeGreaterThan(timeBefore);
  });

  test('node voltages change during transient simulation', async () => {
    await buildRcCircuit(builder);

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Record voltages after 1 step
    const state0 = await builder.getAnalogState();
    expect(state0).not.toBeNull();

    // Step 50 more times — voltages must change (AC source is driving the circuit)
    await builder.stepViaUI(50);
    const state1 = await builder.getAnalogState();
    expect(state1).not.toBeNull();

    // At least one node voltage should differ between the two snapshots
    const keys = Object.keys(state0!.nodeVoltages);
    expect(keys.length).toBeGreaterThan(0);
    const anyChanged = keys.some(
      k => Math.abs((state1!.nodeVoltages[k] ?? 0) - (state0!.nodeVoltages[k] ?? 0)) > 1e-9,
    );
    expect(anyChanged, 'No node voltages changed after 50 steps').toBe(true);
  });

  test('RC lowpass steady-state amplitude matches analytical', async () => {
    await buildRcCircuit(builder);

    // First step triggers compilation
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Add scope trace via a real analog component (Capacitor) so measureAnalogPeaks has data
    await builder.addTraceViaContextMenu('C1', 'pos');

    // Step past transient (5τ = 5ms) then sample one full period (10ms at 100Hz)
    await stepToTimeAndRead(builder, '10m');

    // Sample peak/trough via scope trace stats (fast path)
    const result = await builder.measureAnalogPeaks('10m');
    expect(result).not.toBeNull();
    expect(result!.nodeCount).toBeGreaterThanOrEqual(1);

    const amps = [...result!.amplitudes].sort((a, b) => b - a);

    // Analytical: |H(100Hz)| = 1/√(1 + (2π·100·1kΩ·1µF)²) ≈ 0.847
    // Source amplitude = 5V → output amplitude ≈ 4.234V
    const R = 1000, C_val = 1e-6, freq = 100, srcAmp = 5;
    const omegaRC = 2 * Math.PI * freq * R * C_val;
    const hMag = 1 / Math.sqrt(1 + omegaRC * omegaRC);
    const expectedOutputAmp = srcAmp * hMag; // ≈ 4.234V

    // Source node amplitude ≈ 5V (within 10%)
    expect(amps[0]).toBeGreaterThan(srcAmp * 0.9);
    // Output node amplitude matches analytical within ±0.1% (ngspice-validated)
    expect(amps[1]).toBeGreaterThan(expectedOutputAmp * 0.999);
    expect(amps[1]).toBeLessThan(expectedOutputAmp * 1.001);
  });
});

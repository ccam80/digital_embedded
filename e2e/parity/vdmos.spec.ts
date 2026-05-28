/**
 * VDMOS E2E parity (Surface 3 of the three-surface rule).
 *
 * Loads the VDMOS power-switch fixture over the postMessage bridge
 * (sim-load-data), steps the transient via sim-step, and reads the drain node
 * via sim-read-all-signals. With the gate driven above threshold (V_G=10V >
 * default Vth=3V) the NMOS VDMOS switch turns ON and pulls the drain node well
 * below the 15V rail. This catches the blind spot where the headless facade and
 * MCP surface work but the browser wiring (app-init, postMessage handler,
 * VDMOS registration in the bundled registry) is broken.
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PS_DTS = readFileSync(
  resolve(__dirname, '../../src/solver/analog/__tests__/ngspice-parity/fixtures/vdmos-power-switch.dts'),
  'utf-8',
);
const PS_B64 = Buffer.from(PS_DTS, 'utf-8').toString('base64');

test.describe('VDMOS power switch- postMessage (E2E) surface', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
  });

  test('NMOS VDMOS switches the drain low when the gate is driven on', async () => {
    await harness.postToSim({ type: 'sim-load-data', data: PS_B64 });
    await harness.waitForMessage('sim-loaded');

    // Step the transient a few hundred steps, then read all node voltages.
    await harness.step(300);
    await harness.postToSim({ type: 'sim-read-all-signals' });
    const result = await harness.waitForMessage<{
      signals: Record<string, number>;
      simTime: number | null;
    }>('sim-signals');

    // The drain node is the R_L:neg / M1:D net. With the device ON the drain is
    // pulled well below the 15V supply.
    const vd = result.signals['M1:D'] ?? result.signals['R_L:neg'] ?? NaN;
    expect(Number.isFinite(vd)).toBe(true);
    expect(vd).toBeLessThan(15);
    expect(vd).toBeGreaterThanOrEqual(0);
  });
});

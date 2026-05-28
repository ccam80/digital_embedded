/**
 * Surface 3 (E2E / postMessage) — sim-configure forwards indVerbosity.
 *
 * Drives the engine knob through the postMessage wire protocol via the
 * SimulatorHarness iframe and asserts the sim-configured echo.
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const circuitsDir = resolve(__dirname, '../../circuits');

test.describe('Parity: sim-configure indVerbosity via postMessage', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
  });

  test('sim-configure { indVerbosity } echoes sim-configured', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'and-gate.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    await harness.postToSim({ type: 'sim-configure', params: { indVerbosity: 1 } });
    const msg = await harness.waitForMessage<{ type: string; params: { indVerbosity?: number } }>(
      'sim-configured',
    );
    expect(msg.params.indVerbosity).toBe(1);
  });
});

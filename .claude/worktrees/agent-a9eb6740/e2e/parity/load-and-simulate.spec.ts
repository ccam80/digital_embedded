/**
 * Parity tests — mirror headless integration tests but run in a real browser
 * via the postMessage API.
 *
 * These catch the blind spot where the headless facade works fine but the
 * browser wiring (app-init, postMessage handler, DOM setup) is broken.
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const circuitsDir = resolve(__dirname, '../../circuits');

test.describe('Parity: load and simulate via postMessage', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
  });

  test('AND gate — load .dig and run test vectors', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'and-gate.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    const result = await harness.runTests('A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1');
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  test('Half adder — load .dig and run test vectors', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'half-adder.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    const result = await harness.runTests(
      'A B S Cout\n0 0 0 0\n0 1 1 0\n1 0 1 0\n1 1 0 1',
    );
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  test('AND gate — load via URL and run test vectors', async () => {
    await harness.loadDigUrl('/circuits/and-gate.dig');

    const result = await harness.runTests('A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1');
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  test('AND gate — failing test vector detected', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'and-gate.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    // Deliberately wrong: expects 1 1 → 0, but AND gives 1
    const result = await harness.runTests('A B Y\n0 0 0\n1 1 0');
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(1);
  });

  test('get-circuit round-trip — export then reimport', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'and-gate.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    // Export
    const b64 = await harness.getCircuit();
    expect(b64.length).toBeGreaterThan(0);

    // Reimport the exported circuit
    await harness.postToSim({ type: 'digital-load-data', data: b64 });
    await harness.waitForMessage('digital-loaded');

    // Run tests on reimported circuit — should still work
    const result = await harness.runTests('A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1');
    expect(result.passed).toBe(4);
  });
});

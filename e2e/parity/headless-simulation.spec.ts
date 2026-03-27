/**
 * Parity tests — headless simulation operations via postMessage.
 *
 * These test the newly wired-up operations that the PostMessageAdapter
 * supports: sim-set-input, sim-step, sim-read-output,
 * sim-read-all-signals. Previously these were only in the adapter
 * class but never wired into the app.
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const circuitsDir = resolve(__dirname, '../../circuits');

test.describe('Parity: headless simulation via postMessage', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
  });

  test('set-input + step + read-output — AND gate truth table', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'and-gate.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    const cases: [number, number, number][] = [
      [0, 0, 0],
      [0, 1, 0],
      [1, 0, 0],
      [1, 1, 1],
    ];

    for (const [a, b, expected] of cases) {
      // Reload to reset state
      await harness.loadDigXml(xml);

      await harness.postToSim({ type: 'sim-set-input', label: 'A', value: a });
      await harness.postToSim({ type: 'sim-set-input', label: 'B', value: b });
      await harness.postToSim({ type: 'sim-step' });
      await harness.postToSim({ type: 'sim-read-output', label: 'Y' });

      const msg = await harness.waitForMessage<{ type: string; label: string; value: number }>(
        'sim-output',
      );
      expect(msg.value, `A=${a} B=${b} → Y`).toBe(expected);
    }
  });

  test('read-all-signals returns labeled signals', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'and-gate.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    await harness.postToSim({ type: 'sim-set-input', label: 'A', value: 1 });
    await harness.postToSim({ type: 'sim-set-input', label: 'B', value: 1 });
    await harness.postToSim({ type: 'sim-step' });
    await harness.postToSim({ type: 'sim-read-all-signals' });

    const msg = await harness.waitForMessage<{ type: string; signals: Record<string, number> }>(
      'sim-signals',
    );
    expect(msg.signals).toHaveProperty('A');
    expect(msg.signals).toHaveProperty('B');
    expect(msg.signals).toHaveProperty('Y');
    expect(msg.signals['Y']).toBe(1);
  });

  test('half adder — step-by-step signal verification', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'half-adder.dig'), 'utf-8');

    const cases: [number, number, number, number][] = [
      [0, 0, 0, 0],
      [0, 1, 1, 0],
      [1, 0, 1, 0],
      [1, 1, 0, 1],
    ];

    for (const [a, b, expectedS, expectedCout] of cases) {
      await harness.loadDigXml(xml);

      await harness.postToSim({ type: 'sim-set-input', label: 'A', value: a });
      await harness.postToSim({ type: 'sim-set-input', label: 'B', value: b });
      await harness.postToSim({ type: 'sim-step' });

      await harness.postToSim({ type: 'sim-read-output', label: 'S' });
      const sMsg = await harness.waitForMessage<{ value: number }>('sim-output');

      await harness.postToSim({ type: 'sim-read-output', label: 'Cout' });
      const coutMsg = await harness.waitForMessage<{ value: number }>('sim-output');

      expect(sMsg.value, `A=${a} B=${b} → S`).toBe(expectedS);
      expect(coutMsg.value, `A=${a} B=${b} → Cout`).toBe(expectedCout);
    }
  });

  test('set-input without loaded circuit returns error', async () => {
    await harness.postToSim({ type: 'sim-set-input', label: 'A', value: 1 });
    const msg = await harness.waitForMessage<{ type: string; error: string }>('sim-error');
    expect(msg.error).toContain('No circuit loaded');
  });

  test('sim-run-tests also works (canonical message type)', async () => {
    const xml = readFileSync(resolve(circuitsDir, 'and-gate.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    await harness.postToSim({
      type: 'sim-run-tests',
      testData: 'A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1',
    });

    const msg = await harness.waitForMessage<{
      type: string;
      passed: number;
      failed: number;
    }>('sim-test-result');
    expect(msg.passed).toBe(4);
    expect(msg.failed).toBe(0);
  });
});

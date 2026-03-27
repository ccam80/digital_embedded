/**
 * Parity tests — error handling via postMessage.
 *
 * Verifies that the browser-side message handler correctly reports errors
 * instead of silently failing or crashing.
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';

test.describe('Parity: error handling via postMessage', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
  });

  test('loading invalid base64 data returns error', async () => {
    const badB64 = Buffer.from('not valid xml at all', 'utf-8').toString('base64');
    await harness.postToSim({ type: 'sim-load-data', data: badB64 });
    const msg = await harness.waitForMessage<{ type: string; error: string }>(
      'sim-error',
    );
    expect(msg.error).toBeTruthy();
  });

  test('loading empty data returns error', async () => {
    await harness.postToSim({ type: 'sim-load-data', data: '' });
    const msg = await harness.waitForMessage<{ type: string; error: string }>(
      'sim-error',
    );
    expect(msg.error).toContain('No data provided');
  });

  test('running test with no testData returns error', async ({ page }) => {
    // Load a valid circuit first
    await harness.loadDigUrl('/circuits/and-gate.dig');

    // Send digital-test with empty testData
    await harness.postToSim({ type: 'sim-test', testData: '' });
    const msg = await harness.waitForMessage<{ type: string; error: string }>(
      'sim-error',
    );
    expect(msg.error).toContain('No testData provided');
  });

  test('test with mismatched signal names returns error', async () => {
    await harness.loadDigUrl('/circuits/and-gate.dig');

    // Signal names don't match the circuit's In/Out labels
    await harness.postToSim({
      type: 'sim-test',
      testData: 'X Z W\n0 0 0',
    });
    const msg = await harness.waitForMessage<{ type: string; error: string }>(
      'sim-error',
    );
    expect(msg.error).toContain('not found in circuit');
  });
});

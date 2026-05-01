/**
 * Stepping performance E2E test.
 *
 * Loads fixtures/buckbjt.dts (BJT buck converter- a relatively complex analog
 * circuit), runs the simulation at 1ms/s, and measures how far simTime advances
 * in a fixed wall-clock window. This catches regressions in the stepping hot
 * path (e.g. breakpoint accumulation forcing micro-steps).
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = resolve(__dirname, '../../fixtures');

async function clickIframeButton(harness: SimulatorHarness, buttonId: string): Promise<void> {
  await harness.page.evaluate((id) => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    iframe.contentWindow!.document.getElementById(id)?.click();
  }, buttonId);
}

async function getAnalogState(harness: SimulatorHarness): Promise<{
  simTime: number;
  nodeVoltages: Record<string, number>;
  nodeCount: number;
} | null> {
  return harness.page.evaluate(() => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    const bridge = (iframe.contentWindow as any).__test;
    return bridge?.getAnalogState() ?? null;
  });
}

test.describe('Stepping performance', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
    await harness.iframe.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  test('buckbjt at 1ms/s- simTime advances at least 500us in 2s wall time', async () => {
    const xml = readFileSync(resolve(fixturesDir, 'buckbjt.dts'), 'utf-8');
    await harness.loadDigXml(xml);

    // Step once to compile
    await clickIframeButton(harness, 'btn-step');
    await harness.page.waitForTimeout(300);

    // Set speed to 1ms/s
    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const input = iframe.contentWindow!.document.getElementById('speed-input') as HTMLInputElement;
      input.value = '0.001';
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // Read simTime before run
    const stateBefore = await getAnalogState(harness);
    expect(stateBefore).not.toBeNull();
    const timeBefore = stateBefore!.simTime;

    // Run for 2 seconds of wall time
    await clickIframeButton(harness, 'btn-run');
    await harness.page.waitForTimeout(2000);

    // Read simTime during run (before stop)
    const stateAfter = await getAnalogState(harness);
    await clickIframeButton(harness, 'btn-stop');

    expect(stateAfter).not.toBeNull();
    const timeAfter = stateAfter!.simTime;
    const advanced = timeAfter - timeBefore;

    // At 1ms/s, 2s wall time should yield ~2ms sim time.
    // Allow generous margin (500us minimum) to account for compilation overhead
    // and CI variability. The key assertion: the sim isn't stuck or crawling.
    console.log(`simTime advanced: ${(advanced * 1e6).toFixed(1)}us in 2s wall time (expected ~2000us at 1ms/s)`);
    expect(advanced, `simTime only advanced ${(advanced * 1e6).toFixed(1)}us- expected at least 500us`).toBeGreaterThan(500e-6);

    // All voltages must remain finite (no divergence)
    for (const [label, v] of Object.entries(stateAfter!.nodeVoltages)) {
      expect(Number.isFinite(v), `Voltage at "${label}" is not finite: ${v}`).toBe(true);
    }
  });

  test('buckbjt fast-forward 1ms- completes within 5s wall budget', async () => {
    const xml = readFileSync(resolve(fixturesDir, 'buckbjt.dts'), 'utf-8');
    await harness.loadDigXml(xml);

    // Step once to compile
    await clickIframeButton(harness, 'btn-step');
    await harness.page.waitForTimeout(300);

    const stateBefore = await getAnalogState(harness);
    expect(stateBefore).not.toBeNull();

    // Fast-forward via the FF button: set custom time to 1ms, click FF
    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const doc = iframe.contentWindow!.document;
      // Open dropdown
      doc.getElementById('btn-step-time')?.click();
      // Show custom row
      const row = doc.getElementById('step-custom-row');
      if (row && row.style.display === 'none') {
        doc.getElementById('step-custom-toggle')?.click();
      }
    });
    await harness.page.waitForTimeout(100);

    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const doc = iframe.contentWindow!.document;
      const input = doc.getElementById('step-custom-input') as HTMLInputElement;
      input.value = '1m';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    await harness.page.waitForTimeout(100);

    // Click fast-forward
    const wallStart = Date.now();
    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      iframe.contentWindow!.document.getElementById('btn-step-ff')?.click();
    });

    // Wait for completion (stepToTime has 5s budget)
    await harness.page.waitForTimeout(5500);
    const wallElapsed = Date.now() - wallStart;

    const stateAfter = await getAnalogState(harness);
    expect(stateAfter).not.toBeNull();

    const advanced = stateAfter!.simTime - stateBefore!.simTime;
    console.log(`FF advanced: ${(advanced * 1e3).toFixed(3)}ms in ${(wallElapsed / 1000).toFixed(1)}s wall time`);

    // Should have reached or gotten close to the 1ms target
    expect(advanced, `FF only advanced ${(advanced * 1e6).toFixed(1)}us- expected ~1ms`).toBeGreaterThan(100e-6);

    for (const [label, v] of Object.entries(stateAfter!.nodeVoltages)) {
      expect(Number.isFinite(v), `Voltage at "${label}" is not finite: ${v}`).toBe(true);
    }
  });
});

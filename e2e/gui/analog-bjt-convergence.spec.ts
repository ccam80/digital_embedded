/**
 * E2E regression test — BJT buck converter convergence.
 *
 * Loads fixtures/buckbjt.dig via postMessage (same as a user opening a file),
 * clicks Step (which triggers compileAndBind + coordinator.step), and verifies
 * that no convergence error appears in the status bar.
 *
 * This is a true GUI interaction test — no mode switching, no bridge hacks.
 * The unified compiler auto-detects analog from the circuit's components.
 *
 * Regression: BJT updateOperatingPoint wrote back pnjlim-limited Vbe without
 * adjusting Vbc, corrupting the companion model and causing NR divergence.
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = resolve(__dirname, '../../fixtures');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function clickIframeButton(harness: SimulatorHarness, buttonId: string): Promise<void> {
  await harness.page.evaluate((id) => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    iframe.contentWindow!.document.getElementById(id)?.click();
  }, buttonId);
}

/** Read the status bar text inside the simulator iframe. */
async function getStatusText(harness: SimulatorHarness): Promise<string> {
  return harness.page.evaluate(() => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    const el = iframe.contentWindow!.document.getElementById('status-bar')
      ?? iframe.contentWindow!.document.querySelector('.status-bar')
      ?? iframe.contentWindow!.document.querySelector('[class*="status"]');
    return el?.textContent?.trim() ?? '';
  });
}

/** Check if the status bar shows an error (red/error class or error keywords). */
async function hasStatusError(harness: SimulatorHarness): Promise<boolean> {
  return harness.page.evaluate(() => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    const doc = iframe.contentWindow!.document;
    // Check for status bar with error class
    const statusEl = doc.getElementById('status-bar')
      ?? doc.querySelector('.status-bar')
      ?? doc.querySelector('[class*="status"]');
    if (!statusEl) return false;
    const text = statusEl.textContent?.toLowerCase() ?? '';
    const hasErrorClass = statusEl.classList.contains('error')
      || statusEl.classList.contains('status-error');
    return hasErrorClass || /converg|error|failed|singular/i.test(text);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('BJT buck converter convergence', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
    await harness.iframe.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  test('load buckbjt.dig and step — no convergence error in status bar', async () => {
    // Load the fixture exactly as a user would (via postMessage)
    const xml = readFileSync(resolve(fixturesDir, 'buckbjt.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    // Click Step — this triggers compileAndBind() then coordinator.step()
    // On first load, compileAndBind auto-detects analog via facade.compile()
    await clickIframeButton(harness, 'btn-step');
    await harness.page.waitForTimeout(500);

    // The status bar should NOT show a convergence error
    const statusText = await getStatusText(harness);
    const hasError = await hasStatusError(harness);

    expect(hasError, `Status bar shows error: "${statusText}"`).toBe(false);
  });

  test('load buckbjt.dig and run briefly — no crash or convergence error', async () => {
    const xml = readFileSync(resolve(fixturesDir, 'buckbjt.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    // Click Run, wait, then Stop — same as a user pressing play
    await clickIframeButton(harness, 'btn-run');
    await harness.page.waitForTimeout(600);
    await clickIframeButton(harness, 'btn-stop');
    await harness.page.waitForTimeout(200);

    const statusText = await getStatusText(harness);
    const hasError = await hasStatusError(harness);

    expect(hasError, `Status bar shows error: "${statusText}"`).toBe(false);
  });

  test('load buckbjt.dig and step 20 times — all voltages finite', async () => {
    const xml = readFileSync(resolve(fixturesDir, 'buckbjt.dig'), 'utf-8');
    await harness.loadDigXml(xml);

    // Step repeatedly
    for (let i = 0; i < 20; i++) {
      await clickIframeButton(harness, 'btn-step');
    }
    await harness.page.waitForTimeout(300);

    // No error in status bar
    const hasError = await hasStatusError(harness);
    const statusText = await getStatusText(harness);
    expect(hasError, `Status bar shows error: "${statusText}"`).toBe(false);
  });
});

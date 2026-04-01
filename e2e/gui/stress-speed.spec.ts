import { test } from '@playwright/test';
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

async function getSimTime(harness: SimulatorHarness): Promise<number> {
  return harness.page.evaluate(() => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    return (iframe.contentWindow as any).__test?.getAnalogState()?.simTime ?? 0;
  });
}

async function setSpeed(harness: SimulatorHarness, speed: number): Promise<void> {
  await harness.page.evaluate((s) => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    const input = iframe.contentWindow!.document.getElementById('speed-input') as HTMLInputElement;
    input.value = String(s);
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, speed);
}

for (const targetSpeed of [0.001, 0.01, 0.1, 0.5, 1.0]) {
  const label = targetSpeed >= 1 ? targetSpeed + ' s/s'
    : targetSpeed >= 1e-3 ? (targetSpeed * 1000) + ' ms/s'
    : (targetSpeed * 1e6) + ' us/s';

  test('buckbjt at ' + label + ' — 3s wall time', async ({ page }) => {
    const harness = new SimulatorHarness(page);
    await harness.load();
    await harness.iframe.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);

    const xml = readFileSync(resolve(fixturesDir, 'buckbjt.dts'), 'utf-8');
    await harness.loadDigXml(xml);
    await clickIframeButton(harness, 'btn-step');
    await page.waitForTimeout(300);

    await setSpeed(harness, targetSpeed);
    const t0 = await getSimTime(harness);
    await clickIframeButton(harness, 'btn-run');
    await page.waitForTimeout(3000);
    const t1 = await getSimTime(harness);
    await clickIframeButton(harness, 'btn-stop');

    const advanced = t1 - t0;
    const expected = targetSpeed * 3;
    const ratio = advanced / expected;
    console.log('Speed ' + label + ': advanced ' + (advanced * 1e3).toFixed(3) + 'ms / expected ' + (expected * 1e3).toFixed(1) + 'ms = ' + (ratio * 100).toFixed(0) + '%');
  });
}

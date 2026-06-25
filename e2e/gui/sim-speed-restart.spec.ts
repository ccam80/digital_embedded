/**
 * E2E: the playback speed survives a simulator restart.
 *
 * Reproduces the report end-to-end: set a non-default speed while running, do a
 * destructive Stop (which invalidates the compiled engine), then Run again. The
 * restart recompiles- building a fresh coordinator whose speed reverts to the
 * engine default- so without re-applying the persisted rate the speed display
 * snapped back to "1 ms/s". It must instead keep the user's chosen rate.
 */
import { test, expect, type Page } from '@playwright/test';

// Minimal analog loop (AC source -> R -> C -> ground) so a real analog
// coordinator compiles and the speed display is meaningful.
const RC_XML = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes><entry><string>romContent</string><romList><roms/></romList></entry></attributes>
  <visualElements>
    <visualElement>
      <elementName>AcVoltageSource</elementName>
      <elementAttributes>
        <entry><string>Label</string><string>Vs</string></entry>
        <entry><string>Amplitude</string><int>5</int></entry>
        <entry><string>Frequency</string><int>100</int></entry>
      </elementAttributes>
      <pos x="140" y="260"/>
    </visualElement>
    <visualElement>
      <elementName>Resistor</elementName>
      <elementAttributes>
        <entry><string>Label</string><string>R1</string></entry>
        <entry><string>resistance</string><int>1000</int></entry>
      </elementAttributes>
      <pos x="300" y="200"/>
    </visualElement>
    <visualElement>
      <elementName>Capacitor</elementName>
      <elementAttributes>
        <entry><string>Label</string><string>C1</string></entry>
        <entry><string>capacitance</string><double>1.0E-6</double></entry>
      </elementAttributes>
      <pos x="460" y="200"/>
    </visualElement>
    <visualElement><elementName>Ground</elementName><elementAttributes/><pos x="220" y="300"/></visualElement>
    <visualElement><elementName>Ground</elementName><elementAttributes/><pos x="540" y="300"/></visualElement>
  </visualElements>
  <wires>
    <wire><p1 x="140" y="260"/><p2 x="140" y="200"/></wire>
    <wire><p1 x="140" y="200"/><p2 x="300" y="200"/></wire>
    <wire><p1 x="380" y="200"/><p2 x="460" y="200"/></wire>
    <wire><p1 x="540" y="200"/><p2 x="540" y="300"/></wire>
    <wire><p1 x="220" y="260"/><p2 x="220" y="300"/></wire>
  </wires>
</circuit>`;

async function loadXml(page: Page, xml: string): Promise<void> {
  const loaded = page.evaluate(() => new Promise<void>((resolve) => {
    const h = (e: MessageEvent) => {
      if ((e.data as { type?: string })?.type === 'sim-loaded') {
        window.removeEventListener('message', h); resolve();
      }
    };
    window.addEventListener('message', h);
  }));
  const b64 = Buffer.from(xml).toString('base64');
  await page.evaluate((data) => window.postMessage({ type: 'sim-load-data', data }, '*'), b64);
  await Promise.race([loaded, page.waitForTimeout(800)]);
}

/** Read the effective playback rate (sim-s per wall-s) on the live coordinator. */
async function effectiveSpeed(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as {
    __test: { getPlaybackSpeed(): number };
  }).__test.getPlaybackSpeed());
}

test.describe('playback speed survives restart', () => {
  test('Stop then Run keeps the chosen speed (not the engine default)', async ({ page }) => {
    await page.goto('/');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForFunction(() => (window as unknown as { __test?: unknown }).__test !== undefined, { timeout: 10_000 });

    await loadXml(page, RC_XML);

    const speedInput = page.locator('#speed-input');
    const speedUnit = page.locator('.speed-unit');

    // Run: compiles and starts. Speed reflects the default (1 ms/s = 1e-3).
    await page.locator('#btn-tb-run').click();
    await expect(speedInput).toHaveValue('1');
    await expect(speedUnit).toHaveText('ms/s');
    expect(await effectiveSpeed(page)).toBeCloseTo(1e-3, 12);

    // Choose a distinct, non-default rate: 5 sim-seconds per wall-second.
    await speedInput.fill('5');
    await speedInput.press('Tab'); // commit via the change event
    await expect(speedInput).toHaveValue('5');
    await expect(speedUnit).toHaveText('s/s');
    expect(await effectiveSpeed(page)).toBe(5);

    // Destructive Stop: invalidates the compiled engine and marks dirty.
    await page.locator('#btn-tb-stop').click();

    // Restart: recompiles into a fresh coordinator. Both the DOM display AND the
    // coordinator's effective rate must keep 5 s/s- before the fix the fresh
    // coordinator reverted to the 1e-3 default (the display could stay stale, so
    // asserting the effective rate is what actually catches the regression).
    await page.locator('#btn-tb-run').click();
    await expect(speedInput).toHaveValue('5');
    await expect(speedUnit).toHaveText('s/s');
    expect(await effectiveSpeed(page)).toBe(5);
  });
});

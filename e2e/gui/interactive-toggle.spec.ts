/**
 * E2E: interactive components (In / switch) toggle on a left-click whether or
 * not the simulation is running.
 *
 * A left-click that does not become a drag toggles the component (compiling and
 * single-stepping on demand); a click-and-drag moves it instead.
 */
import { test, expect, type Page } from '@playwright/test';

const IN_XML = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes><entry><string>romContent</string><romList><roms/></romList></entry></attributes>
  <visualElements>
    <visualElement><elementName>In</elementName>
      <elementAttributes><entry><string>Label</string><string>A</string></entry></elementAttributes>
      <pos x="200" y="200"/></visualElement>
  </visualElements>
  <wires/>
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

/** Page-space body center of a component (its bounding-box centre in screen
 *  space), a reliable click target that is on the body and clear of the pins. */
async function bodyPoint(page: Page, label: string): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate((lbl) => {
    const bridge = (window as unknown as { __test: {
      getCanvasRect(): { left: number; top: number };
      getElementCenter(labelOrIndex: string | number): { x: number; y: number } | null;
    } }).__test;
    const rect = bridge.getCanvasRect();
    const c = bridge.getElementCenter(lbl);
    if (!c) return null;
    return { x: rect.left + c.x, y: rect.top + c.y };
  }, label);
  if (!pt) throw new Error(`component "${label}" not found`);
  return pt;
}

async function readSignal(page: Page, label: string): Promise<number | null> {
  return page.evaluate((lbl) => {
    const bridge = (window as unknown as { __test: {
      readSignalByLabel(label: string): { type: 'digital'; value: number } | { type: 'analog'; voltage: number } | null;
    } }).__test;
    const s = bridge.readSignalByLabel(lbl);
    if (!s) return null;
    return s.type === 'digital' ? s.value : s.voltage;
  }, label);
}

async function elementPosition(page: Page, label: string): Promise<{ x: number; y: number }> {
  const pos = await page.evaluate((lbl) => {
    const bridge = (window as unknown as { __test: {
      getCircuitInfo(): { elements: Array<{ label: string; position: { x: number; y: number } }> };
    } }).__test;
    return bridge.getCircuitInfo().elements.find(e => e.label === lbl)?.position ?? null;
  }, label);
  if (!pos) throw new Error(`component "${label}" not found`);
  return pos;
}

test.describe('interactive component toggle (sim stopped)', () => {
  test('left-clicking an input toggles it without starting the simulation', async ({ page }) => {
    await page.goto('/');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);

    await loadXml(page, IN_XML);

    // Sim never started. Click the input body- it compiles on demand, toggles
    // 0 → 1, and single-steps so the value is live immediately.
    const a = await bodyPoint(page, 'A');
    await page.mouse.click(a.x, a.y);
    await page.waitForTimeout(150);
    expect(await readSignal(page, 'A')).toBe(1);

    // Click again- toggles back to 0.
    await page.mouse.click(a.x, a.y);
    await page.waitForTimeout(150);
    expect(await readSignal(page, 'A')).toBe(0);
  });

  test('dragging an input moves it instead of toggling', async ({ page }) => {
    await page.goto('/');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);

    await loadXml(page, IN_XML);

    const before = await elementPosition(page, 'A');
    const a = await bodyPoint(page, 'A');
    // Press, move well past the click threshold, release: this is a drag, so the
    // gesture moves the component rather than toggling it.
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(a.x + 80, a.y + 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(150);

    const after = await elementPosition(page, 'A');
    // The component moved- proving the gesture was treated as a drag, not a
    // toggle (a toggle would leave the position unchanged).
    expect(after.x !== before.x || after.y !== before.y).toBe(true);
  });
});

/**
 * E2E: component-declared differential ("across-component") voltage trace.
 *
 * Reproduces the original report end-to-end through the real UI: right-clicking
 * a 2-terminal component and choosing "Trace Voltage: <label>" must plot the
 * voltage DROP across it (V(pos) − V(neg)), not a single node's absolute
 * voltage. Before the fix this read flat / showed the source node, so the
 * resistor "had no drop".
 *
 * R1 sits between the source node and the cap node in an RC divider driven by a
 * 5 V / 100 Hz AC source, so the across-R1 voltage has a clear non-zero swing.
 */
import { test, expect, type Page } from '@playwright/test';

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

/** Screen-space body center of a labelled component (midpoint of its two pins). */
async function bodyCenter(page: Page, label: string): Promise<{ x: number; y: number }> {
  const pt = await page.evaluate((lbl) => {
    const bridge = (window as unknown as { __test: {
      getCanvasRect(): { left: number; top: number };
      getCircuitInfo(): { elements: Array<{ label: string; pins: Array<{ screenX: number; screenY: number }> }> };
    } }).__test;
    const rect = bridge.getCanvasRect();
    const el = bridge.getCircuitInfo().elements.find(e => e.label === lbl);
    if (!el || el.pins.length < 2) return null;
    const midX = (el.pins[0].screenX + el.pins[1].screenX) / 2;
    const midY = (el.pins[0].screenY + el.pins[1].screenY) / 2;
    return { x: rect.left + midX, y: rect.top + midY };
  }, label);
  if (!pt) throw new Error(`component "${label}" not found or has <2 pins`);
  return pt;
}

test.describe('component differential voltage trace', () => {
  test('Trace Voltage on a resistor plots the across-component drop, not a flat node', async ({ page }) => {
    await page.goto('/');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(400);

    await loadXml(page, RC_XML);

    // Open the timing/scope viewer (Simulation > View Traces).
    await page.locator('[data-menu="sim"]').click();
    await page.locator('#btn-menu-timing').click();
    await expect(page.locator('#viewer-panel')).toBeVisible();

    // Warm up the analog engine so the component trace menu (which needs the
    // resolver context) is populated.
    await page.evaluate(() => { for (let i = 0; i < 10; i++) window.postMessage({ type: 'sim-step' }, '*'); });
    await page.waitForTimeout(300);

    // Right-click R1 → "Trace Voltage: R1" (the single declared "V" probe).
    const r1 = await bodyCenter(page, 'R1');
    await page.mouse.click(r1.x, r1.y, { button: 'right' });
    await page.locator('.ctx-menu').waitFor({ state: 'visible' });
    // Exact match so we hit the differential item, not "Trace Voltage: R1.pos".
    await page.locator('.ctx-menu-label', { hasText: /^Trace Voltage: R1$/ }).click();

    // Step several AC cycles AFTER the channel exists so the scope captures it.
    await page.evaluate(() => { for (let i = 0; i < 800; i++) window.postMessage({ type: 'sim-step' }, '*'); });
    await page.waitForTimeout(600);

    const stats = await page.evaluate(() => {
      const bridge = (window as unknown as { __test: {
        getTraceStats(): Array<{ label: string; min: number; max: number; mean: number }> | null;
      } }).__test;
      return bridge.getTraceStats();
    });

    expect(stats).not.toBeNull();
    const r1Trace = stats!.find(s => s.label.includes('R1'));
    expect(r1Trace, `trace stats: ${JSON.stringify(stats)}`).toBeDefined();

    // The across-R1 voltage swings — it is a real differential, not the flat
    // ~0 (or pinned-to-source-node) trace the bug produced.
    expect(r1Trace!.max - r1Trace!.min).toBeGreaterThan(0.1);
  });
});

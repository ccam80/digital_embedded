/**
 * E2E tests: Hot-loading params and pin loading mode via UI interactions.
 *
 * Tests:
 *   1. Hot-loading model params -- change BF/IS on BJT via primary param inputs in
 *      the Model section of the property popup, verify collector voltage changes.
 *   2. Hot-loading pin electrical params -- change rOut on And gate output pin,
 *      verify override persists and simulation output changes.
 *   3. Pin loading mode switch via context menu on digital-to-analog wire --
 *      switch to Loaded, verify checkmark appears and simulation continues.
 *   4. Pin loading mode Ideal -- verify valid finite output after mode change.
 */

import { test, expect, type Page } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ---------------------------------------------------------------------------
// Shared helper: open property popup for a labeled element by double-click
// ---------------------------------------------------------------------------

async function openPopupForLabel(builder: UICircuitBuilder, label: string): Promise<void> {
  const info = await builder.getCircuitInfo();
  const el = info.elements.find(e => e.label === label);
  expect(el, `Element "${label}" not found`).toBeTruthy();
  const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
  await builder.page.mouse.dblclick(coords.x, coords.y);
  await expect(builder.page.locator('.prop-popup')).toBeVisible({ timeout: 3000 });
}

/**
 * Set a model parameter value in the property popup by finding the row whose
 * label span exactly matches paramKey and filling the adjacent input.
 * Works for both primary params (visible immediately) and secondary params
 * (inside the Advanced Parameters section -- expand first if needed).
 */
async function setModelParamInPopup(
  page: Page,
  paramKey: string,
  value: string | number,
): Promise<void> {
  const popup = page.locator('.prop-popup');
  const inputHandle = await popup.evaluateHandle((popupEl, key) => {
    const spans = popupEl.querySelectorAll("label, span");
    for (const span of spans) {
      if (span.textContent?.trim() === key) {
        const row = span.parentElement;
        if (row) {
          const input = row.querySelector("input");
          if (input) return input;
        }
      }
    }
    return null;
  }, paramKey);
  const input = inputHandle.asElement();
  expect(input, `Model param "${paramKey}" input not found`).not.toBeNull();
  await input!.fill(String(value));
  await input!.press('Tab');
}

/**
 * Expand the Pin Electrical collapsible section in the property popup.
 */
async function expandPinElectricalSection(page: Page): Promise<void> {
  const popup = page.locator('.prop-popup');
  const toggle = popup.getByText('▶ Pin Electrical');
  await expect(toggle).toBeVisible({ timeout: 3000 });
  await toggle.click();
  await expect(popup.getByText('▼ Pin Electrical')).toBeVisible({ timeout: 1000 });
}

/**
 * Find the input for a pin electrical field by its display label (e.g. Rout).
 */
async function getPinFieldInput(page: Page, fieldLabel: string) {
  const popup = page.locator('.prop-popup');
  const rows = popup.locator("div").filter({
    has: page.locator(`span:text-is("${fieldLabel}")`),
  });
  return rows.locator("input").first();
}

// ---------------------------------------------------------------------------
// Shared circuit builder: mixed digital-to-analog (And gate -> Resistor -> GND)
// ---------------------------------------------------------------------------

/**
 * Build a mixed digital-to-analog circuit using already-loaded builder.
 * And gate A1 (both inputs HIGH) -> RL (1kOhm) -> GND, Probe P1 on junction.
 * Returns page-absolute midpoint of the wire between A1.out and RL.A.
 */
async function buildMixedCircuitAndGetWireMid(
  builder: UICircuitBuilder,
): Promise<{ wireMidX: number; wireMidY: number }> {
  await builder.placeLabeled('And', 4, 8, 'A1');
  await builder.placeLabeled('Resistor', 16, 8, 'RL');
  await builder.placeComponent('Ground', 20, 14);
  await builder.placeLabeled('Probe', 22, 8, 'P1');
  // Use Const components (default value=1) so the digital inputs are always HIGH.
  // In components start at 0 and require user click interaction to change state.
  await builder.placeLabeled('Const', 1, 6, 'C1');
  await builder.placeLabeled('Const', 1, 10, 'C2');
  await builder.setComponentProperty('RL', 'resistance', 1000);

  await builder.drawWire('C1', 'out', 'A1', 'In_1');
  await builder.drawWire('C2', 'out', 'A1', 'In_2');
  await builder.drawWire('A1', 'out', 'RL', 'A');
  await builder.drawWire('RL', 'A', 'P1', 'in');
  await builder.drawWireFromPin('RL', 'B', 20, 14);

  const fromPos = await builder.getPinPagePosition('A1', 'out');
  const toPos = await builder.getPinPagePosition('RL', 'A');
  const wireMidX = Math.round((fromPos.x + toPos.x) / 2);
  const wireMidY = Math.round((fromPos.y + toPos.y) / 2);

  return { wireMidX, wireMidY };
}

// ---------------------------------------------------------------------------
// Test suite 1: Hot-loading SPICE model params via property popup
// ---------------------------------------------------------------------------

test.describe('Hot-loading model params via property popup', () => {
  test('changing BF on BJT via primary param row changes output voltage', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    // BJT common-emitter: Vcc(12V)->Rc(10k)->Q1:C, Ib(50µA)->Q1:B,
    // Q1:E->GND, Probe Pc on collector.
    //
    // Physics: saturation threshold Ic_sat = Vcc/Rc = 12/10k = 1.2mA
    // With BF=100 (default): Ic = 100*50µA = 5mA >> 1.2mA → saturated, Vc ≈ 0V
    // With BF=10 (hot-loaded): Ic = 10*50µA = 0.5mA < 1.2mA → active,
    //   Vc = 12V - 0.5mA*10kΩ = 7V
    // Difference: ~7V >> 0.5V threshold → test will pass.
    await builder.placeLabeled('DcVoltageSource', 7, 5, 'Vcc');
    await builder.placeLabeled('CurrentSource', 7, 12, 'Ib');
    await builder.placeLabeled('Resistor', 14, 5, 'Rc');
    await builder.placeLabeled('NpnBJT', 16, 9, 'Q1');
    await builder.placeComponent('Ground', 11, 16);
    await builder.placeComponent('Ground', 18, 16);
    await builder.placeComponent('Ground', 11, 9);
    await builder.placeLabeled('Probe', 22, 7, 'Pc');

    await builder.setComponentProperty('Vcc', 'voltage', 12);
    await builder.setComponentProperty('Ib', 'current', 0.00005);
    await builder.setComponentProperty('Rc', 'resistance', 10000);

    await builder.drawWire('Vcc', 'pos', 'Rc', 'A');
    await builder.drawWire('Rc', 'B', 'Q1', 'C');
    await builder.drawWire('Ib', 'pos', 'Q1', 'B');
    await builder.drawWireFromPin('Q1', 'E', 18, 16);
    await builder.drawWireFromPin('Vcc', 'neg', 11, 16);
    await builder.drawWireFromPin('Ib', 'neg', 11, 9);
    await builder.drawWire('Rc', 'B', 'Pc', 'in');

    // Baseline step with DEFAULT BF=100: BJT saturated, Vc ≈ 0V
    await builder.stepViaUI();
    await builder.verifyNoErrors();
    const defaultState = await builder.stepAndReadAnalog(200);
    expect(defaultState).not.toBeNull();
    const vcDefault = defaultState!.nodeVoltages['Pc'];
    expect(vcDefault).toBeDefined();

    // Open popup and change BF from 100 to 10 via the primary param row.
    // BF=10 puts the BJT in active region → Vc rises to ~7V.
    await openPopupForLabel(builder, 'Q1');
    await setModelParamInPopup(page, 'BF', 10);
    await page.keyboard.press("Escape");

    // Step again to pick up hot-loaded BF change
    const hotState = await builder.stepAndReadAnalog(200);
    expect(hotState).not.toBeNull();
    const vcHot = hotState!.nodeVoltages['Pc'];
    expect(vcHot).toBeDefined();

    // Collector voltage must differ between BF=100 (saturated ≈0V) and BF=10 (active ≈7V)
    expect(Math.abs(vcHot! - vcDefault!)).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Test suite 2: Hot-loading pin electrical params via property popup
// ---------------------------------------------------------------------------

test.describe('Hot-loading pin electrical params via property popup', () => {
  test('rOut override on And gate output pin persists after close and reopen', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    await builder.placeLabeled('And', 10, 10, 'G1');

    await openPopupForLabel(builder, 'G1');
    await expandPinElectricalSection(page);

    const rOutInput = await getPinFieldInput(page, 'Rout');
    await expect(rOutInput).toBeVisible({ timeout: 2000 });
    await rOutInput.fill('75');
    await rOutInput.press('Tab');
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape");

    // Reopen popup and verify rOut value persisted
    await openPopupForLabel(builder, 'G1');
    await expandPinElectricalSection(page);

    const rOutAfter = await getPinFieldInput(page, 'Rout');
    await expect(rOutAfter).toBeVisible({ timeout: 2000 });
    const displayedValue = await rOutAfter.inputValue();
    // Override was stored -- input must be non-empty
    expect(displayedValue.trim()).not.toBe('');
    await page.keyboard.press("Escape");
  });

  test('rOut override affects simulation output in mixed-signal mode', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    // Mixed circuit: And gate A1 (both inputs HIGH via Const) -> RL (1kOhm) -> GND
    // Probe P1 at the RL:A / A1:out junction (analog side of bridge).
    // rOut is source impedance: V_junction = Voh * RL / (rOut + RL)
    // Large rOut => small V_junction.
    // Const components output a fixed value=1 (HIGH) on every step.
    await builder.placeLabeled('Const', 1, 5, 'C1');
    await builder.placeLabeled('Const', 1, 11, 'C2');
    await builder.placeLabeled('And', 6, 8, 'A1');
    await builder.placeLabeled('Resistor', 18, 8, 'RL');
    await builder.placeComponent('Ground', 22, 14);
    await builder.placeLabeled('Probe', 24, 8, 'P1');
    await builder.setComponentProperty('RL', 'resistance', 1000);

    await builder.drawWire('C1', 'out', 'A1', 'In_1');
    await builder.drawWire('C2', 'out', 'A1', 'In_2');
    await builder.drawWire('A1', 'out', 'RL', 'A');
    await builder.drawWire('RL', 'A', 'P1', 'in');
    await builder.drawWireFromPin('RL', 'B', 22, 14);

    // Baseline measurement with default rOut
    await builder.stepViaUI();
    await builder.verifyNoErrors();
    const defaultState = await builder.stepAndReadAnalog(50);
    expect(defaultState).not.toBeNull();
    const vDefault = defaultState!.nodeVoltages['P1'];
    expect(vDefault).toBeDefined();
    expect(vDefault).toBeGreaterThan(0);

    // Override rOut to 100000 Ohm via Pin Electrical popup
    await openPopupForLabel(builder, 'A1');
    await expandPinElectricalSection(page);
    const rOutInput = await getPinFieldInput(page, 'Rout');
    await expect(rOutInput).toBeVisible({ timeout: 2000 });
    await rOutInput.fill('100000');
    await rOutInput.press('Tab');
    await page.waitForTimeout(100);
    await page.keyboard.press("Escape");

    // Step with hot-loaded rOut override
    await builder.stepViaUI();
    await builder.verifyNoErrors();
    const overrideState = await builder.stepAndReadAnalog(50);
    expect(overrideState).not.toBeNull();
    const vOverride = overrideState!.nodeVoltages['P1'];
    expect(vOverride).toBeDefined();

    // rOut=100kOhm >> RL=1kOhm: V_junction = Voh*1k/101k ~= 0.05V
    // vs default rOut giving V_junction near Voh (>4V)
    expect(vOverride).toBeLessThan(vDefault! - 0.5);
    expect(isNaN(vOverride!)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test suite 3: Pin loading mode switch via context menu
// ---------------------------------------------------------------------------

test.describe('Pin loading mode switch via UI context menu', () => {
  test('context menu on digital-to-analog wire shows all three Pin Loading options', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    const { wireMidX, wireMidY } = await buildMixedCircuitAndGetWireMid(builder);

    await page.mouse.click(wireMidX, wireMidY, { button: 'right' });
    await page.waitForTimeout(200);

    const menu = page.locator('.ctx-menu');
    await expect(menu).toBeVisible({ timeout: 3000 });

    const labels = await page.evaluate(() => {
      const items = document.querySelectorAll('.ctx-menu-item .ctx-menu-label');
      return Array.from(items).map(el => el.textContent ?? "");
    });

    expect(labels.some(l => l.includes('Pin Loading: Loaded'))).toBe(true);
    expect(labels.some(l => l.includes('Pin Loading: Ideal'))).toBe(true);
    expect(labels.some(l => l.includes('Pin Loading: Default'))).toBe(true);
  });

  test('selecting Pin Loading: Loaded shows checkmark and simulation continues without error', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    const { wireMidX, wireMidY } = await buildMixedCircuitAndGetWireMid(builder);

    // Baseline step confirms simulation runs
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Switch to Loaded
    await page.mouse.click(wireMidX, wireMidY, { button: 'right' });
    await page.waitForTimeout(200);

    const loadedItem = page.locator('.ctx-menu-item .ctx-menu-label').filter({
      hasText: 'Pin Loading: Loaded',
    });
    await expect(loadedItem).toBeVisible({ timeout: 3000 });
    await loadedItem.click();
    await page.waitForTimeout(300);

    // Canvas must still be visible (no crash)
    await expect(page.locator('#sim-canvas')).toBeVisible();

    // Step again after mode switch -- must not crash
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Checkmark must appear on the Loaded option
    await page.mouse.click(wireMidX, wireMidY, { button: 'right' });
    await page.waitForTimeout(200);

    const updatedLabels = await page.evaluate(() => {
      const items = document.querySelectorAll('.ctx-menu-item .ctx-menu-label');
      return Array.from(items).map(el => el.textContent ?? "");
    });

    const loadedLabel = updatedLabels.find(l => l.includes('Pin Loading: Loaded'));
    expect(loadedLabel).toBeDefined();
    expect(loadedLabel).toContain("✓");
  });

  test('switching to Pin Loading: Ideal produces valid finite simulation output', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    const { wireMidX, wireMidY } = await buildMixedCircuitAndGetWireMid(builder);

    // Baseline with Default loading
    await builder.stepViaUI();
    await builder.verifyNoErrors();
    const defaultState = await builder.stepAndReadAnalog(100);
    expect(defaultState).not.toBeNull();
    const vDefault = defaultState!.nodeVoltages['P1'];
    expect(vDefault).toBeDefined();
    expect(vDefault).toBeGreaterThan(0);

    // Switch to Ideal (zero output impedance)
    await page.mouse.click(wireMidX, wireMidY, { button: 'right' });
    await page.waitForTimeout(200);

    const idealItem = page.locator('.ctx-menu-item .ctx-menu-label').filter({
      hasText: 'Pin Loading: Ideal',
    });
    await expect(idealItem).toBeVisible({ timeout: 3000 });
    await idealItem.click();
    await page.waitForTimeout(300);

    await builder.stepViaUI();
    await builder.verifyNoErrors();
    const idealState = await builder.stepAndReadAnalog(100);
    expect(idealState).not.toBeNull();
    const vIdeal = idealState!.nodeVoltages['P1'];
    expect(vIdeal).toBeDefined();

    // Ideal mode (rOut=0): full Voh at junction; Default (rOut>0): reduced
    // Both must be positive and finite; Ideal >= Default
    expect(isNaN(vIdeal!)).toBe(false);
    expect(isFinite(vIdeal!)).toBe(true);
    expect(vIdeal).toBeGreaterThan(0);
    expect(vIdeal).toBeGreaterThanOrEqual(vDefault! - 0.01);
  });
});

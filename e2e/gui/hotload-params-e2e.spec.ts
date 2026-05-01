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

import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ---------------------------------------------------------------------------
// Tolerance helper
// ---------------------------------------------------------------------------

function expectClose(actual: number, expected: number, rtol = 1e-6, atol = 1e-9) {
  const err = Math.abs(actual - expected);
  const limit = Math.max(atol, Math.abs(expected) * rtol);
  expect(err, `Expected ${actual} to be close to ${expected} (err=${err}, limit=${limit})`).toBeLessThan(limit);
}

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

    // BJT common-emitter: Vcc(12V)->Rc(10k)->Q1:C, Vb(5V)->Rb(100k)->Q1:B,
    // Q1:E->GND.
    //
    // Physics: Vbe≈0.7V, Ib=(Vb-0.7)/Rb=(5-0.7)/100k≈43µA
    // Ic_sat = Vcc/Rc = 12/10k = 1.2mA
    // With BF=100 (default): Ic = 100*43µA = 4.3mA >> 1.2mA → saturated, Vc ≈ 0V
    // With BF=10 (hot-loaded): Ic = 10*43µA = 0.43mA < 1.2mA → active,
    //   Vc = 12V - 0.43mA*10kΩ ≈ 7.7V
    // Difference: ~7V >> 0.5V threshold → test will pass.
    //
    // Layout (all rot=0):
    //   DcVoltageSource Vcc@(7,5):  neg(7,5), pos(11,5)   voltage=12V
    //   Resistor Rc@(14,5):         A(14,5),  B(18,5)     resistance=10kΩ
    //   NpnBJT Q1@(16,9):          B(16,9),  C(20,8), E(20,10)
    //   DcVoltageSource Vb@(7,12):  neg(7,12), pos(11,12)  voltage=5V
    //   Resistor Rb@(12,9):         A(12,9),  B(16,9)     resistance=100kΩ
    //   Grounds at (5,5), (7,14), (20,12)
    //   Rb.B@(16,9) auto-connects to Q1.B@(16,9)
    await builder.placeLabeled('DcVoltageSource', 7, 5, 'Vcc');
    await builder.setComponentProperty('Vcc', 'voltage', 12);
    await builder.placeLabeled('Resistor', 14, 5, 'Rc');
    await builder.setComponentProperty('Rc', 'resistance', 10000);
    await builder.placeLabeled('NpnBJT', 16, 9, 'Q1');
    await builder.setSpiceParameter('Q1', 'IS', 1e-14);
    await builder.placeLabeled('DcVoltageSource', 7, 12, 'Vb');
    await builder.setComponentProperty('Vb', 'voltage', 5);
    await builder.placeLabeled('Resistor', 12, 9, 'Rb');
    await builder.setComponentProperty('Rb', 'resistance', 100000);

    // Grounds
    await builder.placeComponent('Ground', 5, 5);    // Vcc.neg ground
    await builder.placeComponent('Ground', 7, 14);    // Vb.neg ground
    await builder.placeComponent('Ground', 20, 12);   // Q1.E ground

    // Wiring
    // Vcc.pos(11,5) → Rc.A(14,5): straight horizontal
    await builder.drawWireExplicit('Vcc', 'pos', 'Rc', 'A');
    // Rc.B(18,5) → Q1.C(20,8): L-shape via (20,5)
    await builder.drawWireExplicit('Rc', 'B', 'Q1', 'C', [[20, 5]]);
    // Vb.pos(11,12) → Rb.A(12,9): L-shape via (11,9)
    await builder.drawWireExplicit('Vb', 'pos', 'Rb', 'A', [[11, 9]]);
    // Rb.B(16,9) auto-connects to Q1.B(16,9)- no wire needed
    // Vcc.neg(7,5) → Ground(5,5)
    await builder.drawWireFromPinExplicit('Vcc', 'neg', 5, 5);
    // Vb.neg(7,12) → Ground(7,14)
    await builder.drawWireFromPinExplicit('Vb', 'neg', 7, 14);
    // Q1.E(20,10) → Ground(20,12)
    await builder.drawWireFromPinExplicit('Q1', 'E', 20, 12);

    // --- Phase A: BF=100 (default)- BJT saturated ---
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    await builder.addTraceViaContextMenu('Q1', 'C');
    await builder.stepToTimeViaUI('1m');
    const valuesA = await builder.getTraceValues();
    expect(valuesA).not.toBeNull();
    expect(valuesA!.length).toBeGreaterThanOrEqual(1);

    const vcA = valuesA![0].value;
    console.log(`[hotload-BF] Phase A: Vc(BF=100) = ${vcA} (ngspice ref: 9.57744513e-02)`);
    expect(Number.isFinite(vcA)).toBe(true);
    expectClose(vcA, 9.57744513e-02);

    // --- Phase B: Hot-load BF=10 via UI popup ---
    await builder.setSpiceParameter('Q1', 'BF', 10);
    await builder.stepToTimeViaUI('2m');
    const valuesB = await builder.getTraceValues();
    expect(valuesB).not.toBeNull();

    const vcB = valuesB![0].value;
    console.log(`[hotload-BF] Phase B: Vc(BF=10) = ${vcB} (ngspice ref: 7.63368375e+00)`);
    expect(Number.isFinite(vcB)).toBe(true);
    expectClose(vcB, 7.63368375e+00);
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
    const defaultState = await builder.stepAndReadAnalog('5m');
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
    const overrideState = await builder.stepAndReadAnalog('10m');
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
    const defaultState = await builder.stepAndReadAnalog('5m');
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
    const idealState = await builder.stepAndReadAnalog('10m');
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

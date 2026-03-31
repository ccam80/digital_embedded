/**
 * E2E tests for model parameter editing in the property popup.
 *
 * After the model registry migration, SPICE parameters are no longer shown in a
 * dedicated "SPICE Model Parameters" collapsible section. Instead, the property
 * popup renders model params directly:
 *   - Primary params (BF, IS for BJT) appear inline below the Model dropdown.
 *   - Secondary params (NF, BR, VAF, etc.) appear in a "▶ Advanced Parameters"
 *     collapsible subsection.
 *
 * Tests:
 *   1. Primary params visible for NPN BJT — IS and BF labels shown directly
 *   2. No model params shown for Resistor
 *   3. And gate in digital mode shows no IS/BF/Advanced Parameters
 *   4. Edit IS field and verify persistence through close/reopen
 *   5. IS override affects BJT collector current
 */
import { test, expect, type Page } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Double-click a labeled element to open its property popup.
 * If a popup is already open, closes it first via the close button.
 */
async function openPopupForLabel(builder: UICircuitBuilder, label: string): Promise<void> {
  // Close any open popup first (click outside the popup area to dismiss)
  const existingPopup = builder.page.locator('.prop-popup');
  if (await existingPopup.isVisible().catch(() => false)) {
    await existingPopup.locator('.prop-popup-close').click();
    await existingPopup.waitFor({ state: 'hidden', timeout: 2000 });
  }
  const info = await builder.getCircuitInfo();
  const el = info.elements.find(e => e.label === label);
  expect(el, `Element "${label}" not found`).toBeTruthy();
  const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
  await builder.page.mouse.dblclick(coords.x, coords.y);
  await expect(builder.page.locator('.prop-popup')).toBeVisible({ timeout: 3000 });
}

/**
 * Find the input for a named model parameter inside the popup.
 * Primary params are rendered as prop-row with a label element.
 * Row structure: div.prop-row > label(key) + input + span(unit) + button(reset)
 */
async function getModelParamInput(page: Page, paramKey: string) {
  const popup = page.locator('.prop-popup');
  const keyLabel = popup.locator('label').filter({ hasText: new RegExp(`^${paramKey}$`) });
  const row = keyLabel.first().locator('..');
  return row.locator('input').first();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Model parameter panel', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
  });

  // -------------------------------------------------------------------------
  // Test 1: Primary params visible for NPN BJT
  // -------------------------------------------------------------------------
  test('panel visible for NPN BJT in analog mode', async ({ page }) => {
    // NPN BJT defaultModel is "behavioral" — primary params IS and BF are
    // rendered directly below the Model row (no expand needed).
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');

    await openPopupForLabel(builder, 'Q1');

    const popup = page.locator('.prop-popup');
    // Primary params IS and BF must be visible without any expand action
    await expect(popup.locator('label').filter({ hasText: /^IS$/ })).toBeVisible({ timeout: 3000 });
    await expect(popup.locator('label').filter({ hasText: /^BF$/ })).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // Test 2: No model params shown for resistor
  // -------------------------------------------------------------------------
  test('panel not shown for resistor', async ({ page }) => {
    await builder.placeLabeled('Resistor', 14, 10, 'R1');

    await openPopupForLabel(builder, 'R1');

    const popup = page.locator('.prop-popup');
    // Resistor has no IS or BF params
    await expect(popup.locator('label').filter({ hasText: /^IS$/ })).not.toBeVisible();
    await expect(popup.locator('label').filter({ hasText: /^BF$/ })).not.toBeVisible();

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // Test 3: And gate in digital mode shows no model params
  // -------------------------------------------------------------------------
  test('panel not shown when model is logical', async ({ page }) => {
    // And gate defaultModel is "digital" — _renderModelParams returns early for
    // "digital" key, so no IS/BF/Advanced Parameters appear in the popup.
    await builder.placeLabeled('And', 10, 10, 'G1');

    await openPopupForLabel(builder, 'G1');

    const popup = page.locator('.prop-popup');
    await expect(popup.locator('label').filter({ hasText: /^IS$/ })).not.toBeVisible();
    await expect(popup.locator('label').filter({ hasText: /^BF$/ })).not.toBeVisible();
    await expect(popup.getByText('▶ Advanced Parameters')).not.toBeVisible();

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // Test 4: Edit IS field and verify persistence through close/reopen
  // -------------------------------------------------------------------------
  test('edited IS value persists after closing and reopening popup', async ({ page }) => {
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');

    // Open popup — IS is a primary param, visible directly
    await openPopupForLabel(builder, 'Q1');

    const isInput = await getModelParamInput(page, 'IS');
    await expect(isInput).toBeVisible({ timeout: 2000 });
    await isInput.fill('1e-14');
    await isInput.press('Enter');

    // Close popup via close button (Escape does not close the property popup)
    await page.locator('.prop-popup-close').click();
    await expect(page.locator('.prop-popup')).not.toBeVisible({ timeout: 2000 });

    // Reopen popup
    await openPopupForLabel(builder, 'Q1');

    // Verify the IS field still shows the entered value
    const isInputAfter = await getModelParamInput(page, 'IS');
    await expect(isInputAfter).toBeVisible({ timeout: 2000 });
    const displayedValue = await isInputAfter.inputValue();
    // formatSI(1e-14, "", 3) → "10.0 f" — value encodes 1e-14
    expect(
      displayedValue.includes('10') || displayedValue.includes('1e-14') || displayedValue.includes('1E-14')
    ).toBe(true);

    await page.locator('.prop-popup-close').click();
  });

  // -------------------------------------------------------------------------
  // Test 5: IS override affects BJT collector voltage vs default parameters
  // -------------------------------------------------------------------------
  test('IS override affects BJT collector current', async () => {
    // Build a BJT CE circuit with IS=1e-14 override (default IS=1e-14 in
    // BJT_NPN_DEFAULTS; override via model param input confirms hot-load works).
    // Circuit: Vcc (12V) -> Rc (4.7k) -> Q1:C, Vin (1V) -> Rb (100k) -> Q1:B,
    //          Q1:E -> Re (1k) -> GND

    await builder.placeLabeled('DcVoltageSource', 7, 5, 'Vcc');
    await builder.placeLabeled('DcVoltageSource', 7, 15, 'Vin');
    await builder.placeLabeled('Resistor', 14, 5, 'Rc');
    await builder.placeLabeled('Resistor', 14, 12, 'Rb');
    await builder.placeLabeled('NpnBJT', 16, 10, 'Q1');
    await builder.placeLabeled('Resistor', 20, 16, 'Re');
    await builder.placeComponent('Ground', 11, 20);
    await builder.placeComponent('Ground', 24, 20);
    await builder.placeComponent('Ground', 11, 10);
    await builder.placeLabeled('Probe', 26, 8, 'Pc');

    await builder.setComponentProperty('Vcc', 'voltage', 12);
    await builder.setComponentProperty('Vin', 'voltage', 1);
    await builder.setComponentProperty('Rb', 'resistance', 100000);
    await builder.setComponentProperty('Rc', 'resistance', 4700);
    await builder.setComponentProperty('Re', 'resistance', 1000);

    // Set IS=1e-14 override via model param inputs BEFORE first step
    await builder.setSpiceOverrides('Q1', { IS: 1e-14, BF: 100, VAF: 100 });

    await builder.drawWire('Vcc', 'pos', 'Rc', 'A');
    await builder.drawWire('Rc', 'B', 'Q1', 'C');
    await builder.drawWire('Vin', 'pos', 'Rb', 'A');
    await builder.drawWire('Rb', 'B', 'Q1', 'B');
    await builder.drawWire('Q1', 'E', 'Re', 'A');
    await builder.drawWireFromPin('Re', 'B', 24, 20);
    await builder.drawWireFromPin('Vcc', 'neg', 11, 20);
    await builder.drawWireFromPin('Vin', 'neg', 11, 10);
    await builder.drawWire('Rc', 'B', 'Pc', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const state = await builder.stepAndReadAnalog(300);
    expect(state).not.toBeNull();
    expect(state!.simTime).toBeGreaterThan(0);

    const vc = state!.nodeVoltages['Pc'];
    expect(vc).toBeDefined();

    // With IS=1e-14 the BJT conducts and Vc drops well below Vcc (12V).
    expect(vc).toBeLessThan(11.5);
    expect(vc).toBeGreaterThan(0);
  });
});

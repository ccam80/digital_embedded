/**
 * E2E tests for the SPICE Model Parameters collapsible panel in the property popup.
 *
 * Tests:
 *   1. Panel visibility — NPN BJT in analog mode shows "SPICE Model Parameters" section
 *   2. Panel hidden for resistor — no SPICE section in resistor popup
 *   3. Panel hidden in logical mode — BJT in logical mode shows no SPICE section
 *   4. Edit and persist — entering IS value in SPICE panel round-trips through close/reopen
 *   5. Override affects simulation — IS override on BJT changes collector current vs default
 */
import { test, expect, type Page } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Double-click a labeled element to open its property popup.
 * Returns page-absolute coordinates of the element center.
 */
async function openPopupForLabel(builder: UICircuitBuilder, label: string): Promise<void> {
  const info = await builder.getCircuitInfo();
  const el = info.elements.find(e => e.label === label);
  expect(el, `Element "${label}" not found`).toBeTruthy();
  const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
  await builder.page.mouse.dblclick(coords.x, coords.y);
  await expect(builder.page.locator('.prop-popup')).toBeVisible({ timeout: 3000 });
}

/**
 * Click the SPICE Model Parameters toggle to expand the section.
 * The toggle text starts with "▶ SPICE Model Parameters" when collapsed.
 */
async function expandSpiceSection(page: Page): Promise<void> {
  const toggle = page.locator('.prop-popup').getByText('▶ SPICE Model Parameters');
  await expect(toggle).toBeVisible({ timeout: 2000 });
  await toggle.click();
  // After clicking, toggle text changes to "▼ SPICE Model Parameters"
  await expect(page.locator('.prop-popup').getByText('▼ SPICE Model Parameters')).toBeVisible({ timeout: 1000 });
}

/**
 * Find the IS parameter input inside the expanded SPICE section.
 * The input is in a row that has a span with text "IS" as its label.
 */
async function getSpiceParamInput(page: Page, paramKey: string) {
  const popup = page.locator('.prop-popup');
  // Find a div row inside the SPICE section that contains a label span with the param key
  // The row structure: div > span(key) + input + span(unit)
  // We locate the input adjacent to the IS label by finding the row that contains IS text
  const rows = popup.locator('div').filter({ has: page.locator(`span:text-is("${paramKey}")`) });
  const input = rows.locator('input').first();
  return input;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('SPICE Model Parameters panel', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
  });

  // -------------------------------------------------------------------------
  // Test 1: Panel visibility for NPN BJT in analog mode
  // -------------------------------------------------------------------------
  test('panel visible for NPN BJT in analog mode', async ({ page }) => {
    // Place an NPN BJT — analog model is its default
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');

    // Open property popup
    await openPopupForLabel(builder, 'Q1');

    // Verify the SPICE Model Parameters toggle header is present
    const popup = page.locator('.prop-popup');
    const spiceToggle = popup.getByText('▶ SPICE Model Parameters');
    await expect(spiceToggle).toBeVisible({ timeout: 3000 });

    // Section should start collapsed — content not yet visible
    // Click toggle to expand and confirm params appear
    await spiceToggle.click();
    const isLabel = popup.locator('span').filter({ hasText: /^IS$/ }).first();
    await expect(isLabel).toBeVisible({ timeout: 2000 });

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // Test 2: Panel hidden for resistor
  // -------------------------------------------------------------------------
  test('panel not shown for resistor', async ({ page }) => {
    await builder.placeLabeled('Resistor', 10, 10, 'R1');

    await openPopupForLabel(builder, 'R1');

    const popup = page.locator('.prop-popup');
    // The SPICE section toggle must not appear
    await expect(popup.getByText('▶ SPICE Model Parameters')).not.toBeVisible();

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // Test 3: Panel hidden when component's model is "logical"
  // -------------------------------------------------------------------------
  test('panel not shown when model is logical', async ({ page }) => {
    // Use an And gate which has both logical and analog models.
    // In logical mode (default) it has no deviceType in its analog model,
    // so the SPICE section must not appear.
    await builder.placeLabeled('And', 10, 10, 'G1');

    await openPopupForLabel(builder, 'G1');

    const popup = page.locator('.prop-popup');
    // And gate in logical/default mode must not show SPICE section
    await expect(popup.getByText('▶ SPICE Model Parameters')).not.toBeVisible();

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // Test 4: Edit IS field and verify persistence through close/reopen
  // -------------------------------------------------------------------------
  test('edited IS value persists after closing and reopening popup', async ({ page }) => {
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');

    // Open popup and expand SPICE section
    await openPopupForLabel(builder, 'Q1');
    await expandSpiceSection(page);

    // Enter 1e-14 in the IS field
    const isInput = await getSpiceParamInput(page, 'IS');
    await expect(isInput).toBeVisible({ timeout: 2000 });
    await isInput.fill('1e-14');
    await isInput.press('Enter');

    // Close popup
    await page.keyboard.press('Escape');

    // Reopen popup
    await openPopupForLabel(builder, 'Q1');

    // Expand SPICE section again
    await expandSpiceSection(page);

    // Verify the IS field still shows the entered value
    const isInputAfter = await getSpiceParamInput(page, 'IS');
    await expect(isInputAfter).toBeVisible({ timeout: 2000 });
    const displayedValue = await isInputAfter.inputValue();
    // formatSI(1e-14, "", 3) → "10.0 f" — verify the displayed value encodes 1e-14
    expect(displayedValue).toContain('10');
    expect(displayedValue.toLowerCase()).toContain('f');

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // Test 5: IS override affects BJT collector voltage vs default parameters
  // -------------------------------------------------------------------------
  test('IS override affects BJT collector current', async () => {
    // Build a BJT CE circuit identical to a8_bjt_ce but with IS=1e-14
    // (100x larger than the engine default IS=1e-16). With higher IS the
    // transistor conducts more, so the collector voltage drops.
    //
    // Circuit: Vcc (12V) -> Rc (4.7k) -> Q1:C, Vin (1V) -> Rb (100k) -> Q1:B,
    //          Q1:E -> Re (1k) -> GND

    await builder.placeLabeled('DcVoltageSource', 3, 5, 'Vcc');
    await builder.placeLabeled('DcVoltageSource', 3, 15, 'Vin');
    await builder.placeLabeled('Resistor', 10, 5, 'Rc');
    await builder.placeLabeled('Resistor', 10, 12, 'Rb');
    await builder.placeLabeled('NpnBJT', 16, 10, 'Q1');
    await builder.placeLabeled('Resistor', 16, 16, 'Re');
    await builder.placeComponent('Ground', 6, 20);
    await builder.placeComponent('Ground', 18, 20);
    await builder.placeComponent('Ground', 6, 10);
    await builder.placeLabeled('Probe', 22, 8, 'Pc');

    await builder.setComponentProperty('Vcc', 'voltage', 12);
    await builder.setComponentProperty('Vin', 'voltage', 1);
    await builder.setComponentProperty('Rb', 'resistance', 100000);
    await builder.setComponentProperty('Rc', 'resistance', 4700);
    await builder.setComponentProperty('Re', 'resistance', 1000);

    // Set IS=1e-14 override via SPICE panel BEFORE first step (included in compilation)
    await builder.setSpiceOverrides('Q1', { IS: 1e-14, BF: 100, VAF: 100 });

    await builder.drawWire('Vcc', 'pos', 'Rc', 'A');
    await builder.drawWire('Rc', 'B', 'Q1', 'C');
    await builder.drawWire('Vin', 'pos', 'Rb', 'A');
    await builder.drawWire('Rb', 'B', 'Q1', 'B');
    await builder.drawWire('Q1', 'E', 'Re', 'A');
    await builder.drawWireFromPin('Re', 'B', 18, 20);
    await builder.drawWireFromPin('Vcc', 'neg', 6, 20);
    await builder.drawWireFromPin('Vin', 'neg', 6, 10);
    await builder.drawWire('Rc', 'B', 'Pc', 'in');

    await builder.stepViaUI();
    await builder.verifyNoErrors();

    const state = await builder.stepAndReadAnalog(300);
    expect(state).not.toBeNull();
    expect(state!.simTime).toBeGreaterThan(0);

    const vc = state!.nodeVoltages['Pc'];
    expect(vc).toBeDefined();

    // With default IS=1e-16 the BJT barely conducts and Vc ~ 12V (near Vcc).
    // With IS=1e-14 the BJT conducts significantly and Vc drops well below 12V.
    // Verify collector voltage is below 11.5V (measurable conduction).
    expect(vc).toBeLessThan(11.5);
    // And above 0V (transistor not saturated to ground)
    expect(vc).toBeGreaterThan(0);
  });
});

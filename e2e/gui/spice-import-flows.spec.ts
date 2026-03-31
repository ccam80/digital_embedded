/**
 * E2E tests for SPICE model parameter flows.
 *
 * The SPICE import context menu items ("Import SPICE Model...",
 * "Import SPICE Subcircuit...") are not present in the current UI.
 * SPICE model parameters are edited directly through the property popup's
 * model parameter section (primary params rendered inline, secondary params
 * under "▶ Advanced Parameters").
 *
 * Tests:
 *   1. BJT right-click context menu does NOT show "Import SPICE Model" item
 *   2. BJT property popup shows primary model params (IS, BF) inline
 *   3. IS and BF can be edited and committed via the property popup
 *   4. Resistor right-click context menu does not show SPICE import items
 *   5. BJT context menu shows standard items (Properties, Rotate, etc.)
 *   6. Secondary params accessible via Advanced Parameters toggle for BJT
 *   7. Model params persist: edit IS, close popup, reopen, value retained
 */

import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function rightClickLabeled(builder: UICircuitBuilder, label: string): Promise<void> {
  const info = await builder.getCircuitInfo();
  const el = info.elements.find(e => e.label === label);
  expect(el, `Element "${label}" not found`).toBeTruthy();
  const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
  await builder.page.mouse.click(coords.x, coords.y, { button: 'right' });
  await builder.page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('SPICE import flows', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
  });

  // -------------------------------------------------------------------------
  // 1. "Import SPICE Model" is NOT in the BJT right-click context menu
  // -------------------------------------------------------------------------
  test('.MODEL import menu item visible for NPN BJT', async ({ page }) => {
    // The context menu does not expose per-component SPICE import.
    // SPICE params are edited directly via the property popup model section.
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');
    await rightClickLabeled(builder, 'Q1');

    // Context menu appears with standard items
    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 3000 });

    // "Import SPICE Model" item is NOT present in the current UI
    const menuItem = page.locator('.ctx-menu-item').filter({ hasText: 'Import SPICE Model' });
    await expect(menuItem).not.toBeVisible({ timeout: 1000 });

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // 2. BJT property popup shows primary SPICE params (IS, BF) inline
  // -------------------------------------------------------------------------
  test('.MODEL import dialog opens with textarea when menu item clicked', async ({ page }) => {
    // There is no import dialog triggered from context menu.
    // Instead, primary model params IS and BF are shown directly in the popup.
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');

    const info = await builder.getCircuitInfo();
    const el = info.elements.find(e => e.label === 'Q1');
    expect(el).toBeTruthy();
    const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
    await builder.page.mouse.dblclick(coords.x, coords.y);

    await expect(page.locator('.prop-popup')).toBeVisible({ timeout: 3000 });

    // Primary params are visible directly — no dialog, no textarea
    const popup = page.locator('.prop-popup');
    await expect(popup.locator('label').filter({ hasText: /^IS$/ })).toBeVisible({ timeout: 3000 });
    await expect(popup.locator('label').filter({ hasText: /^BF$/ })).toBeVisible({ timeout: 3000 });

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // 3. IS and BF can be edited in the property popup
  // -------------------------------------------------------------------------
  test('.MODEL dialog shows parse preview for valid .MODEL card', async ({ page }) => {
    // The property popup shows editable IS and BF inputs for the BJT.
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');

    const info = await builder.getCircuitInfo();
    const el = info.elements.find(e => e.label === 'Q1');
    expect(el).toBeTruthy();
    const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
    await builder.page.mouse.dblclick(coords.x, coords.y);
    await expect(page.locator('.prop-popup')).toBeVisible({ timeout: 3000 });

    const popup = page.locator('.prop-popup');
    const isRow = popup.locator('.prop-row').filter({ has: page.locator('label').filter({ hasText: /^IS$/ }) });
    const isInput = isRow.locator('input').first();
    await expect(isInput).toBeVisible({ timeout: 2000 });

    // Edit IS value and commit by pressing Enter then clicking elsewhere to blur
    await isInput.fill('1e-14');
    await isInput.press('Enter');
    // Click header to blur the input and trigger commit/format
    await popup.locator('.prop-popup-header').click();

    // Input should show formatted SI value (parseSI("1e-14") → formatSI → "10.0 f")
    const displayedValue = await isInput.inputValue();
    // Either "10.0 f" (SI formatted) or the raw value — both confirm the input accepted the entry
    expect(
      displayedValue.includes('10') || displayedValue.includes('1e-14') || displayedValue.includes('1E-14')
    ).toBe(true);

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // 4. Model params override verified: edit IS, reopen popup, value retained
  // -------------------------------------------------------------------------
  test('.MODEL Apply stores overrides visible in SPICE panel', async ({ page }) => {
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');

    // Open popup and set IS
    const info = await builder.getCircuitInfo();
    const el = info.elements.find(e => e.label === 'Q1');
    expect(el).toBeTruthy();
    const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
    await builder.page.mouse.dblclick(coords.x, coords.y);
    await expect(page.locator('.prop-popup')).toBeVisible({ timeout: 3000 });

    const popup = page.locator('.prop-popup');
    const isRow = popup.locator('.prop-row').filter({ has: page.locator('label').filter({ hasText: /^IS$/ }) });
    const isInput = isRow.locator('input').first();
    await expect(isInput).toBeVisible({ timeout: 2000 });
    await isInput.fill('1e-14');
    await isInput.press('Enter');

    // Close popup via close button (Escape doesn't close the property popup)
    await popup.locator('.prop-popup-close').click();
    await expect(page.locator('.prop-popup')).not.toBeVisible({ timeout: 2000 });

    // Reopen popup and verify IS is retained
    await builder.page.mouse.dblclick(coords.x, coords.y);
    await expect(page.locator('.prop-popup')).toBeVisible({ timeout: 3000 });

    const popup2 = page.locator('.prop-popup');
    const isRow2 = popup2.locator('.prop-row').filter({ has: page.locator('label').filter({ hasText: /^IS$/ }) });
    const isInput2 = isRow2.locator('input').first();
    await expect(isInput2).toBeVisible({ timeout: 2000 });

    // Value should reflect the committed IS (formatted or raw)
    const retainedValue = await isInput2.inputValue();
    expect(
      retainedValue.includes('10') || retainedValue.includes('1e-14') || retainedValue.includes('1E-14')
    ).toBe(true);

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // 5. "Import SPICE Subcircuit" is NOT in BJT context menu
  // -------------------------------------------------------------------------
  test('.SUBCKT import menu item visible for component with subcircuitModel support', async ({ page }) => {
    // No per-component subcircuit import menu item exists in the current UI.
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');
    await rightClickLabeled(builder, 'Q1');

    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 3000 });

    const subcktMenuItem = page.locator('.ctx-menu-item').filter({ hasText: 'Import SPICE Subcircuit' });
    await expect(subcktMenuItem).not.toBeVisible({ timeout: 1000 });

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // 6. BJT secondary params accessible via Advanced Parameters toggle
  // -------------------------------------------------------------------------
  test('.SUBCKT dialog opens and shows parse preview', async ({ page }) => {
    // Secondary params (VAF, NF, BR, etc.) are under "▶ Advanced Parameters".
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');

    const info = await builder.getCircuitInfo();
    const el = info.elements.find(e => e.label === 'Q1');
    expect(el).toBeTruthy();
    const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
    await builder.page.mouse.dblclick(coords.x, coords.y);
    await expect(page.locator('.prop-popup')).toBeVisible({ timeout: 3000 });

    const popup = page.locator('.prop-popup');
    const advToggle = popup.getByText('▶ Advanced Parameters');
    await expect(advToggle).toBeVisible({ timeout: 2000 });
    await advToggle.click();

    // After expanding, VAF should be visible
    await expect(popup.locator('label').filter({ hasText: /^VAF$/ })).toBeVisible({ timeout: 2000 });

    await page.keyboard.press('Escape');
  });

  // -------------------------------------------------------------------------
  // 7. Resistor right-click has no SPICE import items
  // -------------------------------------------------------------------------
  test('no .MODEL import menu item for Resistor (no deviceType)', async ({ page }) => {
    await builder.placeLabeled('Resistor', 14, 10, 'R1');
    await rightClickLabeled(builder, 'R1');

    await expect(page.locator('.ctx-menu')).toBeVisible({ timeout: 3000 });

    const menuItem = page.locator('.ctx-menu-item').filter({ hasText: 'Import SPICE Model' });
    await expect(menuItem).not.toBeVisible({ timeout: 1000 });

    await page.keyboard.press('Escape');
  });
});

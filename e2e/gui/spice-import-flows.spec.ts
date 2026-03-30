/**
 * E2E tests for SPICE import UI flows (W11.4).
 *
 * Tests:
 *   1. .MODEL import — right-click BJT → "Import SPICE Model..." menu item visible
 *   2. .MODEL import — dialog opens with textarea
 *   3. .MODEL import — paste valid .MODEL card, preview shows name/type/param count
 *   4. .MODEL import — Apply stores model params override (verified via property popup IS field)
 *   5. .SUBCKT import — right-click BJT (with subcircuitModel) → "Import SPICE Subcircuit..." menu item visible
 *   6. .SUBCKT import — dialog opens and parses .SUBCKT block, preview shows summary
 *   7. .MODEL resistor — right-click Resistor → no "Import SPICE Model..." in menu
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
  // 1. .MODEL import menu item visible for BJT
  // -------------------------------------------------------------------------
  test('.MODEL import menu item visible for NPN BJT', async ({ page }) => {
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');
    await rightClickLabeled(builder, 'Q1');

    const menuItem = page.locator('.ctx-menu-item').filter({ hasText: 'Import SPICE Model' });
    await expect(menuItem).toBeVisible({ timeout: 3000 });
  });

  // -------------------------------------------------------------------------
  // 2. .MODEL import dialog opens with textarea
  // -------------------------------------------------------------------------
  test('.MODEL import dialog opens with textarea when menu item clicked', async ({ page }) => {
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');
    await rightClickLabeled(builder, 'Q1');

    const menuItem = page.locator('.ctx-menu-item').filter({ hasText: 'Import SPICE Model' });
    await menuItem.click();

    await expect(page.locator('.spice-import-dialog')).toBeVisible({ timeout: 3000 });
    await expect(page.locator('.spice-import-textarea')).toBeVisible({ timeout: 2000 });
  });

  // -------------------------------------------------------------------------
  // 3. Parse preview shows name, device type, parameter count
  // -------------------------------------------------------------------------
  test('.MODEL dialog shows parse preview for valid .MODEL card', async ({ page }) => {
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');
    await rightClickLabeled(builder, 'Q1');

    const menuItem = page.locator('.ctx-menu-item').filter({ hasText: 'Import SPICE Model' });
    await menuItem.click();

    await expect(page.locator('.spice-import-dialog')).toBeVisible({ timeout: 3000 });

    const textarea = page.locator('.spice-import-textarea');
    await textarea.fill('.MODEL 2N2222 NPN(IS=1e-14 BF=200 NF=1)');

    // Preview section should show the model name
    await expect(page.locator('.spice-import-summary')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('.spice-import-summary')).toContainText('2N2222');
    await expect(page.locator('.spice-import-summary')).toContainText('NPN');
  });

  // -------------------------------------------------------------------------
  // 4. Apply stores model params override — verified via IS field in property popup
  // -------------------------------------------------------------------------
  test('.MODEL Apply stores overrides visible in SPICE panel', async ({ page }) => {
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');
    await rightClickLabeled(builder, 'Q1');

    const menuItem = page.locator('.ctx-menu-item').filter({ hasText: 'Import SPICE Model' });
    await menuItem.click();

    await expect(page.locator('.spice-import-dialog')).toBeVisible({ timeout: 3000 });

    const textarea = page.locator('.spice-import-textarea');
    await textarea.fill('.MODEL 2N2222 NPN(IS=1e-14 BF=200)');

    const applyBtn = page.locator('.spice-import-apply');
    await expect(applyBtn).toBeEnabled({ timeout: 2000 });
    await applyBtn.click();

    // Dialog should close after apply
    await expect(page.locator('.spice-import-dialog')).not.toBeVisible({ timeout: 2000 });

    // Now open property popup for Q1 via double-click
    const info = await builder.getCircuitInfo();
    const el = info.elements.find(e => e.label === 'Q1');
    expect(el).toBeTruthy();
    const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
    await builder.page.mouse.dblclick(coords.x, coords.y);
    await expect(page.locator('.prop-popup')).toBeVisible({ timeout: 3000 });

    // Expand SPICE Model Parameters section
    const toggle = page.locator('.prop-popup').getByText('▶ SPICE Model Parameters');
    if (await toggle.isVisible()) {
      await toggle.click();
    }

    // The SPICE panel should show IS with value 1e-14
    const spiceSection = page.locator('.prop-popup');
    await expect(spiceSection).toContainText('1e-14', { timeout: 2000 });
  });

  // -------------------------------------------------------------------------
  // 5. .SUBCKT import menu item visible for components with subcircuitModel
  // -------------------------------------------------------------------------
  test('.SUBCKT import menu item visible for component with subcircuitModel support', async ({ page }) => {
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');
    await rightClickLabeled(builder, 'Q1');

    const subcktMenuItem = page.locator('.ctx-menu-item').filter({ hasText: 'Import SPICE Subcircuit' });
    await expect(subcktMenuItem).toBeVisible({ timeout: 3000 });
  });

  // -------------------------------------------------------------------------
  // 6. .SUBCKT import dialog opens and parses block
  // -------------------------------------------------------------------------
  test('.SUBCKT dialog opens and shows parse preview', async ({ page }) => {
    await builder.placeLabeled('NpnBJT', 10, 10, 'Q1');
    await rightClickLabeled(builder, 'Q1');

    const subcktMenuItem = page.locator('.ctx-menu-item').filter({ hasText: 'Import SPICE Subcircuit' });
    await expect(subcktMenuItem).toBeVisible({ timeout: 3000 });

    await subcktMenuItem.click();
    await expect(page.locator('.spice-subckt-dialog')).toBeVisible({ timeout: 3000 });

    const textarea = page.locator('.spice-subckt-dialog .spice-import-textarea');
    await textarea.fill('.SUBCKT TESTBJT C B E\nQ1 C B E QMOD\n.MODEL QMOD NPN(IS=1e-14)\n.ENDS TESTBJT');

    await expect(page.locator('.spice-import-summary')).toBeVisible({ timeout: 2000 });
    await expect(page.locator('.spice-import-summary')).toContainText('TESTBJT');
  });

  // -------------------------------------------------------------------------
  // 7. Resistor has no .MODEL import menu item
  // -------------------------------------------------------------------------
  test('no .MODEL import menu item for Resistor (no deviceType)', async ({ page }) => {
    await builder.placeLabeled('Resistor', 10, 10, 'R1');
    await rightClickLabeled(builder, 'R1');

    const menuItem = page.locator('.ctx-menu-item').filter({ hasText: 'Import SPICE Model' });
    await expect(menuItem).not.toBeVisible({ timeout: 1500 });
  });
});

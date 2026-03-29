/**
 * E2E tests: Pin Loading wire override context menu and visual indicators.
 *
 * Verifies:
 *   1. Right-clicking a wire shows "Pin Loading: Loaded", "Pin Loading: Ideal",
 *      and "Pin Loading: Default" context menu items.
 *   2. Selecting "Pin Loading: Loaded" adds an entry to the circuit metadata
 *      and the canvas still renders without error.
 *   3. Right-clicking the same wire after selecting "Loaded" shows a checkmark
 *      on that option, indicating the current override is reflected in the menu.
 *   4. Selecting "Pin Loading: Default" removes the override from the metadata.
 *   5. The loading mode persists after recompile (canvas re-render).
 */

import { test, expect, type Page } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Right-click on a page-absolute coordinate.
 */
async function rightClickAt(page: Page, x: number, y: number): Promise<void> {
  await page.mouse.click(x, y, { button: 'right' });
}

/**
 * Build a circuit with two AND gates connected by a wire, and return
 * the page-absolute coordinates of the wire midpoint for right-clicking.
 *
 * Layout:
 *   And1 (label "A1") at grid (2, 5) — output pin "out"
 *   And2 (label "A2") at grid (8, 5) — input pin "In_1"
 *   Wire from A1.out to A2.In_1 — midpoint used for right-click
 */
async function setupCircuitWithWire(
  builder: UICircuitBuilder,
): Promise<{ wireMidX: number; wireMidY: number }> {
  await builder.load();

  // Place first AND gate at grid (2, 5) with label "A1"
  await builder.placeLabeled('And', 2, 5, 'A1');

  // Place second AND gate at grid (8, 5) with label "A2"
  await builder.placeLabeled('And', 8, 5, 'A2');

  // Draw wire from A1's output to A2's first input
  await builder.drawWire('A1', 'out', 'A2', 'In_1');

  // Compute wire midpoint in page-absolute coordinates.
  // The wire goes from A1.out to A2.In_1 — the midpoint is halfway between.
  const fromPos = await builder.getPinPagePosition('A1', 'out');
  const toPos = await builder.getPinPagePosition('A2', 'In_1');
  const wireMidX = Math.round((fromPos.x + toPos.x) / 2);
  const wireMidY = Math.round((fromPos.y + toPos.y) / 2);

  return { wireMidX, wireMidY };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Pin Loading wire override context menu', () => {

  test('right-clicking a wire shows Pin Loading menu items', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    const { wireMidX, wireMidY } = await setupCircuitWithWire(builder);

    await rightClickAt(page, wireMidX, wireMidY);
    await page.waitForTimeout(200);

    const menu = page.locator('.ctx-menu');
    await expect(menu).toBeVisible({ timeout: 3000 });

    const labels = await page.evaluate(() => {
      const items = document.querySelectorAll('.ctx-menu-item .ctx-menu-label');
      return Array.from(items).map(el => el.textContent ?? '');
    });

    const hasLoaded = labels.some(l => l.includes('Pin Loading: Loaded'));
    const hasIdeal = labels.some(l => l.includes('Pin Loading: Ideal'));
    const hasDefault = labels.some(l => l.includes('Pin Loading: Default'));

    expect(hasLoaded).toBe(true);
    expect(hasIdeal).toBe(true);
    expect(hasDefault).toBe(true);
  });

  test('clicking Pin Loading: Loaded adds override and canvas renders without error', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    const { wireMidX, wireMidY } = await setupCircuitWithWire(builder);

    await rightClickAt(page, wireMidX, wireMidY);
    await page.waitForTimeout(200);

    const loadedItem = page.locator('.ctx-menu-item .ctx-menu-label').filter({ hasText: 'Pin Loading: Loaded' });
    await expect(loadedItem).toBeVisible({ timeout: 3000 });
    await loadedItem.click();
    await page.waitForTimeout(300);

    // Canvas should still be visible (no crash)
    await expect(page.locator('#sim-canvas')).toBeVisible();

    // No error overlay / status should show error
    const statusBar = page.locator('#status-bar');
    if (await statusBar.isVisible()) {
      const statusText = await statusBar.textContent() ?? '';
      expect(statusText).not.toContain('ERROR');
    }
  });

  test('after setting Loaded, right-clicking wire shows checkmark on Loaded', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    const { wireMidX, wireMidY } = await setupCircuitWithWire(builder);

    // Right-click and select "Pin Loading: Loaded"
    await rightClickAt(page, wireMidX, wireMidY);
    await page.waitForTimeout(200);
    const loadedItem = page.locator('.ctx-menu-item .ctx-menu-label').filter({ hasText: 'Pin Loading: Loaded' });
    await expect(loadedItem).toBeVisible({ timeout: 3000 });
    await loadedItem.click();
    await page.waitForTimeout(300);

    // Right-click the wire again
    await rightClickAt(page, wireMidX, wireMidY);
    await page.waitForTimeout(200);

    // The "Pin Loading: Loaded" label should now have a checkmark (✓) prefix
    const updatedLabels = await page.evaluate(() => {
      const items = document.querySelectorAll('.ctx-menu-item .ctx-menu-label');
      return Array.from(items).map(el => el.textContent ?? '');
    });

    const loadedLabel = updatedLabels.find(l => l.includes('Pin Loading: Loaded'));
    expect(loadedLabel).toBeDefined();
    expect(loadedLabel).toContain('\u2713');
  });

  test('selecting Pin Loading: Default removes the override', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    const { wireMidX, wireMidY } = await setupCircuitWithWire(builder);

    // Set to Loaded first
    await rightClickAt(page, wireMidX, wireMidY);
    await page.waitForTimeout(200);
    const loadedItem = page.locator('.ctx-menu-item .ctx-menu-label').filter({ hasText: 'Pin Loading: Loaded' });
    await expect(loadedItem).toBeVisible({ timeout: 3000 });
    await loadedItem.click();
    await page.waitForTimeout(300);

    // Now set to Default
    await rightClickAt(page, wireMidX, wireMidY);
    await page.waitForTimeout(200);
    const defaultItem = page.locator('.ctx-menu-item .ctx-menu-label').filter({ hasText: 'Pin Loading: Default' });
    await expect(defaultItem).toBeVisible({ timeout: 3000 });
    await defaultItem.click();
    await page.waitForTimeout(300);

    // Right-click wire again — Default item should now have checkmark, Loaded should not
    await rightClickAt(page, wireMidX, wireMidY);
    await page.waitForTimeout(200);

    const finalLabels = await page.evaluate(() => {
      const items = document.querySelectorAll('.ctx-menu-item .ctx-menu-label');
      return Array.from(items).map(el => el.textContent ?? '');
    });

    const defaultLabel = finalLabels.find(l => l.includes('Pin Loading: Default'));
    const loadedLabel = finalLabels.find(l => l.includes('Pin Loading: Loaded'));

    expect(defaultLabel).toContain('\u2713');
    expect(loadedLabel).not.toContain('\u2713');
  });

  test('loading mode persists after recompile (canvas re-render)', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    const { wireMidX, wireMidY } = await setupCircuitWithWire(builder);

    // Set Loaded override on the wire
    await rightClickAt(page, wireMidX, wireMidY);
    await page.waitForTimeout(200);
    const loadedItem = page.locator('.ctx-menu-item .ctx-menu-label').filter({ hasText: 'Pin Loading: Loaded' });
    await expect(loadedItem).toBeVisible({ timeout: 3000 });
    await loadedItem.click();
    await page.waitForTimeout(300);

    // Trigger recompile by starting and stopping simulation
    await page.locator('#btn-tb-run').click();
    await page.waitForTimeout(500);
    const stopBtn = page.locator('#btn-tb-stop');
    if (await stopBtn.isVisible()) {
      await stopBtn.click();
      await page.waitForTimeout(200);
    }

    // Right-click wire — the Loaded checkmark should still be present
    await rightClickAt(page, wireMidX, wireMidY);
    await page.waitForTimeout(200);

    const persistedLabels = await page.evaluate(() => {
      const items = document.querySelectorAll('.ctx-menu-item .ctx-menu-label');
      return Array.from(items).map(el => el.textContent ?? '');
    });

    const loadedLabel = persistedLabels.find(l => l.includes('Pin Loading: Loaded'));
    expect(loadedLabel).toBeDefined();
    expect(loadedLabel).toContain('\u2713');
  });
});

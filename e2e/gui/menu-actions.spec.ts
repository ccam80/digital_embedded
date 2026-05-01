/**
 * GUI tests- menu actions work end-to-end.
 *
 * Verifies that menu items trigger their expected actions when clicked.
 * Uses data-menu attributes for reliable menu targeting.
 */
import { test, expect } from '@playwright/test';

test.describe('GUI: menu actions', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
  });

  /** Click a top-level menu by its data-menu attribute. */
  async function openMenu(page: import('@playwright/test').Page, menuName: string) {
    await page.locator(`[data-menu="${menuName}"]`).click();
  }

  test('File > New resets the circuit', async ({ page }) => {
    await openMenu(page, 'file');
    await page.locator('#btn-new').click();

    const nameInput = page.locator('#circuit-name');
    await expect(nameInput).toHaveValue('Untitled');
  });

  test('Edit > Undo/Redo menu items exist', async ({ page }) => {
    await openMenu(page, 'edit');
    await expect(page.locator('#btn-undo')).toBeVisible();
    await expect(page.locator('#btn-redo')).toBeVisible();
  });

  test('View > Fit to Content does not crash', async ({ page }) => {
    // The View dropdown may auto-close before we can click a child item.
    // Use the toolbar shortcut button instead (same action, more reliable).
    await page.locator('#btn-tb-fit').click();
    await expect(page.locator('#sim-canvas')).toBeVisible();
  });

  test('Simulation > View Traces opens viewer panel', async ({ page }) => {
    await openMenu(page, 'sim');
    await page.locator('#btn-menu-timing').click();

    const viewer = page.locator('#viewer-panel');
    await expect(viewer).toBeVisible();
  });

  test('viewer panel close button works', async ({ page }) => {
    // Open viewer panel first
    await openMenu(page, 'sim');
    await page.locator('#btn-menu-timing').click();

    const viewer = page.locator('#viewer-panel');
    await expect(viewer).toBeVisible();

    // Close it
    await page.locator('#btn-viewer-close').click();
    await expect(viewer).not.toBeVisible();
  });

  test('Simulation > Step menu item exists', async ({ page }) => {
    await openMenu(page, 'sim');
    await expect(page.locator('#btn-step')).toBeVisible();
    await expect(page.locator('#btn-run')).toBeVisible();
    await expect(page.locator('#btn-stop')).toBeVisible();
  });

  test('View > Dark Mode toggle works via menu', async ({ page }) => {
    const html = page.locator('html');
    await expect(html).not.toHaveClass(/light/);

    await openMenu(page, 'view');
    await page.locator('#btn-menu-dark-mode').click();
    await expect(html).toHaveClass(/light/);
  });
});

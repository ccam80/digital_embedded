/**
 * GUI tests — verify the application initializes correctly in a real browser.
 *
 * These catch wiring bugs in app-init.ts that unit tests cannot reach:
 * missing DOM elements, broken imports, canvas initialization failures, etc.
 */
import { test, expect } from '@playwright/test';

test.describe('GUI: application loads', () => {
  test.beforeEach(async ({ page }) => {
    // Collect console errors
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    (page as any).__consoleErrors = errors;

    await page.goto('/simulator.html');
    // Wait for the canvas to be present and sized
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
  });

  test('canvas renders without JS errors', async ({ page }) => {
    const errors = (page as any).__consoleErrors as string[];

    // Canvas should exist and have non-zero dimensions
    const canvas = page.locator('#sim-canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(100);
    expect(box!.height).toBeGreaterThan(100);

    // No uncaught JS errors during init
    expect(errors).toEqual([]);
  });

  test('menubar is present with expected menus', async ({ page }) => {
    const menubar = page.locator('#menubar');
    await expect(menubar).toBeVisible();

    // Check key menu items exist
    for (const id of ['btn-new', 'btn-open', 'btn-save']) {
      await expect(page.locator(`#${id}`)).toBeAttached();
    }
  });

  test('palette panel is visible with component categories', async ({ page }) => {
    const palette = page.locator('#palette-panel');
    await expect(palette).toBeVisible();

    // Should have at least one category rendered
    const content = page.locator('#palette-content');
    await expect(content).not.toBeEmpty();
  });

  test('toolbar buttons are present', async ({ page }) => {
    for (const id of [
      'btn-tb-undo',
      'btn-tb-redo',
      'btn-tb-fit',
      'btn-tb-run',
      'btn-tb-step',
      'btn-tb-stop',
    ]) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
  });

  test('status bar shows Ready', async ({ page }) => {
    const status = page.locator('#status-message');
    await expect(status).toHaveText('Ready');
  });

  test('viewer panel is initially hidden', async ({ page }) => {
    const viewer = page.locator('#viewer-panel');
    // viewer-panel starts with display:none (no .open class)
    await expect(viewer).not.toBeVisible();
  });

  test('dark mode toggle works', async ({ page }) => {
    const html = page.locator('html');

    // Default is dark (no .light class)
    await expect(html).not.toHaveClass(/light/);

    // Click dark mode toggle
    await page.click('#btn-dark-mode');
    await expect(html).toHaveClass(/light/);

    // Toggle back
    await page.click('#btn-dark-mode');
    await expect(html).not.toHaveClass(/light/);
  });
});

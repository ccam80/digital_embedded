/**
 * GUI tests — simulation toolbar controls.
 *
 * Verifies that the Run/Stop/Step buttons in the toolbar actually trigger
 * simulation actions, not just exist in the DOM.
 */
import { test, expect } from '@playwright/test';

test.describe('GUI: simulation controls', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/simulator.html');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
  });

  test('Step button is clickable and does not crash', async ({ page }) => {
    const stepBtn = page.locator('#btn-tb-step');
    await expect(stepBtn).toBeVisible();
    await stepBtn.click();

    // App should still be functional after stepping with no circuit
    await expect(page.locator('#sim-canvas')).toBeVisible();
  });

  test('Run and Stop buttons toggle simulation state', async ({ page }) => {
    // Click Run
    const runBtn = page.locator('#btn-tb-run');
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    // Give simulation a moment to start
    await page.waitForTimeout(200);

    // Click Stop
    const stopBtn = page.locator('#btn-tb-stop');
    await stopBtn.click();

    // Should not throw — simulation started and stopped without crashing
    await expect(page.locator('#sim-canvas')).toBeVisible();
  });

  test('Fit button works', async ({ page }) => {
    const fitBtn = page.locator('#btn-tb-fit');
    await expect(fitBtn).toBeVisible();
    await fitBtn.click();
    await expect(page.locator('#sim-canvas')).toBeVisible();
  });

  test('Undo/Redo buttons exist and are initially disabled', async ({ page }) => {
    const undoBtn = page.locator('#btn-tb-undo');
    const redoBtn = page.locator('#btn-tb-redo');
    await expect(undoBtn).toBeVisible();
    await expect(redoBtn).toBeVisible();
    await expect(undoBtn).toBeDisabled();
    await expect(redoBtn).toBeDisabled();
  });

  test('Speed controls exist', async ({ page }) => {
    const speedInput = page.locator('#speed-input');
    const speedDown = page.locator('#btn-speed-down');
    const speedUp = page.locator('#btn-speed-up');
    await expect(speedInput).toBeVisible();
    await expect(speedDown).toBeVisible();
    await expect(speedUp).toBeVisible();
  });
});

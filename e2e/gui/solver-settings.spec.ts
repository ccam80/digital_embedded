/**
 * GUI tests- the Solver tab of the Settings dialog and its bare-canvas entry.
 *
 * Givenness is implicit: an empty field is "not given" (engine default / speed
 * decides); a typed value is given, stored on the circuit, and reloads in the
 * dialog. The bare-canvas context menu opens the dialog focused on the Solver tab.
 */
import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

async function openSettingsViaMenu(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-menu="edit"]').click();
  await page.locator('#btn-menu-settings').click();
  await expect(page.locator('#settings-overlay')).toBeVisible();
}

test.describe('Solver settings dialog', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
    // A real component so Save's hot-recompile has a circuit to compile.
    await builder.placeLabeled('Resistor', 10, 8, 'R1');
  });

  test('typing a solver value persists on the circuit; clearing removes it', async ({ page }) => {
    await openSettingsViaMenu(page);
    await page.locator('#settings-tab-solver-btn').click();
    await expect(page.locator('#settings-tab-solver')).toBeVisible();

    const reltol = page.locator('#solver-reltol');
    await expect(reltol).toHaveValue(''); // not given initially → blank
    await reltol.fill('1e-6');
    await page.locator('#btn-settings-save').click();
    await expect(page.locator('#settings-overlay')).toBeHidden();

    // Reopen → the given value reloads (stored on circuit.metadata.solverSettings).
    await openSettingsViaMenu(page);
    await page.locator('#settings-tab-solver-btn').click();
    expect(Number(await page.locator('#solver-reltol').inputValue())).toBe(1e-6);

    // Clear it → reverts to not-given.
    await page.locator('#solver-reltol').fill('');
    await page.locator('#btn-settings-save').click();
    await expect(page.locator('#settings-overlay')).toBeHidden();

    await openSettingsViaMenu(page);
    await page.locator('#settings-tab-solver-btn').click();
    await expect(page.locator('#solver-reltol')).toHaveValue('');
  });

  test('maxTimeStep field shows the "set by speed" hint when not given', async ({ page }) => {
    await openSettingsViaMenu(page);
    await page.locator('#settings-tab-solver-btn').click();
    const maxstep = page.locator('#solver-maxstep');
    await expect(maxstep).toHaveValue('');
    await expect(maxstep).toHaveAttribute('placeholder', 'set by speed');
  });

  test('bare-canvas context menu opens the Solver tab', async ({ page }) => {
    const canvas = page.locator('#sim-canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    // Right-click an empty corner of the canvas (R1 sits near the top-left).
    await page.mouse.click(box!.x + box!.width - 40, box!.y + box!.height - 40, { button: 'right' });

    const item = page.locator('.ctx-menu-item').filter({ hasText: 'Solver Settings' });
    await expect(item).toBeVisible({ timeout: 3000 });
    await item.click();

    await expect(page.locator('#settings-overlay')).toBeVisible();
    await expect(page.locator('#settings-tab-solver-btn')).toHaveClass(/active/);
    await expect(page.locator('#settings-tab-solver')).toBeVisible();
  });
});

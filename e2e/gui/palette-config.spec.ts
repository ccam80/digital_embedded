/**
 * GUI tests- palette configuration: groups, displayName rendering, the
 * drag-and-drop settings modal, per-component visibility, and localStorage
 * persistence across reload.
 */
import { test, expect } from '@playwright/test';

test.describe('GUI: palette configuration', () => {
  /** Expand a palette group by header label if it is currently collapsed. */
  async function ensureExpanded(page: import('@playwright/test').Page, label: string) {
    const header = page.locator('.palette-category-header', { hasText: label });
    if ((await header.getAttribute('aria-expanded')) !== 'true') {
      await header.click();
    }
  }

  test.beforeEach(async ({ page }) => {
    // Each Playwright test gets an isolated browser context, so localStorage
    // starts empty- no manual clearing needed (and clearing on every
    // navigation would defeat the reload-persistence assertion below).
    await page.goto('/');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
  });

  test('Common Components starts expanded, category groups collapsed', async ({ page }) => {
    const commonHeader = page.locator('.palette-category-header', { hasText: 'Common Components' });
    await expect(commonHeader).toHaveAttribute('aria-expanded', 'true');
    // Expanded Common group shows its component items.
    await expect(page.locator('.palette-category[data-group="common"] .palette-component-item').first()).toBeVisible();

    // A category group (Sources) starts collapsed.
    await expect(page.locator('.palette-category-header', { hasText: 'Sources' })).toHaveAttribute('aria-expanded', 'false');
  });

  test('Common Components group renders displayName while preserving identity', async ({ page }) => {
    const commonHeader = page.locator('.palette-category-header', { hasText: 'Common Components' });
    await expect(commonHeader).toBeVisible();
    await ensureExpanded(page, 'Common Components');

    // Digital Input / Digital Output show their displayName but keep name identity.
    const digitalIn = page.locator('.palette-component-item[data-component="In"]');
    await expect(digitalIn.locator('.palette-component-name')).toHaveText('Digital Input');

    const vSource = page.locator('.palette-component-item[data-component="DcVoltageSource"]');
    await expect(vSource.locator('.palette-component-name')).toHaveText('DC V Source');
  });

  test('settings modal opens with groups, handles, and a reset action', async ({ page }) => {
    await page.locator('.palette-settings-btn').click();

    const dialog = page.locator('.test-dialog', { hasText: 'Palette Components' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.pset-group').first()).toBeVisible();
    await expect(dialog.getByText('Reset to defaults')).toBeVisible();
  });

  test('hiding a component in the modal removes it from the palette', async ({ page }) => {
    await page.locator('.palette-settings-btn').click();
    const dialog = page.locator('.test-dialog', { hasText: 'Palette Components' });

    // Hide "Digital Input" (name "In") within the Common group.
    await dialog.locator('.pset-group[data-group="common"] [data-item="In"] input[type="checkbox"]').uncheck();
    await dialog.getByText('Done').click();

    await ensureExpanded(page, 'Common Components');
    // The Common group no longer offers In, but the I/O group still does.
    const common = page.locator('.palette-category[data-group="common"]');
    await expect(common.locator('.palette-component-item[data-component="In"]')).toHaveCount(0);
  });

  test('palette layout persists across reload', async ({ page }) => {
    // Expanding the (default-collapsed) Sources group writes collapsed:false
    // into the persisted config- a non-default state to prove persistence.
    const sourcesHeader = page.locator('.palette-category-header', { hasText: 'Sources' });
    await expect(sourcesHeader).toHaveAttribute('aria-expanded', 'false');
    await sourcesHeader.click();
    await expect(sourcesHeader).toHaveAttribute('aria-expanded', 'true');

    await page.reload();
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });

    await expect(
      page.locator('.palette-category-header', { hasText: 'Sources' }),
    ).toHaveAttribute('aria-expanded', 'true');
  });
});

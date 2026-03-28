/**
 * E2E tests for the model selector dropdown (W7.3).
 *
 * Verifies that the model dropdown shows human-readable labels for named models
 * and that selecting a model changes the property panel displayed.
 */

import { test, expect } from "@playwright/test";

const BASE = "http://localhost:8080";

test.describe("Model selector dropdown", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(BASE);
    await page.waitForSelector("canvas", { timeout: 5000 });
  });

  test("dual-model component shows Model dropdown with labels", async ({ page }) => {
    // Place an And gate (dual-model: digital + behavioral MNA)
    await page.click('[data-component="And"]');
    await page.click("canvas");

    // Open property popup by clicking on the placed component
    const canvas = page.locator("canvas");
    await canvas.click({ position: { x: 200, y: 200 } });

    // The Model dropdown should be visible with human-readable labels
    const modelSelect = page.locator("select").filter({ hasText: /Digital|Behavioral/ });
    await expect(modelSelect).toBeVisible({ timeout: 3000 });

    // Verify options contain labeled names, not raw keys
    const options = await modelSelect.locator("option").allTextContents();
    expect(options).toContain("Digital");
    expect(options).toContain("Behavioral (MNA)");
  });

  test("single-model component does not show Model dropdown", async ({ page }) => {
    // Place a Resistor (single model: behavioral only)
    await page.click('[data-component="Resistor"]');
    await page.click("canvas");

    const canvas = page.locator("canvas");
    await canvas.click({ position: { x: 200, y: 200 } });

    // No Model dropdown should appear for single-model components
    const modelRow = page.locator("text=Model").locator("xpath=ancestor::div[1]").locator("select");
    await expect(modelRow).toHaveCount(0);
  });

  test("selecting Behavioral model shows SPICE parameter panel", async ({ page }) => {
    // Place a BJT (has deviceType → SPICE panel when in behavioral mode)
    await page.click('[data-component="NpnBJT"]');
    await page.click("canvas");

    const canvas = page.locator("canvas");
    await canvas.click({ position: { x: 200, y: 200 } });

    // Switch to Behavioral if not already selected
    const modelSelect = page.locator("select").filter({ hasText: /Digital|Behavioral/ });
    if (await modelSelect.isVisible()) {
      await modelSelect.selectOption({ label: "Behavioral (MNA)" });
    }

    // SPICE parameter section should appear for semiconductor in behavioral mode
    await expect(page.locator("text=SPICE")).toBeVisible({ timeout: 3000 });
  });
});

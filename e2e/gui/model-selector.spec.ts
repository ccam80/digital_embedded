/**
 * E2E tests for the model selector dropdown.
 *
 * Verifies that the model dropdown shows human-readable labels for named models
 * and that selecting a model changes the property panel displayed.
 *
 * Components use a modelRegistry with 0-N entries. A component with multiple
 * models (e.g. And gate has "behavioral" + implicit "digital") shows a dropdown.
 * A component with an empty modelRegistry (e.g. In port) shows no dropdown.
 */

import { test, expect } from "@playwright/test";
import { UICircuitBuilder } from "../fixtures/ui-circuit-builder";

test.describe("Model selector dropdown", () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
  });

  test("multi-model component shows Model dropdown with labels", async ({ page }) => {
    // And gate has modelRegistry: { behavioral } and models.digital- so two
    // model options appear: "Behavioral (MNA)" and "Digital".
    await builder.placeLabeled("And", 10, 10, "G1");

    const info = await builder.getCircuitInfo();
    const el = info.elements.find(e => e.label === "G1");
    expect(el).toBeTruthy();
    const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
    await page.mouse.dblclick(coords.x, coords.y);

    await expect(page.locator(".prop-popup")).toBeVisible({ timeout: 3000 });

    // The Model dropdown should be visible with human-readable labels
    const popup = page.locator(".prop-popup");
    const modelSelect = popup.locator("select").first();
    await expect(modelSelect).toBeVisible({ timeout: 3000 });

    // Verify options contain labeled names, not raw keys
    const options = await modelSelect.locator("option").allTextContents();
    expect(options).toContain("Digital");
    expect(options).toContain("Behavioral (MNA)");

    await page.keyboard.press("Escape");
  });

  test("component with empty modelRegistry does not show Model dropdown", async ({ page }) => {
    // In port has modelRegistry: {}- so no model dropdown is shown.
    await builder.placeLabeled("In", 10, 10, "I1");

    const info = await builder.getCircuitInfo();
    const el = info.elements.find(e => e.label === "I1");
    expect(el).toBeTruthy();
    const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
    await page.mouse.dblclick(coords.x, coords.y);

    await expect(page.locator(".prop-popup")).toBeVisible({ timeout: 3000 });

    // Verify the property panel opened by confirming the Label row is present
    await expect(page.locator(".prop-popup").getByText("Label")).toBeVisible({ timeout: 3000 });

    // No Model dropdown should appear for components with empty modelRegistry
    const modelSelect = page.locator(".prop-popup").locator("select");
    await expect(modelSelect).toHaveCount(0);

    await page.keyboard.press("Escape");
  });

  test("BJT shows primary model params (IS, BF) directly in popup", async ({ page }) => {
    // NPN BJT has modelRegistry: { behavioral } with defaultModel "behavioral".
    // Primary params BF and IS are rendered inline in the property popup.
    await builder.placeLabeled("NpnBJT", 10, 10, "Q1");

    const info = await builder.getCircuitInfo();
    const el = info.elements.find(e => e.label === "Q1");
    expect(el).toBeTruthy();
    const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
    await page.mouse.dblclick(coords.x, coords.y);

    await expect(page.locator(".prop-popup")).toBeVisible({ timeout: 3000 });

    // Primary params BF and IS should be visible in the popup
    const popup = page.locator(".prop-popup");
    await expect(popup.locator("label").filter({ hasText: /^BF$/ })).toBeVisible({ timeout: 3000 });
    await expect(popup.locator("label").filter({ hasText: /^IS$/ })).toBeVisible({ timeout: 3000 });

    await page.keyboard.press("Escape");
  });
});

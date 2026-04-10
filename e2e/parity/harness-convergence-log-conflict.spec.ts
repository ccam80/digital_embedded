/**
 * W6.T3 — E2E tests for convergence-log panel / harness conflict notification
 * and iterationDetails display (§10.4).
 *
 * PRODUCTION PREREQUISITES (not yet implemented — see spec/progress.md W6.T3):
 *   1. postMessage adapter must handle 'sim-start-comparison-harness' and post
 *      'sim-harness-started' when ready.
 *   2. SimulatorHarness fixture needs startComparisonHarness() method.
 *   3. convergence-log-panel.ts must expose:
 *        data-testid="convergence-log-panel-toggle"
 *        data-testid="convergence-log-disable-button"
 *        data-testid="iteration-details"
 *
 * Until all three preconditions are satisfied, these tests will fail at the
 * startComparisonHarness() call with a timeout waiting for 'sim-harness-started'.
 */

import { test, expect } from "@playwright/test";
import { SimulatorHarness } from "../fixtures/simulator-harness";

test.describe("convergence log panel + harness conflict", () => {
  test("panel toggle while harness active surfaces conflict notification", async ({
    page,
  }) => {
    const harness = new SimulatorHarness(page);
    await harness.load();

    // Load a trivial digital circuit so the simulator is in a known state.
    await harness.loadDigUrl("/circuits/and-gate.dig");

    // Start a comparison harness session via the postMessage API.
    // Requires: postMessage adapter handles 'sim-start-comparison-harness'.
    await harness.postToSim({ type: "sim-start-comparison-harness" });
    await harness.waitForMessage("sim-harness-started", 10_000);

    // Open the convergence log panel.
    // Requires: data-testid="convergence-log-panel-toggle" on the toggle button.
    await page.click("[data-testid='convergence-log-panel-toggle']");

    // Attempt to disable the convergence log via the panel disable button.
    // Requires: data-testid="convergence-log-disable-button" on the button.
    await page.click("[data-testid='convergence-log-disable-button']");

    // Expect the panel to show a conflict notification mentioning the harness.
    // Requires: data-testid="notification" on the inline notification element
    //           rendered by convergence-log-panel.ts showPanelNotification().
    const notification = page.locator("[data-testid='notification']");
    await expect(notification).toContainText(/comparison harness/i);
  });

  test("panel shows iterationDetails for harness-enabled sessions", async ({
    page,
  }) => {
    const harness = new SimulatorHarness(page);
    await harness.load();

    await harness.loadDigUrl("/circuits/and-gate.dig");

    // Start a comparison harness session.
    // Requires: postMessage adapter handles 'sim-start-comparison-harness'.
    await harness.postToSim({ type: "sim-start-comparison-harness" });
    await harness.waitForMessage("sim-harness-started", 10_000);

    // Open the convergence log panel.
    // Requires: data-testid="convergence-log-panel-toggle" on the toggle button.
    await page.click("[data-testid='convergence-log-panel-toggle']");

    // At least one log row must expose iterationDetails.
    // Requires: data-testid="iteration-details" on the details element in each row.
    const detailRow = page.locator("[data-testid='iteration-details']").first();
    await expect(detailRow).toBeVisible();
  });
});

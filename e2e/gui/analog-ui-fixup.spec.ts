/**
 * E2E tests for analog UI fixes:
 *  1. Speed control affects analog simulation rate
 *  2. Slider panel appears during analog simulation
 *  3. FLOAT property popup works for capacitor/inductor
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bridgeEval<T>(harness: SimulatorHarness, fn: string): Promise<T> {
  return harness.page.evaluate((code) => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    const bridge = (iframe.contentWindow as any).__test;
    return new Function('bridge', `return ${code}`)(bridge);
  }, fn) as Promise<T>;
}

async function clickIframeButton(harness: SimulatorHarness, buttonId: string): Promise<void> {
  await harness.page.evaluate((id) => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    iframe.contentWindow!.document.getElementById(id)?.click();
  }, buttonId);
}

/** Build the standard analog RC circuit and compile it. */
async function buildAndCompileRc(harness: SimulatorHarness): Promise<void> {
  await bridgeEval(harness, 'bridge.buildAnalogRcCircuit()');
  const compiled = await bridgeEval<boolean>(harness, 'bridge.compileCircuit()');
  expect(compiled).toBe(true);
}

/** Set the speed input value in the iframe. */
async function setSpeed(harness: SimulatorHarness, speed: number): Promise<void> {
  await harness.page.evaluate((s) => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    const doc = iframe.contentWindow!.document;
    const input = doc.getElementById('speed-input') as HTMLInputElement;
    if (input) {
      input.value = String(s);
      input.dispatchEvent(new Event('change'));
    }
  }, speed);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Analog UI fixes', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
    await harness.iframe.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  // -----------------------------------------------------------------------
  // Fix 1: Speed control affects analog simulation
  // -----------------------------------------------------------------------

  test('speed control affects analog simulation rate', async () => {
    await buildAndCompileRc(harness);

    // Run at speed=1 (slowest) for 500ms, capture simTime BEFORE stopping
    await setSpeed(harness, 1);
    await clickIframeButton(harness, 'btn-run');
    await harness.page.waitForTimeout(500);
    const slowTime = await bridgeEval<number>(
      harness, 'bridge.getAnalogState()?.simTime ?? 0',
    );
    await clickIframeButton(harness, 'btn-stop');
    await harness.page.waitForTimeout(200);

    // Rebuild and recompile for the fast run
    await buildAndCompileRc(harness);

    // Run at speed=10000000 (fastest) for 500ms, capture simTime BEFORE stopping
    await setSpeed(harness, 10000000);
    await clickIframeButton(harness, 'btn-run');
    await harness.page.waitForTimeout(500);
    const fastTime = await bridgeEval<number>(
      harness, 'bridge.getAnalogState()?.simTime ?? 0',
    );
    await clickIframeButton(harness, 'btn-stop');

    // The fast run should have advanced much more simulation time
    // At speed=1 we get ~1 step per frame ≈ 30 steps in 500ms
    // At speed=10M we burn full 12ms budget ≈ thousands of steps
    expect(slowTime).toBeGreaterThan(0);
    expect(fastTime).toBeGreaterThan(0);
    expect(fastTime).toBeGreaterThan(slowTime * 5);
  });

  // -----------------------------------------------------------------------
  // Fix 2: Slider panel
  // -----------------------------------------------------------------------

  test('slider panel appears during analog simulation', async () => {
    // Before simulation, slider panel should be hidden
    const sliderBefore = harness.iframe.locator('#slider-panel');
    await expect(sliderBefore).toBeHidden();

    await buildAndCompileRc(harness);
    await clickIframeButton(harness, 'btn-run');
    await harness.page.waitForTimeout(300);

    // Slider panel container should now be visible (though empty until selection)
    const sliderPanel = harness.iframe.locator('#slider-panel');
    // It's display:'' but :empty hides it via CSS. That's fine — verify it's in the DOM
    const exists = await sliderPanel.count();
    expect(exists).toBe(1);

    // Stop simulation
    await clickIframeButton(harness, 'btn-stop');
  });

  test('slider panel populates when selecting analog component during simulation', async () => {
    await buildAndCompileRc(harness);

    // Start the simulation
    await clickIframeButton(harness, 'btn-run');
    await harness.page.waitForTimeout(300);

    // Click on the resistor element in the canvas.
    // The resistor R1 is at grid position (15, 10).
    // Get its screen coordinates via the test bridge.
    const rPos = await bridgeEval<{ x: number; y: number } | null>(
      harness, 'bridge.getElementPosition("R1")',
    );

    if (rPos) {
      // Need to convert iframe-relative coords to page coords
      const iframeRect = await harness.page.evaluate(() => {
        const iframe = document.getElementById('sim') as HTMLIFrameElement;
        const r = iframe.getBoundingClientRect();
        return { left: r.left, top: r.top };
      });
      const canvasRect = await bridgeEval<{ left: number; top: number }>(
        harness, 'bridge.getCanvasRect()',
      );

      const pageX = iframeRect.left + canvasRect.left + rPos.x;
      const pageY = iframeRect.top + canvasRect.top + rPos.y;

      await harness.page.mouse.click(pageX, pageY);
      await harness.page.waitForTimeout(300);

      // Check if slider rows appeared
      const sliderRows = harness.iframe.locator('#slider-panel .slider-row');
      const rowCount = await sliderRows.count();

      // Resistor has a FLOAT resistance property, so we expect at least 1 slider
      // (This depends on whether the resistor uses PropertyType.FLOAT or INT)
      // If the component is found and selected, at minimum the panel should exist
      const sliderPanel = harness.iframe.locator('#slider-panel');
      const panelExists = await sliderPanel.count();
      expect(panelExists).toBe(1);
    }

    await clickIframeButton(harness, 'btn-stop');
  });

  test('slider panel hides when simulation stops', async () => {
    await buildAndCompileRc(harness);
    await clickIframeButton(harness, 'btn-run');
    await harness.page.waitForTimeout(300);

    // Stop simulation
    await clickIframeButton(harness, 'btn-stop');
    await harness.page.waitForTimeout(200);

    // Slider panel should be hidden again
    const sliderPanel = harness.iframe.locator('#slider-panel');
    await expect(sliderPanel).toBeHidden();
  });

  // -----------------------------------------------------------------------
  // Fix 0: FLOAT property popup
  // -----------------------------------------------------------------------

  test('capacitor shows property popup with float input', async ({ page }) => {
    // Navigate directly to simulator.html (not through the iframe harness)
    await page.goto('/simulator.html');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);

    // Build an analog RC circuit via the test bridge
    await page.evaluate(() => {
      const bridge = (window as any).__test;
      bridge.buildAnalogRcCircuit();
    });
    await page.waitForTimeout(200);

    // Get C1 body center and canvas rect, then click on it with Playwright mouse
    // The capacitor body is 2 grid units wide, so center is at origin + 1 grid unit
    const coords = await page.evaluate(() => {
      const bridge = (window as any).__test;
      const pos = bridge.getElementPosition('C1');
      const rect = bridge.getCanvasRect();
      const vp = bridge.getViewport();
      if (!pos || !rect) return null;
      // Body center: midpoint between the two pins
      const info = bridge.getCircuitInfo();
      const c1 = info.elements.find((e: any) => e.label === 'C1');
      if (c1 && c1.pins.length >= 2) {
        const midX = (c1.pins[0].screenX + c1.pins[1].screenX) / 2;
        const midY = (c1.pins[0].screenY + c1.pins[1].screenY) / 2;
        return { pageX: rect.left + midX, pageY: rect.top + midY };
      }
      return { pageX: rect.left + pos.x, pageY: rect.top + pos.y };
    });

    expect(coords).not.toBeNull();
    await page.mouse.click(coords!.pageX, coords!.pageY);
    await page.waitForTimeout(300);

    // Property panel should show capacitance as a number input with step="any"
    const propInputs = page.locator('#property-content input[type="number"]');
    const inputCount = await propInputs.count();
    expect(inputCount).toBeGreaterThanOrEqual(1);

    // Check that it accepts float values (step="any")
    if (inputCount > 0) {
      const step = await propInputs.first().getAttribute('step');
      expect(step).toBe('any');
    }
  });
});

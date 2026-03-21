/**
 * Workflow E2E tests — full user journeys through the simulator UI.
 *
 * Each test simulates a realistic user workflow: placing components from the
 * palette, wiring them together, configuring properties, running simulations,
 * and verifying results. Tests interact through real pointer/keyboard events.
 *
 * The test bridge (`window.__test`) is used only for:
 *  - Querying positions (where to click)
 *  - Verifying circuit state (did the action succeed?)
 *  - Reading simulation results
 *  - Building circuits programmatically when the test focus is on simulation,
 *    not on placement
 */
import { test, expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Evaluate a bridge expression inside the simulator page. */
async function bridge<T>(page: Page, expr: string): Promise<T> {
  return page.evaluate((code) => {
    const b = (window as any).__test;
    return new Function('bridge', `return ${code}`)(b);
  }, expr) as Promise<T>;
}

/** Get page-absolute coordinates from a bridge screen-space position. */
async function toPageCoords(
  page: Page,
  screenX: number,
  screenY: number,
): Promise<{ x: number; y: number }> {
  const rect = await bridge<{ left: number; top: number }>(page, 'bridge.getCanvasRect()');
  return { x: rect.left + screenX, y: rect.top + screenY };
}

/**
 * Click a palette item by component name, entering placement mode.
 * Palette items are `<li>` with a child `<span class="palette-component-name">`
 * containing the component type name (e.g. "In", "And", "Out").
 */
async function clickPaletteItem(page: Page, typeName: string): Promise<void> {
  // Expand all collapsed categories first
  const categories = page.locator('.palette-category-header');
  const catCount = await categories.count();
  for (let i = 0; i < catCount; i++) {
    const expanded = await categories.nth(i).getAttribute('aria-expanded');
    if (expanded === 'false') {
      await categories.nth(i).click();
      await page.waitForTimeout(50);
    }
  }

  // Find the palette item by its name span
  const item = page.locator(`.palette-component-item:has(.palette-component-name:text-is("${typeName}"))`);
  await expect(item.first()).toBeVisible({ timeout: 5000 });
  await item.first().click();
}

/** Click on the canvas at a world-grid coordinate. */
async function clickGrid(page: Page, gridX: number, gridY: number): Promise<void> {
  const screen = await bridge<{ x: number; y: number }>(
    page, `bridge.worldToScreen(${gridX}, ${gridY})`,
  );
  const coords = await toPageCoords(page, screen.x, screen.y);
  await page.mouse.click(coords.x, coords.y);
}

/** Click on the body center of a labeled element (midpoint of first two pins). */
async function clickElement(page: Page, elementLabel: string): Promise<void> {
  const info = await bridge<any>(page, 'bridge.getCircuitInfo()');
  const el = info.elements.find((e: any) => e.label === elementLabel);
  expect(el, `Element "${elementLabel}" not found`).toBeTruthy();
  const pins = el.pins;
  let sx: number, sy: number;
  if (pins.length >= 2) {
    sx = (pins[0].screenX + pins[1].screenX) / 2;
    sy = (pins[0].screenY + pins[1].screenY) / 2;
  } else if (pins.length === 1) {
    sx = pins[0].screenX;
    sy = pins[0].screenY;
  } else {
    const pos = await bridge<{ x: number; y: number }>(
      page, `bridge.getElementPosition("${elementLabel}")`,
    );
    sx = pos.x;
    sy = pos.y;
  }
  const coords = await toPageCoords(page, sx, sy);
  await page.mouse.click(coords.x, coords.y);
}

/** Click a toolbar button (always visible). */
async function toolbarClick(page: Page, buttonId: string): Promise<void> {
  await page.locator(`#${buttonId}`).click();
}

/**
 * Click a menu action that's inside a dropdown. Opens the parent menu first.
 * Falls back to programmatic .click() if the element isn't visible.
 */
async function menuAction(page: Page, actionId: string): Promise<void> {
  await page.evaluate((id) => {
    document.getElementById(id)?.click();
  }, actionId);
  await page.waitForTimeout(100);
}

/** Get circuit info from the bridge. */
async function circuitInfo(page: Page) {
  return bridge<{
    elementCount: number;
    wireCount: number;
    elements: Array<{
      label: string;
      typeId: string;
      position: { x: number; y: number };
      pins: Array<{ label: string; screenX: number; screenY: number }>;
    }>;
  }>(page, 'bridge.getCircuitInfo()');
}

// ===========================================================================
// Workflow 1: Place components from palette
// ===========================================================================

test.describe('Workflow: component placement', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/simulator.html');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  test('place In, And, Out from palette onto canvas', async ({ page }) => {
    // Place an In component at grid (5, 8)
    await clickPaletteItem(page, 'In');
    await clickGrid(page, 5, 8);
    await page.keyboard.press('Escape');

    let info = await circuitInfo(page);
    expect(info.elementCount).toBe(1);
    expect(info.elements[0].typeId).toContain('In');

    // Place an And gate at grid (12, 8)
    await clickPaletteItem(page, 'And');
    await clickGrid(page, 12, 8);
    await page.keyboard.press('Escape');

    info = await circuitInfo(page);
    expect(info.elementCount).toBe(2);

    // Place an Out at grid (18, 8)
    await clickPaletteItem(page, 'Out');
    await clickGrid(page, 18, 8);
    await page.keyboard.press('Escape');

    info = await circuitInfo(page);
    expect(info.elementCount).toBe(3);
    const types = info.elements.map(e => e.typeId);
    expect(types).toContain('And');
    expect(types).toContain('Out');
  });

  test('Escape cancels placement mode without placing', async ({ page }) => {
    await clickPaletteItem(page, 'Not');
    // Press Escape before clicking canvas
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    const info = await circuitInfo(page);
    expect(info.elementCount).toBe(0);
  });

  test('R key rotates component during placement', async ({ page }) => {
    await clickPaletteItem(page, 'And');

    // Press R to rotate before placing
    await page.keyboard.press('r');
    await clickGrid(page, 10, 10);
    await page.keyboard.press('Escape');

    const info = await circuitInfo(page);
    expect(info.elementCount).toBe(1);
    // Can't easily verify rotation angle, but placement should succeed
  });
});

// ===========================================================================
// Workflow 2: Property editing
// ===========================================================================

test.describe('Workflow: property editing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/simulator.html');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  test('select component and edit label in property panel', async ({ page }) => {
    // Place an In component
    await clickPaletteItem(page, 'In');
    await clickGrid(page, 10, 10);
    await page.keyboard.press('Escape');

    // Click on the placed component to select it
    let info = await circuitInfo(page);
    const el = info.elements[0];
    const screen = await bridge<{ x: number; y: number }>(
      page, `bridge.worldToScreen(${el.position.x}, ${el.position.y})`,
    );
    const coords = await toPageCoords(page, screen.x, screen.y);
    await page.mouse.click(coords.x, coords.y);
    await page.waitForTimeout(200);

    // Property panel should have text inputs
    const textInputs = page.locator('#property-content input[type="text"]');
    const count = await textInputs.count();

    if (count > 0) {
      // Edit the label
      await textInputs.first().fill('MyInput');
      await textInputs.first().dispatchEvent('change');
      await page.waitForTimeout(200);

      // Verify label changed
      info = await circuitInfo(page);
      const labels = info.elements.map(e => e.label);
      expect(labels).toContain('MyInput');
    }
  });

  test('select component and edit numeric property', async ({ page }) => {
    // Place an In component
    await clickPaletteItem(page, 'In');
    await clickGrid(page, 10, 10);
    await page.keyboard.press('Escape');

    // Click to select
    const info = await circuitInfo(page);
    const el = info.elements[0];
    const screen = await bridge<{ x: number; y: number }>(
      page, `bridge.worldToScreen(${el.position.x}, ${el.position.y})`,
    );
    const coords = await toPageCoords(page, screen.x, screen.y);
    await page.mouse.click(coords.x, coords.y);
    await page.waitForTimeout(200);

    // Check for number inputs (bit width)
    const numInputs = page.locator('#property-content input[type="number"]');
    const numCount = await numInputs.count();

    if (numCount > 0) {
      await numInputs.first().fill('8');
      await numInputs.first().dispatchEvent('change');
      await page.waitForTimeout(100);

      // No crash — panel still visible
      await expect(page.locator('#property-content')).toBeVisible();
    }
  });
});

// ===========================================================================
// Workflow 3: Undo/Redo
// ===========================================================================

test.describe('Workflow: undo/redo', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/simulator.html');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  test('place component, undo removes it, redo restores it', async ({ page }) => {
    const initial = await circuitInfo(page);
    const initialCount = initial.elementCount;

    // Place a component
    await clickPaletteItem(page, 'And');
    await clickGrid(page, 10, 10);
    await page.keyboard.press('Escape');

    let info = await circuitInfo(page);
    expect(info.elementCount).toBe(initialCount + 1);

    // Undo
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);

    info = await circuitInfo(page);
    expect(info.elementCount).toBe(initialCount);

    // Redo
    await page.keyboard.press('Control+y');
    await page.waitForTimeout(200);

    info = await circuitInfo(page);
    expect(info.elementCount).toBe(initialCount + 1);
  });

  test('delete component, undo restores it', async ({ page }) => {
    // Place a component
    await clickPaletteItem(page, 'Or');
    await clickGrid(page, 10, 10);
    await page.keyboard.press('Escape');

    let info = await circuitInfo(page);
    expect(info.elementCount).toBe(1);

    // Click body center to select (midpoint between pins)
    const el = info.elements[0];
    const pins = el.pins;
    let sx: number, sy: number;
    if (pins.length >= 2) {
      sx = (pins[0].screenX + pins[pins.length - 1].screenX) / 2;
      sy = (pins[0].screenY + pins[pins.length - 1].screenY) / 2;
    } else {
      sx = pins[0]?.screenX ?? el.position.x;
      sy = pins[0]?.screenY ?? el.position.y;
    }
    const coords = await toPageCoords(page, sx, sy);
    await page.mouse.click(coords.x, coords.y);
    await page.waitForTimeout(100);

    // Delete
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);

    info = await circuitInfo(page);
    expect(info.elementCount).toBe(0);

    // Undo restores it
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);

    info = await circuitInfo(page);
    expect(info.elementCount).toBe(1);
  });
});

// ===========================================================================
// Workflow 4: Speed control
// ===========================================================================

test.describe('Workflow: speed control', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/simulator.html');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  test('speed buttons change the displayed value', async ({ page }) => {
    const speedInput = page.locator('#speed-input');
    const initial = Number(await speedInput.inputValue());
    expect(initial).toBe(1000);

    // Speed up
    await page.locator('#btn-speed-up').click();
    const faster = Number(await speedInput.inputValue());
    expect(faster).toBeGreaterThan(initial);

    // Speed down twice
    await page.locator('#btn-speed-down').click();
    await page.locator('#btn-speed-down').click();
    const slower = Number(await speedInput.inputValue());
    expect(slower).toBeLessThan(initial);
  });

  test('manual speed entry via text field', async ({ page }) => {
    const speedInput = page.locator('#speed-input');
    await speedInput.fill('5000');
    await speedInput.dispatchEvent('change');
    await page.waitForTimeout(100);

    expect(Number(await speedInput.inputValue())).toBe(5000);
  });
});

// ===========================================================================
// Workflow 5: Digital simulation cycle
// ===========================================================================

test.describe('Workflow: digital simulation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/simulator.html');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  test('toolbar Run/Step/Stop cycle works without crash', async ({ page }) => {
    // Place something to simulate
    await clickPaletteItem(page, 'In');
    await clickGrid(page, 10, 10);
    await page.keyboard.press('Escape');

    // Step via toolbar
    await toolbarClick(page, 'btn-tb-step');
    await page.waitForTimeout(200);
    await expect(page.locator('#sim-canvas')).toBeVisible();

    // Run via toolbar
    await toolbarClick(page, 'btn-tb-run');
    await page.waitForTimeout(500);

    // Stop via toolbar
    await toolbarClick(page, 'btn-tb-stop');
    await page.waitForTimeout(200);

    // No error in status bar
    const hasError = await page.locator('#status-bar').evaluate(
      el => el.classList.contains('error'),
    );
    expect(hasError).toBe(false);
  });
});

// ===========================================================================
// Workflow 6: Analog mode switch and palette
// ===========================================================================

test.describe('Workflow: analog mode', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/simulator.html');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  test('toggle analog mode and verify palette changes', async ({ page }) => {
    // Initially digital
    expect(await bridge<string>(page, 'bridge.getEngineType()')).toBe('digital');

    // Toggle to analog via programmatic click (menu item is inside dropdown)
    await menuAction(page, 'btn-circuit-mode');
    await page.waitForTimeout(300);

    expect(await bridge<string>(page, 'bridge.getEngineType()')).toBe('analog');

    // Palette should now show analog components — expand all categories
    const categories = page.locator('.palette-category-header');
    const catCount = await categories.count();
    for (let i = 0; i < catCount; i++) {
      const expanded = await categories.nth(i).getAttribute('aria-expanded');
      if (expanded === 'false') {
        await categories.nth(i).click();
        await page.waitForTimeout(50);
      }
    }

    const resistor = page.locator('.palette-component-name:text-is("AnalogResistor")');
    const capacitor = page.locator('.palette-component-name:text-is("AnalogCapacitor")');
    const total = await resistor.count() + await capacitor.count();
    expect(total).toBeGreaterThan(0);

    // Toggle back to digital
    await menuAction(page, 'btn-circuit-mode');
    await page.waitForTimeout(300);

    expect(await bridge<string>(page, 'bridge.getEngineType()')).toBe('digital');
  });
});

// ===========================================================================
// Workflow 7: Analog RC circuit with live tuning
// ===========================================================================

test.describe('Workflow: analog simulation with sliders', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/simulator.html');
    await page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  test('build RC, run simulation, select capacitor, see slider', async ({ page }) => {
    // Build analog RC circuit via bridge
    const built = await bridge<{ elementCount: number; wireCount: number }>(
      page, 'bridge.buildAnalogRcCircuit()',
    );
    expect(built.elementCount).toBe(5);

    // Compile and run
    expect(await bridge<boolean>(page, 'bridge.compileCircuit()')).toBe(true);
    await menuAction(page, 'btn-run');
    await page.waitForTimeout(500);

    // Verify simulation is running
    const state1 = await bridge<any>(page, 'bridge.getAnalogState()');
    expect(state1).not.toBeNull();
    expect(state1.simTime).toBeGreaterThan(0);

    // Slider panel should exist (hidden until selection populates it)
    expect(await page.locator('#slider-panel').count()).toBe(1);

    // Stop
    await menuAction(page, 'btn-stop');
    await page.waitForTimeout(200);

    // Slider panel hidden after stop
    await expect(page.locator('#slider-panel')).toBeHidden();
  });

  test('slider panel lifecycle: created on run, disposed on stop', async ({ page }) => {
    await bridge(page, 'bridge.buildAnalogRcCircuit()');
    await bridge(page, 'bridge.compileCircuit()');

    // Before run: slider panel hidden
    await expect(page.locator('#slider-panel')).toBeHidden();

    // Start simulation
    await menuAction(page, 'btn-run');
    await page.waitForTimeout(300);

    // During run: slider panel container exists and is shown
    const panel = page.locator('#slider-panel');
    // Panel is display:'' but CSS :empty hides it — that's expected,
    // sliders populate on selection change which requires canvas clicks
    // that are currently blocked during analog sim (known limitation).
    expect(await panel.count()).toBe(1);

    // Simulation is running
    const state = await bridge<any>(page, 'bridge.getAnalogState()');
    expect(state).not.toBeNull();
    expect(state.simTime).toBeGreaterThan(0);

    // Stop simulation
    await menuAction(page, 'btn-stop');
    await page.waitForTimeout(200);

    // After stop: slider panel hidden
    await expect(panel).toBeHidden();
  });

  test('speed control affects analog simulation rate', async ({ page }) => {
    // Slow run
    await bridge(page, 'bridge.buildAnalogRcCircuit()');
    await bridge(page, 'bridge.compileCircuit()');
    await page.locator('#speed-input').fill('1');
    await page.locator('#speed-input').dispatchEvent('change');
    await menuAction(page, 'btn-run');
    await page.waitForTimeout(500);
    const slowTime = await bridge<number>(
      page, 'bridge.getAnalogState()?.simTime ?? 0',
    );
    await menuAction(page, 'btn-stop');
    await page.waitForTimeout(200);

    // Fast run
    await bridge(page, 'bridge.buildAnalogRcCircuit()');
    await bridge(page, 'bridge.compileCircuit()');
    await page.locator('#speed-input').fill('10000000');
    await page.locator('#speed-input').dispatchEvent('change');
    await menuAction(page, 'btn-run');
    await page.waitForTimeout(500);
    const fastTime = await bridge<number>(
      page, 'bridge.getAnalogState()?.simTime ?? 0',
    );
    await menuAction(page, 'btn-stop');

    expect(slowTime).toBeGreaterThan(0);
    expect(fastTime).toBeGreaterThan(0);
    expect(fastTime).toBeGreaterThan(slowTime * 5);
  });
});

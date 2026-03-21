/**
 * UICircuitBuilder — Playwright helper for building circuits through genuine
 * UI interactions (palette clicks, canvas placement, wire drawing, toolbar actions).
 *
 * RULES:
 * - All circuit mutations use real mouse/keyboard events via Playwright
 * - The test bridge (`window.__test`) is used ONLY for:
 *     - Coordinate queries (worldToScreen, getPinPosition, getCanvasRect)
 *     - Circuit state reads (getCircuitInfo, getAnalogState, getEngineType)
 *   It is NEVER used to mutate circuit state.
 * - No `page.evaluate(() => button.click())` — use Playwright locators/mouse
 * - No conditional fallbacks that silently pass on failure
 */
import { expect, type Page } from '@playwright/test';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CircuitInfo {
  elementCount: number;
  wireCount: number;
  elements: Array<{
    label: string;
    typeId: string;
    position: { x: number; y: number };
    center: { screenX: number; screenY: number };
    pins: Array<{ label: string; screenX: number; screenY: number }>;
  }>;
}

export interface PinPosition {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// UICircuitBuilder
// ---------------------------------------------------------------------------

export class UICircuitBuilder {
  constructor(readonly page: Page) {}

  // =========================================================================
  // Setup
  // =========================================================================

  /** Navigate to simulator.html and wait for canvas + test bridge. */
  async load(): Promise<void> {
    await this.page.goto('/simulator.html');
    await this.page.locator('#sim-canvas').waitFor({ state: 'visible' });
    await this.page.waitForFunction(
      () => (window as any).__test !== undefined,
      { timeout: 10_000 },
    );
  }

  // =========================================================================
  // Bridge queries (read-only)
  // =========================================================================

  /** Evaluate a read-only expression on the test bridge. */
  private async bridge<T>(expr: string): Promise<T> {
    return this.page.evaluate((code) => {
      const b = (window as any).__test;
      return new Function('bridge', `return ${code}`)(b);
    }, expr) as Promise<T>;
  }

  /** Get canvas bounding rect for coordinate conversion. */
  private async getCanvasRect(): Promise<{ left: number; top: number; width: number; height: number }> {
    return this.bridge('bridge.getCanvasRect()');
  }

  /** Convert bridge screen-space coords to page-absolute coords for Playwright. */
  async toPageCoords(screenX: number, screenY: number): Promise<{ x: number; y: number }> {
    const rect = await this.getCanvasRect();
    return { x: rect.left + screenX, y: rect.top + screenY };
  }

  /** Get current circuit info from the bridge. */
  async getCircuitInfo(): Promise<CircuitInfo> {
    return this.bridge('bridge.getCircuitInfo()');
  }

  /** Get current engine type from circuit metadata. */
  async getEngineType(): Promise<string> {
    return this.bridge('bridge.getEngineType()');
  }

  /** Get analog engine state (null if no analog engine active). */
  async getAnalogState(): Promise<{
    simTime: number;
    nodeVoltages: Record<string, number>;
    nodeCount: number;
  } | null> {
    return this.bridge('bridge.getAnalogState()');
  }

  /**
   * Get screen position of a pin on a labeled element.
   * Returns page-absolute coordinates ready for Playwright mouse actions.
   */
  async getPinPagePosition(elementLabel: string, pinLabel: string): Promise<{ x: number; y: number }> {
    const pos = await this.bridge<PinPosition | null>(
      `bridge.getPinPosition("${elementLabel}", "${pinLabel}")`,
    );
    expect(pos, `Pin "${pinLabel}" on element "${elementLabel}" not found`).not.toBeNull();
    return this.toPageCoords(pos!.x, pos!.y);
  }

  /**
   * Get screen position of a grid coordinate.
   * Returns page-absolute coordinates ready for Playwright mouse actions.
   */
  async getGridPagePosition(gridX: number, gridY: number): Promise<{ x: number; y: number }> {
    const screen = await this.bridge<PinPosition>(
      `bridge.worldToScreen(${gridX}, ${gridY})`,
    );
    return this.toPageCoords(screen.x, screen.y);
  }

  // =========================================================================
  // Component placement
  // =========================================================================

  /**
   * Place a component from the palette onto the canvas at a grid position.
   *
   * Uses the palette search box to find the component by name (like a user
   * would), clicks it, then clicks the canvas at the given grid coordinates.
   * Presses Escape to exit placement mode.
   */
  async placeComponent(typeName: string, gridX: number, gridY: number): Promise<void> {
    await this._clickPaletteItem(typeName);
    const coords = await this.getGridPagePosition(gridX, gridY);
    await this.page.mouse.click(coords.x, coords.y);
    await this.page.keyboard.press('Escape');
  }

  /**
   * Place a component and set its label via the double-click property popup.
   *
   * After placement, finds the newly added element via the bridge,
   * double-clicks its body to open the property popup, sets the label,
   * then closes the popup with Escape.
   */
  async placeLabeled(
    typeName: string,
    gridX: number,
    gridY: number,
    label: string,
  ): Promise<void> {
    const before = await this.getCircuitInfo();
    const beforeCount = before.elementCount;

    await this.placeComponent(typeName, gridX, gridY);

    // Find the newly placed element
    const after = await this.getCircuitInfo();
    expect(after.elementCount).toBe(beforeCount + 1);
    const newEl = after.elements[after.elements.length - 1];

    // Double-click body center to open property popup
    await this._dblClickElementBody(newEl);

    // Set the label in the popup, then close it
    await this._setPopupProperty('Label', label);
    await this.page.keyboard.press('Escape');
  }

  // =========================================================================
  // Property editing (via double-click popup)
  // =========================================================================

  /**
   * Open the property popup for a labeled component and set a property.
   * Double-clicks the component body, sets the value, closes the popup.
   */
  async setComponentProperty(
    elementLabel: string,
    propLabel: string,
    value: string | number,
  ): Promise<void> {
    const info = await this.getCircuitInfo();
    const el = info.elements.find(e => e.label === elementLabel);
    expect(el, `Element "${elementLabel}" not found`).toBeTruthy();

    await this._dblClickElementBody(el!);
    await this._setPopupProperty(propLabel, value);
    await this.page.keyboard.press('Escape');
  }

  /**
   * Open the property popup for an element found by type and index.
   * Useful for components like Tunnel that have no label.
   */
  async setPropertyByTypeIndex(
    typeId: string,
    index: number,
    propLabel: string,
    value: string | number,
  ): Promise<void> {
    const info = await this.getCircuitInfo();
    const matches = info.elements.filter(e => e.typeId === typeId);
    expect(matches.length).toBeGreaterThan(index);

    await this._dblClickElementBody(matches[index]);
    await this._setPopupProperty(propLabel, value);
    await this.page.keyboard.press('Escape');
  }

  /**
   * Select a placed component by clicking on its bounding-box center.
   */
  async selectElement(elementLabel: string): Promise<void> {
    const info = await this.getCircuitInfo();
    const el = info.elements.find(e => e.label === elementLabel);
    expect(el, `Element "${elementLabel}" not found in circuit`).toBeTruthy();
    await this._clickElementBody(el!);
  }

  // =========================================================================
  // Wire drawing
  // =========================================================================

  /**
   * Draw a wire between two pins identified by element label and pin label.
   *
   * Uses the bridge to query pin positions (read-only), then performs real
   * mouse clicks at those positions to trigger wire-drawing mode.
   */
  async drawWire(
    fromLabel: string,
    fromPin: string,
    toLabel: string,
    toPin: string,
  ): Promise<void> {
    const from = await this.getPinPagePosition(fromLabel, fromPin);
    const to = await this.getPinPagePosition(toLabel, toPin);

    await this.page.mouse.click(from.x, from.y);
    await this.page.mouse.click(to.x, to.y);
  }

  /**
   * Draw a wire between two page-absolute coordinates.
   * Useful when pin positions are already known (e.g. from circuit info).
   */
  async drawWireBetweenPoints(
    from: { x: number; y: number },
    to: { x: number; y: number },
  ): Promise<void> {
    await this.page.mouse.click(from.x, from.y);
    await this.page.mouse.click(to.x, to.y);
  }

  /**
   * Draw a wire between two grid coordinates.
   */
  async drawWireByGrid(
    fromGridX: number,
    fromGridY: number,
    toGridX: number,
    toGridY: number,
  ): Promise<void> {
    const from = await this.getGridPagePosition(fromGridX, fromGridY);
    const to = await this.getGridPagePosition(toGridX, toGridY);

    await this.page.mouse.click(from.x, from.y);
    await this.page.mouse.click(to.x, to.y);
  }

  /**
   * Get page-absolute coordinates for a pin on an element found by type and index.
   * Useful for components like Tunnel that have no label.
   */
  async getPinPagePositionByTypeIndex(
    typeId: string,
    index: number,
    pinLabel: string,
  ): Promise<{ x: number; y: number }> {
    const info = await this.getCircuitInfo();
    const matches = info.elements.filter(e => e.typeId === typeId);
    expect(matches.length, `No elements of type "${typeId}" found`).toBeGreaterThan(index);
    const pin = matches[index].pins.find(p => p.label === pinLabel);
    expect(pin, `Pin "${pinLabel}" not found on ${typeId}[${index}]`).toBeTruthy();
    return this.toPageCoords(pin!.screenX, pin!.screenY);
  }

  // =========================================================================
  // Simulation controls
  // =========================================================================

  /** Click the Step button on the toolbar. */
  async stepViaUI(count = 1): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this.page.locator('#btn-tb-step').click();
    }
  }

  /** Click the Run button on the toolbar. */
  async runViaUI(): Promise<void> {
    await this.page.locator('#btn-tb-run').click();
  }

  /** Click the Stop button on the toolbar. */
  async stopViaUI(): Promise<void> {
    await this.page.locator('#btn-tb-stop').click();
  }

  /** Switch between digital and analog engine modes via the toolbar button. */
  async switchEngineMode(): Promise<void> {
    await this.page.locator('#btn-circuit-mode').click();
  }

  /** Set the simulation speed via the speed input field. */
  async setSpeed(stepsPerSec: number): Promise<void> {
    const speedInput = this.page.locator('#speed-input');
    await speedInput.fill(String(stepsPerSec));
    await speedInput.press('Tab'); // triggers change event naturally
  }

  // =========================================================================
  // Verification helpers
  // =========================================================================

  /** Assert no error is shown in the status bar. */
  async verifyNoErrors(): Promise<void> {
    const hasError = await this.page.locator('#status-bar').evaluate(
      el => el.classList.contains('error'),
    );
    expect(hasError, 'Status bar shows an error').toBe(false);
  }

  /**
   * Run test vectors against the current circuit using the postMessage API.
   *
   * Posts `digital-test` to self — the PostMessageAdapter's handler fires
   * on the live facade, which is the same code path as iframe embedding.
   * Also handles `digital-error` responses to fail fast instead of timing out.
   */
  async runTestVectors(testData: string): Promise<{
    passed: number;
    failed: number;
    total: number;
    details: Array<{
      passed: boolean;
      inputs: Record<string, number>;
      expected: Record<string, number>;
      actual: Record<string, number>;
    }>;
  }> {
    return this.page.evaluate((td) => {
      return new Promise((resolve, reject) => {
        const handler = (e: MessageEvent) => {
          if (e.data?.type === 'digital-test-result') {
            window.removeEventListener('message', handler);
            resolve(e.data);
          } else if (e.data?.type === 'digital-error') {
            window.removeEventListener('message', handler);
            reject(new Error(`Circuit error: ${e.data.error}`));
          }
        };
        window.addEventListener('message', handler);
        window.postMessage({ type: 'digital-test', testData: td }, '*');
      });
    }, testData) as any;
  }

  // =========================================================================
  // Keyboard shortcuts
  // =========================================================================

  /** Undo via keyboard. */
  async undo(): Promise<void> {
    await this.page.keyboard.press('Control+z');
  }

  /** Redo via keyboard. */
  async redo(): Promise<void> {
    await this.page.keyboard.press('Control+y');
  }

  /** Delete selected elements via keyboard. */
  async deleteSelection(): Promise<void> {
    await this.page.keyboard.press('Delete');
  }

  /** Select all via keyboard. */
  async selectAll(): Promise<void> {
    await this.page.keyboard.press('Control+a');
  }

  /** Rotate during placement via keyboard. */
  async rotate(): Promise<void> {
    await this.page.keyboard.press('r');
  }

  // =========================================================================
  // Low-level helpers
  // =========================================================================

  /** Click on the canvas at a world-grid coordinate. */
  async clickGrid(gridX: number, gridY: number): Promise<void> {
    const coords = await this.getGridPagePosition(gridX, gridY);
    await this.page.mouse.click(coords.x, coords.y);
  }

  // =========================================================================
  // Private helpers
  // =========================================================================

  /** Double-click the body center of an element to open its property popup. */
  private async _dblClickElementBody(el: CircuitInfo['elements'][0]): Promise<void> {
    const coords = await this._elementBodyPageCoords(el);
    await this.page.mouse.dblclick(coords.x, coords.y);
  }

  /** Get page-absolute coordinates for the bounding-box center of an element. */
  private async _elementBodyPageCoords(el: CircuitInfo['elements'][0]): Promise<{ x: number; y: number }> {
    return this.toPageCoords(el.center.screenX, el.center.screenY);
  }

  /** Click the body center of an element. */
  private async _clickElementBody(el: CircuitInfo['elements'][0]): Promise<void> {
    const coords = await this._elementBodyPageCoords(el);
    await this.page.mouse.click(coords.x, coords.y);
  }

  /**
   * Set a property in the currently open prop-popup by matching the label text.
   * The popup must already be open (via double-click on a component).
   * Uses Tab to commit the value (triggers the change event naturally via blur).
   */
  private async _setPopupProperty(propLabel: string, value: string | number): Promise<void> {
    const popup = this.page.locator('.prop-popup');
    await expect(popup).toBeVisible({ timeout: 3000 });

    const row = popup.locator(`.prop-row:has(.prop-label:text-is("${propLabel}"))`);
    const input = row.locator('input, select').first();
    await expect(input).toBeVisible({ timeout: 2000 });

    const tagName = await input.evaluate(el => el.tagName.toLowerCase());
    if (tagName === 'select') {
      await input.selectOption(String(value));
    } else {
      await input.fill(String(value));
      await input.press('Tab'); // triggers change event via blur
    }
  }

  /**
   * Find and click a palette item by name using the search box.
   * Types the name into the search input, waits for the filtered result,
   * clicks it, then clears the search to restore the full palette.
   */
  private async _clickPaletteItem(typeName: string): Promise<void> {
    const searchInput = this.page.locator('.palette-search-input');
    await searchInput.fill(typeName);

    const item = this.page.locator(
      `.palette-component-item:has(.palette-component-name:text-is("${typeName}"))`,
    );
    await expect(
      item.first(),
      `Palette item "${typeName}" not found — is the correct engine mode set?`,
    ).toBeVisible({ timeout: 5000 });
    await item.first().click();

    // Clear search to restore full palette for subsequent placements
    await searchInput.fill('');
    await searchInput.dispatchEvent('input');
  }
}

/**
 * UICircuitBuilder — Playwright helper for building circuits through genuine
 * UI interactions (palette clicks, canvas placement, wire drawing, toolbar actions).
 *
 * RULES:
 * - All circuit mutations use real mouse/keyboard events via Playwright
 * - The test bridge (`window.__test`) is used ONLY for:
 *     - Coordinate queries (worldToScreen, getPinPosition, getCanvasRect)
 *     - Circuit state reads (getCircuitInfo, getAnalogState, getCircuitDomain)
 *   It is NEVER used to mutate circuit state.
 * - No `page.evaluate(() => button.click())` — use Playwright locators/mouse
 * - No conditional fallbacks that silently pass on failure
 *
 * Wire routing rules (enforced by drawWire):
 *   1. Step out from every pin in its exit direction >= 1 grid unit before branching
 *   2. No two wires in the same direction on the same grid column/row — extend stubs if occupied
 *   3. No 180-degree vertices; only 90-degree turns with >= 1 grid unit between vertices
 *   4. Wires must not cross component bounding boxes — route around them
 *   5. No intermediate vertex may land on an existing wire or unrelated pin
 *   6. No new wire segment may overlap collinearly with an existing wire
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

type Pt = { x: number; y: number };
type Dir = { dx: number; dy: number };
type Box = { x: number; y: number; w: number; h: number };
type WireSeg = { x1: number; y1: number; x2: number; y2: number };

// ---------------------------------------------------------------------------
// UICircuitBuilder
// ---------------------------------------------------------------------------

export class UICircuitBuilder {
  /**
   * Routing obstacles fetched from the live circuit at the start of each
   * drawWire call. All routing helpers read from this field.
   */
  private _obs: { wires: WireSeg[]; pins: Pt[] } = { wires: [], pins: [] };

  /**
   * The source and destination pin positions for the current drawWire call.
   * Points at these positions are excluded from pin-collision checks (the
   * wire intentionally starts/ends there).
   */
  private _endpointPins: Pt[] = [];

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

  /** No-op — kept for backward compatibility with existing tests. */
  resetWireState(): void { /* obstacles are fetched live from the bridge */ }

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

  /** Get circuit domain derived from circuit component models ('analog' | 'digital'). */
  async getCircuitDomain(): Promise<string> {
    return this.bridge('bridge.getCircuitDomain()');
  }

  /**
   * Describe a component type from the registry.
   * Returns null if the type is not registered.
   */
  async describeComponent(typeName: string): Promise<{
    pinLayout: Array<{ label: string; direction: 'INPUT' | 'OUTPUT' | 'BIDIRECTIONAL'; defaultBitWidth: number }>;
    propertyDefs: Array<{ key: string; label: string; type: string; defaultValue: string | number | boolean; min?: number; max?: number }>;
  } | null> {
    return this.bridge(`bridge.describeComponent("${typeName}")`);
  }

  /**
   * Resolve an internal property key (e.g. 'bitWidth') to its display label
   * (e.g. 'Bits') as shown in the property popup. Returns the key itself if
   * no matching definition is found.
   */
  async resolvePropertyLabel(typeName: string, propKey: string): Promise<string> {
    const desc = await this.describeComponent(typeName);
    if (!desc) return propKey;
    const def = desc.propertyDefs.find(pd => pd.key === propKey);
    return def ? def.label : propKey;
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
   * Read a single labeled output's numeric value. Works for both digital
   * (returns bit-vector as number) and analog (returns voltage) domains.
   * Returns null if the label is not found or simulation hasn't been compiled.
   */
  async readOutput(label: string): Promise<number | null> {
    const sv = await this.bridge<{ type: string; value?: number; voltage?: number } | null>(
      `bridge.readSignalByLabel("${label}")`,
    );
    if (!sv) return null;
    return sv.type === 'digital' ? sv.value! : sv.voltage!;
  }

  /**
   * Read all labeled signals as a flat record of label → numeric value.
   * Digital signals return their bit-vector as a number, analog signals
   * return their voltage. Works regardless of circuit domain (digital,
   * analog, or mixed). Returns null if simulation hasn't been compiled.
   */
  async readAllSignals(): Promise<Record<string, number> | null> {
    const all = await this.bridge<Record<string, { type: string; value?: number; voltage?: number }> | null>(
      'bridge.readAllSignalValues()',
    );
    if (!all) return null;
    const result: Record<string, number> = {};
    for (const [label, sv] of Object.entries(all)) {
      result[label] = sv.type === 'digital' ? sv.value! : sv.voltage!;
    }
    return result;
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
    await this.page.waitForFunction(
      () => !!(window as any).__test?.isPlacementActive?.(),
      { timeout: 5000 },
    );
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

    // Close popup explicitly via the close button to trigger any pending
    // property change commits (blur/change events) before continuing.
    const popup = this.page.locator('.prop-popup');
    if (await popup.isVisible().catch(() => false)) {
      await popup.locator('.prop-popup-close').click();
      await popup.waitFor({ state: 'hidden', timeout: 2000 });
    }
  }

  /**
   * Set a SPICE model parameter for a semiconductor component through the UI.
   *
   * Opens the property popup, finds the parameter row by its label element
   * (e.g. "VTO", "KP", "IS", "BF"), fills the value, and commits via Tab.
   * Primary params (IS, BF) are visible directly; secondary params (VAF, NF,
   * etc.) are under "▶ Advanced Parameters" which is expanded automatically.
   */
  async setSpiceParameter(
    elementLabel: string,
    paramKey: string,
    value: string | number,
  ): Promise<void> {
    const info = await this.getCircuitInfo();
    const el = info.elements.find(e => e.label === elementLabel);
    expect(el, `Element "${elementLabel}" not found`).toBeTruthy();

    await this._dblClickElementBody(el!);

    const popup = this.page.locator('.prop-popup');
    await expect(popup).toBeVisible({ timeout: 3000 });

    // Primary model params are rendered directly in prop-row elements.
    // Secondary params are under "▶ Advanced Parameters" — expand if needed.
    let keyLabel = popup.locator(`label`).filter({ hasText: new RegExp(`^${paramKey}$`) });
    const isVisible = await keyLabel.first().isVisible().catch(() => false);
    if (!isVisible) {
      const advToggle = popup.getByText('▶ Advanced Parameters');
      if (await advToggle.isVisible().catch(() => false)) {
        await advToggle.click();
        await popup.getByText('▼ Advanced Parameters').waitFor({ state: 'visible', timeout: 1000 });
      }
      keyLabel = popup.locator(`label`).filter({ hasText: new RegExp(`^${paramKey}$`) });
    }
    await expect(keyLabel.first(), `SPICE parameter "${paramKey}" label not found in popup`).toBeVisible({ timeout: 2000 });

    const row = keyLabel.first().locator('..');
    const input = row.locator('input').first();
    await expect(input).toBeVisible({ timeout: 2000 });
    await input.fill(String(value));
    await input.press('Tab');  // triggers blur → commit

    // Close popup via button to trigger any pending change commits.
    await popup.locator('.prop-popup-close').click();
    await popup.waitFor({ state: 'hidden', timeout: 2000 });
  }

  /**
   * Set a Pin Electrical parameter for a component through the UI.
   *
   * Opens the property popup, expands the "Pin Electrical" collapsible section,
   * finds the input row by its field label (e.g. "Rout", "Rin", "Cin"),
   * fills the value, and commits via Tab.
   */
  async setPinElectricalParam(
    elementLabel: string,
    fieldLabel: string,
    value: string | number,
  ): Promise<void> {
    const info = await this.getCircuitInfo();
    const el = info.elements.find(e => e.label === elementLabel);
    expect(el, `Element "${elementLabel}" not found`).toBeTruthy();

    await this._dblClickElementBody(el!);

    const popup = this.page.locator('.prop-popup');
    await expect(popup).toBeVisible({ timeout: 3000 });

    // Expand the "Pin Electrical" section if it is collapsed.
    const pinElecToggle = popup.getByText('▶ Pin Electrical');
    if (await pinElecToggle.isVisible().catch(() => false)) {
      await pinElecToggle.click();
      await popup.getByText('▼ Pin Electrical').waitFor({ state: 'visible', timeout: 1000 });
    }

    const input = popup
      .locator('div')
      .filter({ has: this.page.locator(`span:text-is("${fieldLabel}")`) })
      .locator('input')
      .first();
    await expect(input, `Pin Electrical field "${fieldLabel}" not found in popup`).toBeVisible({ timeout: 2000 });
    await input.fill(String(value));
    await input.press('Tab');  // triggers blur → commit

    // Close popup via button to trigger any pending change commits.
    await popup.locator('.prop-popup-close').click();
    await popup.waitFor({ state: 'hidden', timeout: 2000 });
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
   * Routing rules enforced:
   *   1. Steps out from each pin in its exit direction (away from component
   *      body) for at least 1 grid unit before any turn.
   *   2. If the branching column/row is already occupied by a wire going the
   *      same direction, extends the stub to 2+ grid units and retries.
   *   3. Only 90-degree turns; at least 1 grid unit between adjacent vertices.
   *   4. Wire segments never cross component bounding boxes.
   *   5. No intermediate vertex lands on an existing wire or unrelated pin.
   *   6. No segment overlaps collinearly with an existing wire.
   *
   * Each waypoint is a real mouse click — the same sequence a user would
   * perform. Consecutive click points are always collinear so the wire
   * drawing mode's Manhattan router produces the exact intended path.
   */
  async drawWire(
    fromLabel: string,
    fromPin: string,
    toLabel: string,
    toPin: string,
  ): Promise<void> {
    // Gather pin screen positions
    const fromScreen = await this.bridge<PinPosition>(
      `bridge.getPinPosition("${fromLabel}", "${fromPin}")`,
    );
    const toScreen = await this.bridge<PinPosition>(
      `bridge.getPinPosition("${toLabel}", "${toPin}")`,
    );
    expect(fromScreen, `Pin "${fromPin}" on "${fromLabel}" not found`).not.toBeNull();
    expect(toScreen, `Pin "${toPin}" on "${toLabel}" not found`).not.toBeNull();

    // Convert to grid coords and fetch routing metadata
    const fromGrid = await this.bridge<PinPosition>(
      `bridge.screenToWorld(${fromScreen.x}, ${fromScreen.y})`,
    );
    const toGrid = await this.bridge<PinPosition>(
      `bridge.screenToWorld(${toScreen.x}, ${toScreen.y})`,
    );
    const fromDir = await this.bridge<Dir | null>(
      `bridge.getPinExitDirection("${fromLabel}", "${fromPin}")`,
    );
    const toDir = await this.bridge<Dir | null>(
      `bridge.getPinExitDirection("${toLabel}", "${toPin}")`,
    );
    const boxes = await this.bridge<Box[]>('bridge.getElementBoundingBoxes()');

    // Fetch live circuit obstacles (existing wires + all pin positions)
    this._obs = await this.bridge<{ wires: WireSeg[]; pins: Pt[] }>(
      'bridge.getRoutingObstacles()',
    );
    this._endpointPins = [fromGrid, toGrid];

    const fd: Dir = fromDir ?? { dx: 1, dy: 0 };
    const td: Dir = toDir ?? { dx: -1, dy: 0 };

    // Compute collision-free routed path
    const path = this._computeWirePath(fromGrid, toGrid, fd, td, boxes);

    // Execute clicks at each waypoint
    for (const gridPt of path) {
      const pageCoords = await this.getGridPagePosition(gridPt.x, gridPt.y);
      await this.page.mouse.click(pageCoords.x, pageCoords.y);
    }

    // Safety: cancel any lingering wire-drawing mode. If completeToPin threw
    // (e.g. shorted-outputs), the mode stays active and subsequent drawWire
    // calls would misinterpret their clicks as waypoints of the ghost wire.
    // Pressing Escape after a successful wire is harmless (just deselects).
    await this.page.keyboard.press('Escape');
  }

  /**
   * Draw a wire from a labeled pin to a grid coordinate.
   *
   * Use this for components that are label-exempt (e.g. Ground, VDD) where
   * the destination cannot be addressed by label+pin. The destination grid
   * coordinates should match the component's placement position (Ground pin
   * is at its placement position).
   */
  async drawWireFromPin(
    fromLabel: string,
    fromPin: string,
    toGridX: number,
    toGridY: number,
  ): Promise<void> {
    const fromPage = await this.getPinPagePosition(fromLabel, fromPin);
    const toPage = await this.getGridPagePosition(toGridX, toGridY);
    await this.page.mouse.click(fromPage.x, fromPage.y);
    await this.page.mouse.click(toPage.x, toPage.y);
    await this.page.keyboard.press('Escape');
  }

  /**
   * Draw a wire along an explicit path of grid waypoints from a labeled pin
   * to another labeled pin. No autorouting — every click is specified by the
   * test author. The app's Manhattan routing handles each click-to-click segment.
   *
   * @param fromLabel - Source component label
   * @param fromPin - Source pin name
   * @param toLabel - Destination component label
   * @param toPin - Destination pin name
   * @param waypoints - Intermediate grid coordinates [[x,y], ...] between the pins
   */
  async drawWireExplicit(
    fromLabel: string,
    fromPin: string,
    toLabel: string,
    toPin: string,
    waypoints: [number, number][] = [],
  ): Promise<void> {
    const fromPage = await this.getPinPagePosition(fromLabel, fromPin);
    await this.page.mouse.click(fromPage.x, fromPage.y);
    for (const [gx, gy] of waypoints) {
      const wp = await this.getGridPagePosition(gx, gy);
      await this.page.mouse.click(wp.x, wp.y);
    }
    const toPage = await this.getPinPagePosition(toLabel, toPin);
    await this.page.mouse.click(toPage.x, toPage.y);
    await this.page.keyboard.press('Escape');
  }

  /**
   * Draw a wire from a labeled pin to a grid coordinate (e.g. Ground) along
   * an explicit path. No autorouting.
   *
   * @param fromLabel - Source component label
   * @param fromPin - Source pin name
   * @param toGridX - Destination grid X
   * @param toGridY - Destination grid Y
   * @param waypoints - Intermediate grid coordinates [[x,y], ...]
   */
  async drawWireFromPinExplicit(
    fromLabel: string,
    fromPin: string,
    toGridX: number,
    toGridY: number,
    waypoints: [number, number][] = [],
  ): Promise<void> {
    const fromPage = await this.getPinPagePosition(fromLabel, fromPin);
    await this.page.mouse.click(fromPage.x, fromPage.y);
    for (const [gx, gy] of waypoints) {
      const wp = await this.getGridPagePosition(gx, gy);
      await this.page.mouse.click(wp.x, wp.y);
    }
    const toPage = await this.getGridPagePosition(toGridX, toGridY);
    await this.page.mouse.click(toPage.x, toPage.y);
    await this.page.keyboard.press('Escape');
  }

  /**
   * Draw a wire along an explicit path of grid coordinates.
   * First point starts wire drawing, last point ends it.
   * Use for wiring between unlabeled components or arbitrary grid positions.
   */
  async drawWireByPath(points: [number, number][]): Promise<void> {
    expect(points.length, 'drawWireByPath needs at least 2 points').toBeGreaterThanOrEqual(2);
    for (const [gx, gy] of points) {
      const pos = await this.getGridPagePosition(gx, gy);
      await this.page.mouse.click(pos.x, pos.y);
    }
    await this.page.keyboard.press('Escape');
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

  /** Click the Step menu item (single step, in Simulation menu). */
  async stepViaUI(count = 1): Promise<void> {
    for (let i = 0; i < count; i++) {
      await this.page.locator('#btn-step').click();
    }
  }

  /**
   * Step the simulation N times via toolbar clicks and return the final
   * analog engine state. Each step clicks the real Step button — the same
   * code path a user would use. Returns null if no analog engine is active.
   */
  async stepAndReadAnalog(steps: number): Promise<{
    simTime: number;
    nodeVoltages: Record<string, number>;
    nodeCount: number;
  } | null> {
    await this.stepViaUI(steps);
    return this.getAnalogState();
  }

  /**
   * Right-click a labeled component and add a pin voltage trace to the viewer.
   * This mimics the user action of right-clicking → "Trace Voltage: label.pin".
   * The simulation must be running (or at least compiled) for trace items to appear.
   */
  async addTraceViaContextMenu(label: string, pinLabel: string): Promise<void> {
    // Get component position from circuit info
    const info = await this.getCircuitInfo();
    const el = info.elements.find(e => e.label === label);
    if (!el) throw new Error(`Element with label "${label}" not found`);

    // Convert to page coordinates and right-click
    const coords = await this.toPageCoords(el.center.screenX, el.center.screenY);
    await this.page.mouse.click(coords.x, coords.y, { button: 'right' });
    await this.page.waitForTimeout(200);

    // The context menu shows either "Trace Voltage: Label.Pin" (3+ terminal
    // components) or "Trace Voltage: Label" (2-terminal components like R, C, L).
    // Try the per-pin format first, then fall back to the label-only format.
    const menuTextPin = `Trace Voltage: ${label}.${pinLabel}`;
    const menuTextLabel = `Trace Voltage: ${label}`;
    // Use exact text matching to avoid matching "Trace Voltage: C1 (New Panel)"
    // when looking for "Trace Voltage: C1".
    const menuItemPin = this.page.locator('.ctx-menu-item').filter({ hasText: new RegExp(`^${menuTextPin}$`) });
    const menuItemLabel = this.page.locator('.ctx-menu-item').filter({ hasText: new RegExp(`^${menuTextLabel}$`) });

    const pinVisible = await menuItemPin.isVisible().catch(() => false);
    if (pinVisible) {
      await menuItemPin.click();
    } else {
      await expect(menuItemLabel).toBeVisible({ timeout: 3000 });
      await menuItemLabel.click();
    }
    await this.page.waitForTimeout(300);
  }

  /**
   * Step to a sim-time offset and read peak/trough statistics from the scope
   * panel trace buffers. Uses stepToTimeViaUI for efficient bulk stepping and
   * getTraceStats to read pre-computed min/max/mean from scope channels.
   *
   * @param stepsOrTime - SI time string (e.g. "5m", "100u") or legacy step count (ignored)
   * @param targetTime - SI time string when stepsOrTime is a number (legacy call form)
   */
  async measureAnalogPeaks(stepsOrTime: number | string, targetTime?: string): Promise<{
    amplitudes: number[];
    peaks: number[];
    troughs: number[];
    nodeCount: number;
  } | null> {
    const resolvedTime = typeof stepsOrTime === 'string' ? stepsOrTime : targetTime;

    const s0 = await this.getAnalogState();
    if (!s0) return null;

    if (resolvedTime) {
      await this.stepToTimeViaUI(resolvedTime);
      const stats = await this.getTraceStats();
      if (stats && stats.length > 0) {
        const peaks = stats.map(s => s.max);
        const troughs = stats.map(s => s.min);
        return {
          amplitudes: peaks.map((p, i) => (p - troughs[i]) / 2),
          peaks,
          troughs,
          nodeCount: stats.length,
        };
      }
      // No trace stats available — caller must set up traces first
      // via addTraceViaContextMenu() before calling measureAnalogPeaks()
      return null;
    }

    return null;
  }

  /**
   * Use the step-by dropdown to step by a preset time value.
   * Opens the dropdown, clicks the matching preset, and waits for completion.
   * @param targetTime - Time offset string with SI suffix (e.g. "5m", "100u", "1n")
   */
  async stepToTimeViaUI(targetTime: string): Promise<void> {
    // Open dropdown, type custom value, press Enter
    await this.page.locator('#btn-step-by').click();
    await this.page.locator('#step-custom-toggle').click();
    const input = this.page.locator('#step-custom-input');
    await input.fill(targetTime);
    await input.press('Enter');
    await this.page.waitForTimeout(500);
  }

  /**
   * Read trace statistics (min/max/mean) from the scope panel via the test bridge.
   * Returns null if no scope panel is active or no data has been collected.
   */
  async getTraceStats(): Promise<Array<{ label: string; min: number; max: number; mean: number }> | null> {
    return this.bridge('bridge.getTraceStats()');
  }

  /** Click the Run button on the toolbar. */
  async runViaUI(): Promise<void> {
    await this.page.locator('#btn-tb-run').click();
  }

  /** Click the Stop button on the toolbar. */
  async stopViaUI(): Promise<void> {
    await this.page.locator('#btn-tb-stop').click();
  }

  /** Set the simulation speed via the speed input field (sim-seconds per wall-second). */
  async setSpeed(simSecondsPerWallSecond: number): Promise<void> {
    const speedInput = this.page.locator('#speed-input');
    await speedInput.fill(String(simSecondsPerWallSecond));
    await speedInput.press('Tab'); // triggers change event naturally
  }

  // =========================================================================
  // Circuit export
  // =========================================================================

  /**
   * Export the current circuit as .dig XML string.
   * Uses the postMessage API (digital-get-circuit → digital-circuit-data).
   * Returns the decoded XML string, or null if export fails.
   */
  async exportCircuitDigXml(): Promise<string | null> {
    try {
      const b64: string = await this.page.evaluate(() => {
        return new Promise<string>((resolve, reject) => {
          const timeout = setTimeout(() => reject(new Error('Export timeout')), 5000);
          const handler = (e: MessageEvent) => {
            if (e.data?.type === 'sim-circuit-data') {
              window.removeEventListener('message', handler);
              clearTimeout(timeout);
              resolve(e.data.data);
            } else if (e.data?.type === 'sim-error') {
              window.removeEventListener('message', handler);
              clearTimeout(timeout);
              reject(new Error(e.data.error));
            }
          };
          window.addEventListener('message', handler);
          window.postMessage({ type: 'sim-get-circuit' }, '*');
        });
      });
      return Buffer.from(b64, 'base64').toString('utf-8');
    } catch {
      return null;
    }
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
          if (e.data?.type === 'sim-test-result') {
            window.removeEventListener('message', handler);
            resolve(e.data);
          } else if (e.data?.type === 'sim-error') {
            window.removeEventListener('message', handler);
            reject(new Error(`Circuit error: ${e.data.error}`));
          }
        };
        window.addEventListener('message', handler);
        window.postMessage({ type: 'sim-test', testData: td }, '*');
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
  // Wire routing engine (private)
  // =========================================================================

  /**
   * Compute a collision-free wire path from pin to pin.
   *
   * Returns an array of grid points where each consecutive pair is collinear
   * (shares x or y), suitable for sequential mouse clicks through the wire
   * drawing mode.
   */
  private _computeWirePath(
    from: Pt, to: Pt, fromDir: Dir, toDir: Dir, boxes: Box[],
  ): Pt[] {
    // --- Step 1: compute stub endpoints ---
    // Extend at least 1 grid unit from each pin in its exit direction.
    // If the stub endpoint is occupied (on an existing wire or the turn
    // column/row has traffic), keep extending.
    let fromStubLen = 1;
    while (fromStubLen < 6) {
      const candidate: Pt = {
        x: from.x + fromDir.dx * fromStubLen,
        y: from.y + fromDir.dy * fromStubLen,
      };
      if (!this._stubBlocked(candidate, fromDir)) break;
      fromStubLen++;
    }
    const fromStub: Pt = {
      x: from.x + fromDir.dx * fromStubLen,
      y: from.y + fromDir.dy * fromStubLen,
    };

    let toStubLen = 1;
    while (toStubLen < 6) {
      const candidate: Pt = {
        x: to.x + toDir.dx * toStubLen,
        y: to.y + toDir.dy * toStubLen,
      };
      if (!this._stubBlocked(candidate, toDir)) break;
      toStubLen++;
    }
    let toStub: Pt = {
      x: to.x + toDir.dx * toStubLen,
      y: to.y + toDir.dy * toStubLen,
    };
    // If exit-direction stub is fully blocked, skip stub (route directly to pin)
    if (toStubLen >= 6) toStub = { x: to.x, y: to.y };

    // --- Step 2: route between stubs ---
    const route = this._routeStubs(fromStub, toStub, fromDir, boxes);

    // --- Step 3: assemble full path ---
    // Stubs are only included as explicit click points if they are NOT on an
    // existing wire.  Clicking on a wire interior during wire-drawing mode
    // triggers a "wire tap" (completes the wire there) instead of adding a
    // waypoint.
    //
    // CRITICAL: When a stub is skipped, the Manhattan router chooses its own
    // path from the pin to the first route corner.  If the first route corner
    // is NOT collinear with the pin, the Manhattan path may cross through
    // other components/pins.  To prevent this, when skipping the stub we
    // inject an alignment point that is collinear with the pin along the exit
    // direction, ensuring the wire exits the component before turning.
    const raw: Pt[] = [from];
    const fromStubSkipped = (fromStub.x !== from.x || fromStub.y !== from.y) &&
      this._ptOnWire(fromStub);

    if (fromStubSkipped) {
      // Fan-out: the stub position is on a same-net wire, so we can't click
      // there.  The existing wire already exits the pin in the correct
      // direction.  For the new fan-out branch, exit PERPENDICULAR from the
      // pin (toward the destination) to create a T-junction at the pin,
      // then re-route from that perpendicular escape point to the destination.
      const perpDir = fromDir.dx !== 0
        ? { dx: 0, dy: to.y > from.y ? 1 : -1 }  // horizontal exit → go vertical
        : { dx: to.x > from.x ? 1 : -1, dy: 0 };  // vertical exit → go horizontal

      for (let d = 1; d <= 6; d++) {
        const esc: Pt = { x: from.x + perpDir.dx * d, y: from.y + perpDir.dy * d };
        if (!this._ptOnWire(esc) && !this._ptOnPin(esc)) {
          raw.push(esc);
          // Re-route from escape point to toStub
          const escRoute = this._routeStubs(esc, toStub, perpDir, boxes);
          raw.push(...escRoute);
          break;
        }
      }
    } else {
      // Normal (non-fan-out) path: include fromStub if it exists
      if (fromStub.x !== from.x || fromStub.y !== from.y) {
        raw.push(fromStub);
      }
      raw.push(...route);
    }

    // Add toStub and destination (common to both fan-out and normal paths)
    if (toStub.x !== to.x || toStub.y !== to.y) {
      if (!this._ptOnWire(toStub)) raw.push(toStub);
    }
    raw.push(to);

    // Remove consecutive duplicates and 180° reversals
    const deduped = raw.filter(
      (pt, i) => i === 0 || pt.x !== raw[i - 1].x || pt.y !== raw[i - 1].y,
    );
    // Remove points that create 180° turns: A→B→A pattern
    const cleaned: Pt[] = [];
    for (let i = 0; i < deduped.length; i++) {
      if (i >= 2 &&
          deduped[i].x === deduped[i - 2].x && deduped[i].y === deduped[i - 2].y) {
        // Remove the middle point (deduped[i-1]) — it's a 180° spike
        cleaned.pop();
        continue;
      }
      cleaned.push(deduped[i]);
    }
    return cleaned;
  }

  /**
   * Route between two stub endpoints, producing intermediate corner points.
   * Every consecutive pair of returned points (including from/to) is collinear.
   */
  private _routeStubs(from: Pt, to: Pt, fromDir: Dir, boxes: Box[]): Pt[] {
    // Same point — no routing needed
    if (from.x === to.x && from.y === to.y) return [];

    // Same row — try direct horizontal
    if (from.y === to.y) {
      const xMin = Math.min(from.x, to.x);
      const xMax = Math.max(from.x, to.x);
      if (this._hClear(from.y, xMin, xMax, boxes)) return [];
      return this._detourH(from, to, boxes);
    }

    // Same column — try direct vertical
    if (from.x === to.x) {
      const yMin = Math.min(from.y, to.y);
      const yMax = Math.max(from.y, to.y);
      if (this._vClear(from.x, yMin, yMax, boxes)) return [];
      return this._detourV(from, to, boxes);
    }

    // --- Non-collinear: try L-route, then Z-route ---

    // L option A: horizontal then vertical — corner at (to.x, from.y)
    const cA: Pt = { x: to.x, y: from.y };
    const cA_ok = fromDir.dx === 0 ||
      (fromDir.dx > 0 ? to.x >= from.x : to.x <= from.x);
    if (cA_ok &&
        !this._ptOccupied(cA) &&
        this._hClear(from.y, Math.min(from.x, to.x), Math.max(from.x, to.x), boxes) &&
        this._vClear(to.x, Math.min(from.y, to.y), Math.max(from.y, to.y), boxes)) {
      return [cA];
    }

    // L option B: vertical then horizontal — corner at (from.x, to.y)
    const cB: Pt = { x: from.x, y: to.y };
    const cB_ok = fromDir.dy === 0 ||
      (fromDir.dy > 0 ? to.y >= from.y : to.y <= from.y);
    if (cB_ok &&
        !this._ptOccupied(cB) &&
        this._vClear(from.x, Math.min(from.y, to.y), Math.max(from.y, to.y), boxes) &&
        this._hClear(to.y, Math.min(from.x, to.x), Math.max(from.x, to.x), boxes)) {
      return [cB];
    }

    // Z-route: horizontal → vertical → horizontal
    const midXBase = Math.round((from.x + to.x) / 2);
    for (let off = 0; off <= 12; off++) {
      const offsets = off === 0 ? [0] : [off, -off];
      for (const d of offsets) {
        const mx = midXBase + d;

        // Ensure the first horizontal segment doesn't reverse the stub direction
        if (fromDir.dx !== 0 && mx !== from.x &&
            Math.sign(mx - from.x) !== Math.sign(fromDir.dx)) {
          continue;
        }

        const z1: Pt = { x: mx, y: from.y };
        const z2: Pt = { x: mx, y: to.y };

        if (!this._ptOccupied(z1) &&
            !this._ptOccupied(z2) &&
            this._hClear(from.y, Math.min(from.x, mx), Math.max(from.x, mx), boxes) &&
            this._vClear(mx, Math.min(from.y, to.y), Math.max(from.y, to.y), boxes) &&
            this._hClear(to.y, Math.min(mx, to.x), Math.max(mx, to.x), boxes)) {
          return [z1, z2];
        }
      }
    }

    // S-route: vertical → horizontal → vertical (for when L/Z fail due to
    // existing wires spanning full rows). Find a safe y between from and to.
    const sYmin = Math.min(from.y, to.y);
    const sYmax = Math.max(from.y, to.y);
    for (let sy = sYmin + 1; sy < sYmax; sy++) {
      const s1: Pt = { x: from.x, y: sy };
      const s2: Pt = { x: to.x, y: sy };
      if (!this._ptOccupied(s1) &&
          !this._ptOccupied(s2) &&
          this._vClear(from.x, Math.min(from.y, sy), Math.max(from.y, sy), boxes) &&
          this._hClear(sy, Math.min(from.x, to.x), Math.max(from.x, to.x), boxes) &&
          this._vClear(to.x, Math.min(sy, to.y), Math.max(sy, to.y), boxes)) {
        return [s1, s2];
      }
    }

    // Extended S-route: try y values outside the from/to range
    for (let off = 1; off <= 12; off++) {
      for (const sy of [sYmin - off, sYmax + off]) {
        const s1: Pt = { x: from.x, y: sy };
        const s2: Pt = { x: to.x, y: sy };
        if (!this._ptOccupied(s1) &&
            !this._ptOccupied(s2) &&
            this._vClear(from.x, Math.min(from.y, sy), Math.max(from.y, sy), boxes) &&
            this._hClear(sy, Math.min(from.x, to.x), Math.max(from.x, to.x), boxes) &&
            this._vClear(to.x, Math.min(sy, to.y), Math.max(sy, to.y), boxes)) {
          return [s1, s2];
        }
      }
    }

    // 4-segment route: H-V-H-V or V-H-V-H for complex cases
    // Try going via a detour column (right or left) then across then down
    for (let off = 1; off <= 12; off++) {
      for (const dx of [off, -off]) {
        // Skip directions that reverse the stub exit
        if (fromDir.dx !== 0 && dx !== 0 &&
            Math.sign(dx) !== Math.sign(fromDir.dx)) continue;

        const mx = from.x + dx;
        for (let dyOff = 0; dyOff <= 12; dyOff++) {
          const dyOffsets = dyOff === 0 ? [0] : [dyOff, -dyOff];
          for (const dy of dyOffsets) {
            const my = to.y + dy;
            // 4 corners: from → (mx, from.y) → (mx, my) → (to.x, my) → to
            const c1: Pt = { x: mx, y: from.y };
            const c2: Pt = { x: mx, y: my };
            const c3: Pt = { x: to.x, y: my };

            if (this._ptOccupied(c1) || this._ptOccupied(c2) || this._ptOccupied(c3)) continue;

            if (this._hClear(from.y, Math.min(from.x, mx), Math.max(from.x, mx), boxes) &&
                this._vClear(mx, Math.min(from.y, my), Math.max(from.y, my), boxes) &&
                this._hClear(my, Math.min(mx, to.x), Math.max(mx, to.x), boxes) &&
                this._vClear(to.x, Math.min(my, to.y), Math.max(my, to.y), boxes)) {
              return [c1, c2, c3];
            }
          }
        }
      }
    }

    // Fallback: simple L (horizontal-first) — should rarely be reached
    return [{ x: to.x, y: from.y }];
  }

  /**
   * Detour around a blocked horizontal path by jogging vertically.
   * Returns two corner points forming a U-shaped bypass.
   */
  private _detourH(from: Pt, to: Pt, boxes: Box[]): Pt[] {
    const xMin = Math.min(from.x, to.x);
    const xMax = Math.max(from.x, to.x);
    for (let off = 1; off <= 10; off++) {
      for (const dy of [off, -off]) {
        const jy = from.y + dy;
        const c1: Pt = { x: from.x, y: jy };
        const c2: Pt = { x: to.x, y: jy };
        if (!this._ptOccupied(c1) &&
            !this._ptOccupied(c2) &&
            this._vClear(from.x, Math.min(from.y, jy), Math.max(from.y, jy), boxes) &&
            this._hClear(jy, xMin, xMax, boxes) &&
            this._vClear(to.x, Math.min(jy, to.y), Math.max(jy, to.y), boxes)) {
          return [c1, c2];
        }
      }
    }
    return []; // fallback: direct
  }

  /**
   * Detour around a blocked vertical path by jogging horizontally.
   */
  private _detourV(from: Pt, to: Pt, boxes: Box[]): Pt[] {
    const yMin = Math.min(from.y, to.y);
    const yMax = Math.max(from.y, to.y);
    for (let off = 1; off <= 10; off++) {
      for (const dx of [off, -off]) {
        const jx = from.x + dx;
        const c1: Pt = { x: jx, y: from.y };
        const c2: Pt = { x: jx, y: to.y };
        if (!this._ptOccupied(c1) &&
            !this._ptOccupied(c2) &&
            this._hClear(from.y, Math.min(from.x, jx), Math.max(from.x, jx), boxes) &&
            this._vClear(jx, yMin, yMax, boxes) &&
            this._hClear(to.y, Math.min(jx, to.x), Math.max(jx, to.x), boxes)) {
          return [c1, c2];
        }
      }
    }
    return []; // fallback: direct
  }

  // ---- Obstacle checks (use live circuit state via this._obs) ----

  /**
   * Check if a stub endpoint is blocked. A stub is blocked if:
   * - The point coincides with an unrelated pin
   * - The point is on a wire from a DIFFERENT net (not connected to the
   *   source pin — wires from the same pin are OK for fan-out T-junctions)
   */
  private _stubBlocked(pt: Pt, _exitDir: Dir): boolean {
    // Point at an unrelated pin position
    if (this._ptOnPin(pt)) return true;
    // Point on a wire from a different net — would merge nets
    if (this._ptOnForeignWire(pt)) return true;
    return false;
  }

  /**
   * Check if a point is "occupied" — on an existing wire or at an unrelated pin.
   * Used to validate route corner vertices.
   */
  private _ptOccupied(pt: Pt): boolean {
    return this._ptOnWire(pt) || this._ptOnPin(pt);
  }

  /** True if pt lies on any existing wire segment (endpoint or interior). */
  private _ptOnWire(pt: Pt): boolean {
    for (const w of this._obs.wires) {
      if (w.y1 === w.y2 && pt.y === w.y1) {
        if (pt.x >= Math.min(w.x1, w.x2) && pt.x <= Math.max(w.x1, w.x2)) return true;
      } else if (w.x1 === w.x2 && pt.x === w.x1) {
        if (pt.y >= Math.min(w.y1, w.y2) && pt.y <= Math.max(w.y1, w.y2)) return true;
      }
    }
    return false;
  }

  /**
   * True if pt lies on a wire that is NOT connected to the current drawWire's
   * source pin. Wires sharing an endpoint with the source pin are on the same
   * net and safe for fan-out T-junctions.
   */
  private _ptOnForeignWire(pt: Pt): boolean {
    const src = this._endpointPins[0]; // source pin of current drawWire
    for (const w of this._obs.wires) {
      // Skip wires that have an endpoint at the source pin (same net)
      if (src &&
          ((w.x1 === src.x && w.y1 === src.y) ||
           (w.x2 === src.x && w.y2 === src.y))) {
        continue;
      }
      if (w.y1 === w.y2 && pt.y === w.y1) {
        if (pt.x >= Math.min(w.x1, w.x2) && pt.x <= Math.max(w.x1, w.x2)) return true;
      } else if (w.x1 === w.x2 && pt.x === w.x1) {
        if (pt.y >= Math.min(w.y1, w.y2) && pt.y <= Math.max(w.y1, w.y2)) return true;
      }
    }
    return false;
  }

  /** True if pt coincides with a pin that is NOT one of the current drawWire endpoints. */
  private _ptOnPin(pt: Pt): boolean {
    for (const p of this._obs.pins) {
      if (this._endpointPins.some(ep => ep.x === p.x && ep.y === p.y)) continue;
      if (pt.x === p.x && pt.y === p.y) return true;
    }
    return false;
  }

  /**
   * True if no component body, no unrelated pin, and no existing same-direction
   * wire blocks a horizontal run at y over [xMin, xMax].
   * Boxes containing a drawWire endpoint are excluded (wire must enter/exit
   * its source and destination components).
   * Pins at the segment endpoints are excluded (strict interior check).
   * Existing horizontal wires overlapping this row are blocked (one-per-lane rule).
   */
  private _hClear(y: number, xMin: number, xMax: number, boxes: Box[]): boolean {
    for (const b of boxes) {
      if (this._boxContainsEndpoint(b)) continue;
      if (y > b.y && y < b.y + b.h && xMax > b.x && xMin < b.x + b.w) {
        return false;
      }
    }
    // Check that no unrelated pin lies in the interior of this segment
    for (const p of this._obs.pins) {
      if (this._endpointPins.some(ep => ep.x === p.x && ep.y === p.y)) continue;
      if (p.y === y && p.x > xMin && p.x < xMax) return false;
    }
    // One-per-lane: no existing horizontal wire on this row with overlapping x range
    for (const w of this._obs.wires) {
      if (w.y1 !== w.y2) continue;
      if (w.y1 !== y) continue;
      const wMin = Math.min(w.x1, w.x2);
      const wMax = Math.max(w.x1, w.x2);
      if (wMax > xMin && wMin < xMax) return false;
    }
    return true;
  }

  /**
   * True if no component body, no unrelated pin, and no existing same-direction
   * wire blocks a vertical run at x over [yMin, yMax].
   */
  private _vClear(x: number, yMin: number, yMax: number, boxes: Box[]): boolean {
    for (const b of boxes) {
      if (this._boxContainsEndpoint(b)) continue;
      if (x > b.x && x < b.x + b.w && yMax > b.y && yMin < b.y + b.h) {
        return false;
      }
    }
    for (const p of this._obs.pins) {
      if (this._endpointPins.some(ep => ep.x === p.x && ep.y === p.y)) continue;
      if (p.x === x && p.y > yMin && p.y < yMax) return false;
    }
    // One-per-lane: no existing vertical wire on this column with overlapping y range
    for (const w of this._obs.wires) {
      if (w.x1 !== w.x2) continue; // skip horizontal wires
      if (w.x1 !== x) continue;    // different column
      const wMin = Math.min(w.y1, w.y2);
      const wMax = Math.max(w.y1, w.y2);
      if (wMax > yMin && wMin < yMax) return false;
    }
    return true;
  }

  /** True if a bounding box contains either the source or destination pin. */
  private _boxContainsEndpoint(b: Box): boolean {
    const EPS = 0.5; // tolerance for pins near box edges (fractional grid coords)
    for (const ep of this._endpointPins) {
      if (ep.x >= b.x - EPS && ep.x <= b.x + b.w + EPS &&
          ep.y >= b.y - EPS && ep.y <= b.y + b.h + EPS) {
        return true;
      }
    }
    return false;
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

    // Try exact text-is match first in both .prop-row (regular properties) and
    // .prop-row-inline (model parameters), then fall back to case-insensitive prefix match.
    const rowSelector = `.prop-row:has(.prop-label:text-is("${propLabel}")), .prop-row-inline:has(.prop-label:text-is("${propLabel}"))`;
    let row = popup.locator(rowSelector);
    const exactCount = await row.count();
    if (exactCount === 0) {
      // Case-insensitive prefix fallback: find the row whose label starts with the given text
      const lowerLabel = propLabel.toLowerCase();
      const allRows = popup.locator('.prop-row, .prop-row-inline');
      const count = await allRows.count();
      for (let i = 0; i < count; i++) {
        const rowEl = allRows.nth(i);
        const labelText = await rowEl.locator('.prop-label').textContent();
        if (labelText && labelText.toLowerCase().startsWith(lowerLabel)) {
          row = rowEl;
          break;
        }
      }
    }

    const input = row.locator('input, select, textarea').first();
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
    // Resolve aliases (e.g. "AnalogResistor" → "Resistor") to canonical names
    // shown in the palette. Falls back to the original name if not an alias.
    const displayName: string = await this.page.evaluate((name) => {
      const b = (window as any).__test;
      return b?.resolveComponentName?.(name) ?? name;
    }, typeName);

    const searchInput = this.page.locator('.palette-search-input');
    await searchInput.fill(displayName);

    const item = this.page.locator(
      `.palette-component-item:has(.palette-component-name:text-is("${displayName}"))`,
    );
    await expect(
      item.first(),
      `Palette item "${typeName}" (display: "${displayName}") not found — is the correct engine mode set?`,
    ).toBeVisible({ timeout: 5000 });
    await item.first().click();

    // Clear search to restore full palette for subsequent placements.
    // fill('') sets value and fires input/change events via Playwright's
    // internal setValue path. Follow with a Backspace keystroke to ensure
    // the palette's input listener fires even if fill('') alone doesn't.
    await searchInput.fill('');
    await searchInput.press('Backspace');
  }

  // =========================================================================
  // SPICE model parameter overrides (via SPICE panel UI)
  // =========================================================================

  /**
   * Set SPICE model parameter overrides on a component via the SPICE panel UI.
   * Opens the property popup, expands the SPICE Model Parameters section,
   * fills each parameter field, and closes the popup.
   *
   * @param elementLabel - component label (e.g. 'Q1')
   * @param overrides - object of parameter key to value (e.g. { IS: 1e-14, BF: 100 })
   */
  async setSpiceOverrides(elementLabel: string, overrides: Record<string, number>): Promise<void> {
    const info = await this.getCircuitInfo();
    const el = info.elements.find(e => e.label === elementLabel);
    expect(el, `Element "${elementLabel}" not found`).toBeTruthy();

    // Close any open popup first — an open popup overlays the canvas and
    // absorbs double-click events, preventing a new popup from opening.
    const existingPopup = this.page.locator('.prop-popup');
    if (await existingPopup.isVisible().catch(() => false)) {
      await existingPopup.locator('.prop-popup-close').click();
      await existingPopup.waitFor({ state: 'hidden', timeout: 2000 });
    }

    // Double-click to open property popup
    await this._dblClickElementBody(el!);
    const popup = this.page.locator('.prop-popup');
    await expect(popup).toBeVisible({ timeout: 3000 });

    // Primary model params (e.g. IS, BF) are rendered directly in prop-row elements.
    // Secondary params (e.g. VAF, NF) are under "▶ Advanced Parameters" — expand
    // it first if any secondary param is requested.
    // Each param row: div.prop-row > label.prop-label(key) + input + span(unit)
    for (const [key, value] of Object.entries(overrides)) {
      // Try to find the label directly (primary params are always visible).
      let keyLabel = popup.locator(`label`).filter({ hasText: new RegExp(`^${key}$`) });
      const isVisible = await keyLabel.first().isVisible().catch(() => false);
      if (!isVisible) {
        // May be a secondary param — expand Advanced Parameters if not already open
        const advToggle = popup.getByText('▶ Advanced Parameters');
        if (await advToggle.isVisible().catch(() => false)) {
          await advToggle.click();
          await popup.getByText('▼ Advanced Parameters').waitFor({ state: 'visible', timeout: 1000 });
        }
        keyLabel = popup.locator(`label`).filter({ hasText: new RegExp(`^${key}$`) });
      }
      await expect(keyLabel.first()).toBeVisible({ timeout: 2000 });
      const row = keyLabel.first().locator('..');
      const input = row.locator('input').first();
      await expect(input).toBeVisible({ timeout: 2000 });
      await input.fill(String(value));
      await input.press('Tab');
    }

    // Close popup via close button (Escape does not dismiss the property popup)
    const closeBtn = popup.locator('.prop-popup-close');
    if (await closeBtn.isVisible().catch(() => false)) {
      await closeBtn.click();
      await popup.waitFor({ state: 'hidden', timeout: 2000 });
    }
  }
}

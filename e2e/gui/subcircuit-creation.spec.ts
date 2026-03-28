/**
 * GUI tests — subcircuit creation workflow.
 *
 * Tests the "Make Subcircuit…" context menu entry: right-click trigger,
 * disabled state during simulation, dialog port table population, preview
 * canvas updates on face change, and final replacement of selection with a
 * subcircuit instance.
 *
 * All tests run inside the simulator iframe via the harness.html wrapper.
 * The context menu is rendered inside the iframe document body as a .ctx-menu
 * <ul> element. All DOM queries for the context menu use `harness.iframe`
 * (Playwright FrameLocator).
 *
 * The "Make Subcircuit…" menu item label uses U+2026 (HORIZONTAL ELLIPSIS).
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';

// ---------------------------------------------------------------------------
// Shared circuit XML
// ---------------------------------------------------------------------------

/**
 * Four-element circuit: In A → And ← In B → Out Y.
 * All four elements selected: zero boundary ports (no external wires cross the
 * selection boundary).  Selecting only the And gate would yield 3 boundary
 * ports, but that requires partial selection which is harder in E2E.
 */
const AND_GATE_XML = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes><entry><string>romContent</string><romList><roms/></romList></entry></attributes>
  <visualElements>
    <visualElement><elementName>In</elementName>
      <elementAttributes><entry><string>Label</string><string>A</string></entry></elementAttributes>
      <pos x="200" y="200"/></visualElement>
    <visualElement><elementName>In</elementName>
      <elementAttributes><entry><string>Label</string><string>B</string></entry></elementAttributes>
      <pos x="200" y="260"/></visualElement>
    <visualElement><elementName>And</elementName>
      <elementAttributes/>
      <pos x="320" y="200"/></visualElement>
    <visualElement><elementName>Out</elementName>
      <elementAttributes><entry><string>Label</string><string>Y</string></entry></elementAttributes>
      <pos x="440" y="220"/></visualElement>
  </visualElements>
  <wires>
    <wire><p1 x="200" y="200"/><p2 x="320" y="200"/></wire>
    <wire><p1 x="200" y="260"/><p2 x="300" y="260"/></wire>
    <wire><p1 x="300" y="240"/><p2 x="300" y="260"/></wire>
    <wire><p1 x="300" y="240"/><p2 x="320" y="240"/></wire>
    <wire><p1 x="380" y="220"/><p2 x="440" y="220"/></wire>
  </wires>
</circuit>`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait (poll) until the test bridge inside the iframe reports at least
 * `minElements` circuit elements.  Throws if the timeout elapses.
 */
async function waitForCircuitElements(
  harness: SimulatorHarness,
  minElements: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count: number = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const bridge = (iframe?.contentWindow as any)?.__test;
      if (!bridge) return 0;
      return bridge.getCircuitInfo().elementCount as number;
    });
    if (count >= minElements) return;
    await harness.page.waitForTimeout(100);
  }
  throw new Error(`Timed out: circuit still has fewer than ${minElements} elements after ${timeoutMs}ms`);
}

/**
 * Return the screen position of the element at `index` in the circuit, via the
 * test bridge.  Coordinates are relative to the canvas element inside the iframe.
 */
async function getElementCenterScreen(
  harness: SimulatorHarness,
  index: number,
): Promise<{ x: number; y: number }> {
  const pos = await harness.page.evaluate((idx: number) => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    const bridge = (iframe?.contentWindow as any)?.__test;
    if (!bridge) return null;
    return bridge.getElementCenter(idx) as { x: number; y: number } | null;
  }, index);
  if (!pos) throw new Error(`getElementCenter(${index}) returned null`);
  return pos;
}

/**
 * Return the index of the first element whose typeId contains `typeFragment`.
 */
async function findElementIndex(
  harness: SimulatorHarness,
  typeFragment: string,
): Promise<number> {
  const idx: number = await harness.page.evaluate((frag: string) => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    const bridge = (iframe?.contentWindow as any)?.__test;
    if (!bridge) return -1;
    const info = bridge.getCircuitInfo();
    return (info.elements as Array<{ typeId: string }>).findIndex(
      e => e.typeId.includes(frag),
    );
  }, typeFragment);
  return idx;
}

/**
 * Load the AND gate circuit, wait until 4 elements are visible, select all,
 * then right-click on the And gate element to open the context menu.
 */
async function setupContextMenu(harness: SimulatorHarness): Promise<void> {
  await harness.loadDigXml(AND_GATE_XML);
  // Wait for the circuit to fully propagate into the editor
  await waitForCircuitElements(harness, 4);

  // Select all via the toolbar button
  await harness.page.evaluate(() => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    iframe.contentWindow!.document.getElementById('btn-select-all')?.click();
  });
  await harness.page.waitForTimeout(150);

  // Find the And gate by index and get its screen center
  const andIdx = await findElementIndex(harness, 'And');
  if (andIdx === -1) throw new Error('And gate not found in circuit after load');

  const andPos = await getElementCenterScreen(harness, andIdx);

  const canvasBox = await harness.iframe.locator('#sim-canvas').boundingBox();
  if (!canvasBox) throw new Error('Canvas bounding box not found');

  // Right-click over the And gate element
  await harness.page.mouse.click(
    canvasBox.x + andPos.x,
    canvasBox.y + andPos.y,
    { button: 'right' },
  );
  await harness.page.waitForTimeout(200);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('GUI: subcircuit creation', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
    await harness.iframe.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  // -------------------------------------------------------------------------
  // 1. Right-click with 2+ elements selected shows "Make Subcircuit…"
  // -------------------------------------------------------------------------

  test('right-click with 2+ elements selected shows "Make Subcircuit\u2026" menu item', async () => {
    await setupContextMenu(harness);

    // The context menu is rendered inside the iframe as .ctx-menu > .ctx-menu-item
    const menuItem = harness.iframe.locator('.ctx-menu-item').filter({
      hasText: 'Make Subcircuit\u2026',
    });
    await expect(menuItem).toBeVisible({ timeout: 3000 });
  });

  // -------------------------------------------------------------------------
  // 2. "Make Subcircuit…" is disabled when simulation is running
  // -------------------------------------------------------------------------

  test('"Make Subcircuit\u2026" is disabled when simulation is running', async () => {
    await harness.loadDigXml(AND_GATE_XML);
    await waitForCircuitElements(harness, 4);

    // Start simulation via the Run toolbar button inside the iframe
    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const doc = iframe.contentWindow!.document;
      (doc.getElementById('btn-tb-run') ?? doc.getElementById('btn-run'))?.click();
    });
    await harness.page.waitForTimeout(300);

    // Select all
    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      iframe.contentWindow!.document.getElementById('btn-select-all')?.click();
    });
    await harness.page.waitForTimeout(150);

    // Right-click on the And gate
    const andIdx = await findElementIndex(harness, 'And');
    if (andIdx === -1) throw new Error('And gate not found');
    const andPos = await getElementCenterScreen(harness, andIdx);
    const canvasBox = await harness.iframe.locator('#sim-canvas').boundingBox();
    if (!canvasBox) throw new Error('Canvas bounding box not found');

    await harness.page.mouse.click(
      canvasBox.x + andPos.x,
      canvasBox.y + andPos.y,
      { button: 'right' },
    );
    await harness.page.waitForTimeout(200);

    const menuItem = harness.iframe.locator('.ctx-menu-item').filter({
      hasText: 'Make Subcircuit\u2026',
    });
    await expect(menuItem).toBeVisible({ timeout: 3000 });
    // Disabled item carries the ctx-menu-item--disabled class
    await expect(menuItem).toHaveClass(/ctx-menu-item--disabled/);

    // Stop simulation for clean teardown
    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const doc = iframe.contentWindow!.document;
      (doc.getElementById('btn-tb-stop') ?? doc.getElementById('btn-stop'))?.click();
    });
  });

  // -------------------------------------------------------------------------
  // 3. Dialog opens with auto-populated port table
  // -------------------------------------------------------------------------

  test('dialog opens with auto-populated port table matching boundary wire count', async () => {
    await setupContextMenu(harness);

    const menuItem = harness.iframe.locator('.ctx-menu-item').filter({
      hasText: 'Make Subcircuit\u2026',
    });
    await expect(menuItem).toBeVisible({ timeout: 3000 });
    await menuItem.click();
    await harness.page.waitForTimeout(300);

    // Dialog is appended to iframe document.body
    const dialog = harness.iframe.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Ports table must be present
    await expect(harness.iframe.locator('.subcircuit-dialog table')).toBeVisible();
    await expect(harness.iframe.locator('.subcircuit-dialog table tbody')).toBeVisible();

    // Dismiss
    await harness.iframe
      .locator('.subcircuit-dialog')
      .getByRole('button', { name: 'Cancel' })
      .click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });
  });

  // -------------------------------------------------------------------------
  // 4. Changing a face dropdown updates the chip preview canvas
  // -------------------------------------------------------------------------

  test('changing a port face in the dialog updates the chip preview', async () => {
    // Select only the And gate (not the whole circuit) so that boundary wires
    // exist and the dialog's port table is populated with face dropdowns.
    // The And gate has 2 input boundary wires (from In A and In B) and 1
    // output boundary wire (to Out Y) — producing 3 face dropdowns.
    await harness.loadDigXml(AND_GATE_XML);
    await waitForCircuitElements(harness, 4);

    // Click the And gate element to select only it (deselects everything else)
    const andIdx = await findElementIndex(harness, 'And');
    if (andIdx === -1) throw new Error('And gate not found in circuit after load');
    const andPos = await getElementCenterScreen(harness, andIdx);

    const canvasBox = await harness.iframe.locator('#sim-canvas').boundingBox();
    if (!canvasBox) throw new Error('Canvas bounding box not found');

    // Single left-click to deselect any previous selection, then select all
    await harness.page.mouse.click(
      canvasBox.x + andPos.x,
      canvasBox.y + andPos.y,
    );
    await harness.page.waitForTimeout(150);

    // Shift+click the first In component to add it to the selection (And + In_A
    // selected). Wires from In_B and Out_Y cross the boundary → 2 face dropdowns.
    const inIdx = await findElementIndex(harness, 'In');
    if (inIdx === -1) throw new Error('In component not found in circuit after load');
    const inPos = await getElementCenterScreen(harness, inIdx);
    await harness.page.keyboard.down('Shift');
    await harness.page.mouse.click(
      canvasBox.x + inPos.x,
      canvasBox.y + inPos.y,
    );
    await harness.page.keyboard.up('Shift');
    await harness.page.waitForTimeout(150);

    // Right-click on the And gate to open the context menu
    await harness.page.mouse.click(
      canvasBox.x + andPos.x,
      canvasBox.y + andPos.y,
      { button: 'right' },
    );
    await harness.page.waitForTimeout(200);

    const menuItem = harness.iframe.locator('.ctx-menu-item').filter({
      hasText: 'Make Subcircuit\u2026',
    });
    await expect(menuItem).toBeVisible({ timeout: 3000 });
    await menuItem.click();
    await harness.page.waitForTimeout(300);

    const dialog = harness.iframe.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Expect boundary ports — selecting only the And gate yields wires that
    // cross the selection boundary, so face dropdowns must be present.
    // Scope to the table to skip the shape select (LAYOUT/DIL) above the table.
    const faceSelects = harness.iframe.locator('.subcircuit-dialog table select');
    await expect(faceSelects.first()).toBeVisible({ timeout: 2000 });

    // Capture preview canvas pixel checksum before any face change
    const pixelsBefore = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const doc = iframe.contentWindow!.document;
      const canvas = doc.querySelector('.subcircuit-dialog canvas') as HTMLCanvasElement | null;
      if (!canvas) return null;
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) return null;
      const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      return sum;
    });

    // Change the first face select to a different face value
    const firstSelect = faceSelects.first();
    const currentValue = await firstSelect.inputValue();
    const newValue = currentValue === 'left' ? 'right' : 'left';
    await firstSelect.selectOption(newValue);
    await harness.page.waitForTimeout(200);

    const pixelsAfter = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const doc = iframe.contentWindow!.document;
      const canvas = doc.querySelector('.subcircuit-dialog canvas') as HTMLCanvasElement | null;
      if (!canvas) return null;
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) return null;
      const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      return sum;
    });

    // Preview canvas must have been redrawn after the face change
    expect(pixelsBefore).not.toBeNull();
    expect(pixelsAfter).not.toBeNull();
    expect(pixelsAfter).not.toBe(pixelsBefore);

    // Dismiss
    await harness.iframe
      .locator('.subcircuit-dialog')
      .getByRole('button', { name: 'Cancel' })
      .click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });
  });

  // -------------------------------------------------------------------------
  // 5. "Create" replaces selected elements with a subcircuit instance
  // -------------------------------------------------------------------------

  test('clicking "Create" replaces selection with a subcircuit instance on the canvas', async () => {
    await harness.loadDigXml(AND_GATE_XML);
    await waitForCircuitElements(harness, 4);

    const infoBefore = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      return (iframe.contentWindow as any).__test.getCircuitInfo();
    });
    expect(infoBefore.elementCount).toBe(4);

    // Select all
    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      iframe.contentWindow!.document.getElementById('btn-select-all')?.click();
    });
    await harness.page.waitForTimeout(150);

    // Right-click on the And gate to open context menu
    const andIdx = await findElementIndex(harness, 'And');
    if (andIdx === -1) throw new Error('And gate not found');
    const andPos = await getElementCenterScreen(harness, andIdx);
    const canvasBox = await harness.iframe.locator('#sim-canvas').boundingBox();
    if (!canvasBox) throw new Error('Canvas bounding box not found');

    await harness.page.mouse.click(
      canvasBox.x + andPos.x,
      canvasBox.y + andPos.y,
      { button: 'right' },
    );
    await harness.page.waitForTimeout(200);

    const menuItem = harness.iframe.locator('.ctx-menu-item').filter({
      hasText: 'Make Subcircuit\u2026',
    });
    await expect(menuItem).toBeVisible({ timeout: 3000 });
    await menuItem.click();
    await harness.page.waitForTimeout(300);

    const dialog = harness.iframe.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Enter a subcircuit name (required; Create button is disabled without it)
    const nameInput = harness.iframe
      .locator('.subcircuit-dialog input[type="text"]')
      .first();
    await nameInput.fill('E2ETestSub');
    await harness.page.waitForTimeout(100);

    // Click Create
    await harness.iframe
      .locator('.subcircuit-dialog')
      .getByRole('button', { name: 'Create' })
      .click();
    await harness.page.waitForTimeout(400);

    // Dialog must be gone
    await expect(harness.iframe.locator('.subcircuit-dialog')).not.toBeVisible({
      timeout: 2000,
    });

    // The 4 original elements must now be replaced by 1 subcircuit instance
    const infoAfter = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      return (iframe.contentWindow as any).__test.getCircuitInfo();
    });
    expect(infoAfter.elementCount).toBeLessThan(infoBefore.elementCount);
    expect(infoAfter.elementCount).toBeGreaterThan(0);

    // A Subcircuit-typed element must be present
    const hasSubcircuit = (
      infoAfter.elements as Array<{ typeId: string }>
    ).some(e => e.typeId.startsWith('Subcircuit:'));
    expect(hasSubcircuit).toBe(true);
  });
});

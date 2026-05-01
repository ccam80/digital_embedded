/**
 * GUI tests- circuit building via canvas interactions.
 *
 * Tests the full pipeline: palette click → component placement → wire drawing
 * → circuit verification. Uses the test bridge (__test) to discover pin
 * positions, then interacts with real pointer events on the canvas.
 *
 * This catches the class of bugs where wire joining, component placement,
 * or hit-testing is broken in the GUI even though headless tests pass.
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';

/** Helper: get the test bridge from inside the simulator iframe. */
async function getBridge(harness: SimulatorHarness) {
  return harness.iframe;
}

/** Place a component by clicking it in the palette, then clicking on the canvas. */
async function placeComponent(
  harness: SimulatorHarness,
  typeName: string,
  canvasClickX: number,
  canvasClickY: number,
) {
  const iframe = harness.iframe;

  // Click the component in the palette
  await iframe.locator(`[data-type="${typeName}"]`).click();

  // Click on the canvas to place it- convert canvas-relative coords to iframe coords
  const canvasBox = await iframe.locator('#sim-canvas').boundingBox();
  expect(canvasBox).not.toBeNull();
  await harness.page.mouse.click(
    canvasBox!.x + canvasClickX,
    canvasBox!.y + canvasClickY,
  );

  // Press Escape to exit placement mode
  await harness.page.keyboard.press('Escape');
}

/**
 * Draw a wire between two pins by clicking on pin positions.
 * Positions are screen coordinates relative to the canvas.
 */
async function drawWire(
  harness: SimulatorHarness,
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
) {
  const canvasBox = await harness.iframe.locator('#sim-canvas').boundingBox();
  expect(canvasBox).not.toBeNull();

  const absFromX = canvasBox!.x + fromX;
  const absFromY = canvasBox!.y + fromY;
  const absToX = canvasBox!.x + toX;
  const absToY = canvasBox!.y + toY;

  // Click source pin
  await harness.page.mouse.click(absFromX, absFromY);
  // Small delay for wire drawing mode to activate
  await harness.page.waitForTimeout(50);
  // Click destination pin
  await harness.page.mouse.click(absToX, absToY);
}

test.describe('GUI: circuit building', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
    // Wait for test bridge to be available
    await harness.iframe.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500); // ensure test bridge is initialized
  });

  test('test bridge is available', async () => {
    const info = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const bridge = (iframe.contentWindow as any).__test;
      if (!bridge) return null;
      return bridge.getCircuitInfo();
    });
    expect(info).not.toBeNull();
    expect(info.elementCount).toBe(0);
    expect(info.wireCount).toBe(0);
  });

  test('place a component from the palette', async () => {
    // Check palette has the In component
    const paletteItem = harness.iframe.locator('[data-type="In"]');

    // If palette items don't have data-type, find by text
    const inItem = (await paletteItem.count()) > 0
      ? paletteItem
      : harness.iframe.getByRole('treeitem', { name: 'In', exact: true });

    await expect(inItem).toBeVisible();
    await inItem.click();

    // Click on the canvas center to place it
    const canvasBox = await harness.iframe.locator('#sim-canvas').boundingBox();
    expect(canvasBox).not.toBeNull();
    await harness.page.mouse.click(
      canvasBox!.x + canvasBox!.width / 2,
      canvasBox!.y + canvasBox!.height / 2,
    );

    // Press Escape to exit placement mode
    await harness.page.keyboard.press('Escape');

    // Verify element was added
    const info = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      return (iframe.contentWindow as any).__test.getCircuitInfo();
    });
    expect(info.elementCount).toBe(1);
  });

  test('place two components and verify circuit state', async () => {
    const canvasBox = await harness.iframe.locator('#sim-canvas').boundingBox();
    expect(canvasBox).not.toBeNull();
    const cx = canvasBox!.x;
    const cy = canvasBox!.y;
    const cw = canvasBox!.width;
    const ch = canvasBox!.height;

    // Place an In component on the left
    const inItem = harness.iframe.getByRole('treeitem', { name: 'In', exact: true });
    await inItem.click();
    await harness.page.mouse.click(cx + cw * 0.25, cy + ch * 0.4);
    await harness.page.keyboard.press('Escape');

    // Place an Out component on the right
    const outItem = harness.iframe.getByRole('treeitem', { name: 'Out' });
    await outItem.click();
    await harness.page.mouse.click(cx + cw * 0.75, cy + ch * 0.4);
    await harness.page.keyboard.press('Escape');

    // Verify both elements placed
    const info = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      return (iframe.contentWindow as any).__test.getCircuitInfo();
    });
    expect(info.elementCount).toBe(2);
  });

  test('build AND gate circuit and verify with test vectors', async () => {
    // Use the postMessage API to load a known-good circuit, then use the
    // test bridge to verify the loaded circuit appears in the editor.
    // This tests that postMessage loading correctly populates the editor.
    const andGateXml = `<?xml version="1.0" encoding="utf-8"?>
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
      <elementAttributes><entry><string>wideShape</string><boolean>true</boolean></entry></elementAttributes>
      <pos x="300" y="200"/></visualElement>
    <visualElement><elementName>Out</elementName>
      <elementAttributes><entry><string>Label</string><string>Y</string></entry></elementAttributes>
      <pos x="420" y="220"/></visualElement>
  </visualElements>
  <wires>
    <wire><p1 x="200" y="200"/><p2 x="300" y="200"/></wire>
    <wire><p1 x="200" y="260"/><p2 x="280" y="260"/></wire>
    <wire><p1 x="280" y="240"/><p2 x="280" y="260"/></wire>
    <wire><p1 x="280" y="240"/><p2 x="300" y="240"/></wire>
    <wire><p1 x="380" y="220"/><p2 x="420" y="220"/></wire>
  </wires>
</circuit>`;

    await harness.loadDigXml(andGateXml);

    // Verify the editor now has the circuit loaded
    const info = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      return (iframe.contentWindow as any).__test.getCircuitInfo();
    });
    expect(info.elementCount).toBe(4); // 2 In + 1 And + 1 Out
    expect(info.wireCount).toBe(5);

    // Verify labeled elements are present
    const labels = info.elements.map((e: { label: string }) => e.label).filter(Boolean);
    expect(labels).toContain('A');
    expect(labels).toContain('B');
    expect(labels).toContain('Y');

    // Run test vectors to verify the circuit works
    const result = await harness.runTests('A B Y\n0 0 0\n0 1 0\n1 0 0\n1 1 1');
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  test('wire drawing between two pins', async () => {
    // Load a circuit with two components but no wires
    const noWireXml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes><entry><string>romContent</string><romList><roms/></romList></entry></attributes>
  <visualElements>
    <visualElement><elementName>In</elementName>
      <elementAttributes><entry><string>Label</string><string>A</string></entry></elementAttributes>
      <pos x="200" y="200"/></visualElement>
    <visualElement><elementName>Out</elementName>
      <elementAttributes><entry><string>Label</string><string>Y</string></entry></elementAttributes>
      <pos x="400" y="200"/></visualElement>
  </visualElements>
  <wires/>
</circuit>`;

    await harness.loadDigXml(noWireXml);

    // Get pin screen positions from the test bridge
    const pins = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const bridge = (iframe.contentWindow as any).__test;
      return {
        inOut: bridge.getPinPosition('A', 'out'),
        outIn: bridge.getPinPosition('Y', 'in'),
        canvasRect: bridge.getCanvasRect(),
      };
    });

    expect(pins.inOut).not.toBeNull();
    expect(pins.outIn).not.toBeNull();

    // The pin positions are relative to the canvas element in the iframe.
    // We need to convert to page coordinates via the iframe's position.
    const iframeBox = await harness.page.locator('#sim').boundingBox();
    expect(iframeBox).not.toBeNull();

    const fromX = iframeBox!.x + pins.canvasRect.left + pins.inOut.x;
    const fromY = iframeBox!.y + pins.canvasRect.top + pins.inOut.y;
    const toX = iframeBox!.x + pins.canvasRect.left + pins.outIn.x;
    const toY = iframeBox!.y + pins.canvasRect.top + pins.outIn.y;

    // Click on the output pin of In component to start wire drawing
    await harness.page.mouse.click(fromX, fromY);
    await harness.page.waitForTimeout(100);

    // Click on the input pin of Out component to complete wire
    await harness.page.mouse.click(toX, toY);
    await harness.page.waitForTimeout(100);

    // Verify wire was added
    const info = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      return (iframe.contentWindow as any).__test.getCircuitInfo();
    });
    expect(info.wireCount).toBeGreaterThan(0);
  });

  test('select-all and delete removes all components', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes><entry><string>romContent</string><romList><roms/></romList></entry></attributes>
  <visualElements>
    <visualElement><elementName>In</elementName>
      <elementAttributes><entry><string>Label</string><string>A</string></entry></elementAttributes>
      <pos x="200" y="200"/></visualElement>
    <visualElement><elementName>Out</elementName>
      <elementAttributes><entry><string>Label</string><string>Y</string></entry></elementAttributes>
      <pos x="400" y="200"/></visualElement>
  </visualElements>
  <wires/>
</circuit>`;

    await harness.loadDigXml(xml);

    // Verify circuit loaded
    let info = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      return (iframe.contentWindow as any).__test.getCircuitInfo();
    });
    expect(info.elementCount).toBe(2);

    // Focus the iframe canvas by clicking it, then use Ctrl+A, Delete
    // We need the iframe to have focus for keyboard events
    const iframeEl = harness.page.locator('#sim');
    const iframeBox = await iframeEl.boundingBox();
    // Click empty area of canvas to focus
    await harness.page.mouse.click(iframeBox!.x + 10, iframeBox!.y + 10);
    await harness.page.waitForTimeout(100);

    // Use menu buttons instead- click Edit > Select All, then Edit > Delete
    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const doc = iframe.contentWindow!.document;
      doc.getElementById('btn-select-all')?.click();
    });
    await harness.page.waitForTimeout(100);

    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const doc = iframe.contentWindow!.document;
      doc.getElementById('btn-delete')?.click();
    });
    await harness.page.waitForTimeout(100);

    // Verify all elements removed
    info = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      return (iframe.contentWindow as any).__test.getCircuitInfo();
    });
    expect(info.elementCount).toBe(0);
  });

  test('undo restores deleted components', async () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<circuit>
  <version>2</version>
  <attributes><entry><string>romContent</string><romList><roms/></romList></entry></attributes>
  <visualElements>
    <visualElement><elementName>In</elementName>
      <elementAttributes><entry><string>Label</string><string>A</string></entry></elementAttributes>
      <pos x="200" y="200"/></visualElement>
  </visualElements>
  <wires/>
</circuit>`;

    await harness.loadDigXml(xml);

    // Select all and delete via menu buttons
    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const doc = iframe.contentWindow!.document;
      doc.getElementById('btn-select-all')?.click();
    });
    await harness.page.waitForTimeout(100);

    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const doc = iframe.contentWindow!.document;
      doc.getElementById('btn-delete')?.click();
    });
    await harness.page.waitForTimeout(100);

    // Verify deleted
    let info = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      return (iframe.contentWindow as any).__test.getCircuitInfo();
    });
    expect(info.elementCount).toBe(0);

    // Undo via menu button
    await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      const doc = iframe.contentWindow!.document;
      doc.getElementById('btn-undo')?.click();
    });
    await harness.page.waitForTimeout(100);

    // Verify restored
    info = await harness.page.evaluate(() => {
      const iframe = document.getElementById('sim') as HTMLIFrameElement;
      return (iframe.contentWindow as any).__test.getCircuitInfo();
    });
    expect(info.elementCount).toBe(1);
  });
});

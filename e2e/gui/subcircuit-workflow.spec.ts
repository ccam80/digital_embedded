/**
 * GUI tests- full subcircuit creation, editing, and navigation workflow.
 *
 * Builds circuits through genuine UI interactions (palette click → wire draw →
 * partial selection → right-click → Make Subcircuit dialog → verify result).
 *
 * Tests cover:
 *   - Partial selection with boundary ports → dialog shows correct port table
 *   - Auto-name generation (subcircuit_1, subcircuit_2, ...)
 *   - Pin face assignment changes update the chip preview
 *   - Chip dimensions reflect actual port count (not zero)
 *   - Created subcircuit compiles and simulates correctly
 *   - Double-click drill-down into subcircuit definition
 *   - Breadcrumb navigation back to parent
 *   - Right-click "Edit Symbol…" to modify pin layout
 *   - Right-click "Open Subcircuit" to navigate inside
 *   - Undo restores original elements
 *   - Name validation: empty and duplicate rejection
 *   - Palette shows the new subcircuit in SUBCIRCUIT category
 *
 * All DOM queries target the simulator directly (no iframe layer).
 * The test bridge (__test) is used ONLY for coordinate queries and state reads.
 */
import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a simple 2-input AND gate circuit through real UI interactions.
 * Layout: In A (5,10) → And (10,10) → Out Y (16,11), In B (5,12) → And
 *
 * Returns after all components are placed and wired.
 */
async function buildAndGateCircuit(builder: UICircuitBuilder): Promise<void> {
  await builder.placeLabeled('In', 5, 10, 'A');
  await builder.placeLabeled('In', 5, 12, 'B');
  await builder.placeLabeled('And', 10, 10, 'G1');
  await builder.placeLabeled('Out', 16, 11, 'Y');

  await builder.drawWire('A', 'out', 'G1', 'In_1');
  await builder.drawWire('B', 'out', 'G1', 'In_2');
  await builder.drawWire('G1', 'out', 'Y', 'in');
}

/**
 * Build a slightly larger circuit: In A → And → Not → Out Y, In B → And.
 * Selecting And + Not gives 3 boundary ports (2 inputs + 1 output).
 */
async function buildAndNotChainCircuit(builder: UICircuitBuilder): Promise<void> {
  await builder.placeLabeled('In', 3, 10, 'A');
  await builder.placeLabeled('In', 3, 12, 'B');
  await builder.placeLabeled('And', 8, 10, 'G1');
  await builder.placeLabeled('Not', 13, 11, 'G2');
  await builder.placeLabeled('Out', 18, 11, 'Y');

  await builder.drawWire('A', 'out', 'G1', 'In_1');
  await builder.drawWire('B', 'out', 'G1', 'In_2');
  await builder.drawWire('G1', 'out', 'G2', 'in');
  await builder.drawWire('G2', 'out', 'Y', 'in');
}

/**
 * Click on a labeled element's body center to select it.
 * Shift-click adds to selection without deselecting others.
 */
async function clickElement(
  builder: UICircuitBuilder,
  label: string,
  opts?: { shift?: boolean },
): Promise<void> {
  const info = await builder.getCircuitInfo();
  const el = info.elements.find(e => e.label === label || e.typeId === label);
  expect(el, `Element "${label}" not found`).toBeTruthy();
  const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
  if (opts?.shift) {
    await builder.page.keyboard.down('Shift');
    await builder.page.mouse.click(coords.x, coords.y);
    await builder.page.keyboard.up('Shift');
  } else {
    await builder.page.mouse.click(coords.x, coords.y);
  }
}

/**
 * Find a circuit element by typeId fragment (e.g. 'And', 'Subcircuit:').
 */
async function findElement(
  builder: UICircuitBuilder,
  typeFragment: string,
): Promise<{ label: string; typeId: string; center: { screenX: number; screenY: number }; pins: any[] } | undefined> {
  const info = await builder.getCircuitInfo();
  return info.elements.find(e => e.typeId.includes(typeFragment));
}

/**
 * Right-click on an element by its typeId fragment to open the context menu.
 */
async function rightClickElement(
  builder: UICircuitBuilder,
  typeIdOrLabel: string,
): Promise<void> {
  const info = await builder.getCircuitInfo();
  const el = info.elements.find(
    e => e.typeId.includes(typeIdOrLabel) || e.label === typeIdOrLabel,
  );
  expect(el, `Element matching "${typeIdOrLabel}" not found`).toBeTruthy();
  const coords = await builder.toPageCoords(el!.center.screenX, el!.center.screenY);
  await builder.page.mouse.click(coords.x, coords.y, { button: 'right' });
  await builder.page.waitForTimeout(200);
}

/**
 * Click a context menu item by its label text.
 */
async function clickMenuItem(builder: UICircuitBuilder, label: string): Promise<void> {
  const menuItem = builder.page.locator('.ctx-menu-item').filter({ hasText: label });
  await expect(menuItem).toBeVisible({ timeout: 3000 });
  await menuItem.click();
  await builder.page.waitForTimeout(300);
}

/**
 * Select two elements by their labels (click first, shift-click second).
 */
async function selectTwoByLabel(
  builder: UICircuitBuilder,
  label1: string,
  label2: string,
): Promise<void> {
  const info = await builder.getCircuitInfo();
  const el1 = info.elements.find(e => e.label === label1);
  const el2 = info.elements.find(e => e.label === label2);
  expect(el1, `Element with label "${label1}" not found`).toBeTruthy();
  expect(el2, `Element with label "${label2}" not found`).toBeTruthy();

  const c1 = await builder.toPageCoords(el1!.center.screenX, el1!.center.screenY);
  await builder.page.mouse.click(c1.x, c1.y);

  const c2 = await builder.toPageCoords(el2!.center.screenX, el2!.center.screenY);
  await builder.page.keyboard.down('Shift');
  await builder.page.mouse.click(c2.x, c2.y);
  await builder.page.keyboard.up('Shift');
  await builder.page.waitForTimeout(100);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Subcircuit workflow- full lifecycle', () => {
  let builder: UICircuitBuilder;

  test.beforeEach(async ({ page }) => {
    builder = new UICircuitBuilder(page);
    await builder.load();
  });

  // -------------------------------------------------------------------------
  // 1. Partial selection produces correct boundary ports in dialog
  // -------------------------------------------------------------------------

  test('partial selection shows correct boundary ports in the dialog', async () => {
    await buildAndNotChainCircuit(builder);

    // Select And + Not (partial selection- 2 elements, 3 boundary wires)
    await selectTwoByLabel(builder, 'G1', 'G2');

    // Right-click on the And gate
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Port table should have 3 rows (2 inputs from A/B + 1 output to Y)
    const portRows = dialog.locator('table tbody tr');
    await expect(portRows).toHaveCount(3);

    // Verify port labels appear in the input fields
    const labelInputs = dialog.locator('table tbody input[type="text"]');
    const labels: string[] = [];
    for (let i = 0; i < 3; i++) {
      labels.push(await labelInputs.nth(i).inputValue());
    }
    // Boundary wires touch And:In_1, And:In_2, Not:out- labels derived from pin labels
    expect(labels).toContain('In_1');
    expect(labels).toContain('In_2');
    expect(labels.some(l => l === 'out' || l === 'out_2')).toBe(true);

    // Verify bit widths are all 1
    const widthInputs = dialog.locator('table tbody input[type="number"]');
    for (let i = 0; i < 3; i++) {
      expect(await widthInputs.nth(i).inputValue()).toBe('1');
    }

    // Cancel
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });
  });

  // -------------------------------------------------------------------------
  // 2. Auto-name generation
  // -------------------------------------------------------------------------

  test('dialog auto-generates subcircuit_1 name', async () => {
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Name input should be pre-filled with subcircuit_1
    const nameInput = dialog.locator('input[type="text"]').first();
    expect(await nameInput.inputValue()).toBe('subcircuit_1');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  // -------------------------------------------------------------------------
  // 3. Name validation- empty and duplicate rejection
  // -------------------------------------------------------------------------

  test('Create button rejects empty name', async () => {
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Clear the auto-generated name
    const nameInput = dialog.locator('input[type="text"]').first();
    await nameInput.fill('');
    await builder.page.waitForTimeout(100);

    // Click Create- dialog should stay open (validation fails)
    await dialog.getByRole('button', { name: 'Create' }).click();
    await builder.page.waitForTimeout(200);
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  // -------------------------------------------------------------------------
  // 4. Changing pin face in dialog updates preview canvas
  // -------------------------------------------------------------------------

  test('changing a port face dropdown updates the chip preview', async () => {
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Capture preview canvas pixel checksum before face change
    const pixelsBefore = await builder.page.evaluate(() => {
      const canvas = document.querySelector('.subcircuit-dialog canvas') as HTMLCanvasElement | null;
      if (!canvas) return null;
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) return null;
      const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      return sum;
    });

    // Change the first face select from its current value to a different one
    const firstSelect = dialog.locator('table select').first();
    const currentValue = await firstSelect.inputValue();
    const newValue = currentValue === 'left' ? 'right' : 'left';
    await firstSelect.selectOption(newValue);
    await builder.page.waitForTimeout(200);

    const pixelsAfter = await builder.page.evaluate(() => {
      const canvas = document.querySelector('.subcircuit-dialog canvas') as HTMLCanvasElement | null;
      if (!canvas) return null;
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) return null;
      const data = ctx2d.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      return sum;
    });

    expect(pixelsBefore).not.toBeNull();
    expect(pixelsAfter).not.toBeNull();
    expect(pixelsAfter).not.toBe(pixelsBefore);

    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  // -------------------------------------------------------------------------
  // 5. Create subcircuit- replaces selection, correct pin count & dimensions
  // -------------------------------------------------------------------------

  test('creating a subcircuit replaces selection with correctly-sized chip', async () => {
    await buildAndNotChainCircuit(builder);
    const infoBefore = await builder.getCircuitInfo();
    expect(infoBefore.elementCount).toBe(5); // 2 In + And + Not + Out

    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Accept auto-name and create
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // And + Not removed, subcircuit instance added → fewer elements
    const infoAfter = await builder.getCircuitInfo();
    // 2 original In + 1 Out + 1 Subcircuit = 4
    expect(infoAfter.elementCount).toBe(4);

    // A Subcircuit-typed element must be present
    const subEl = infoAfter.elements.find(e => e.typeId.includes('Subcircuit'));
    expect(subEl).toBeTruthy();

    // The subcircuit instance must have 3 pins (matching the 3 boundary ports)
    expect(subEl!.pins.length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 6. Created subcircuit compiles and simulates correctly
  // -------------------------------------------------------------------------

  test('subcircuit compiles and passes test vectors', async () => {
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // The circuit is In A, In B → [subcircuit(And→Not)] → Out Y
    // Equivalent to NAND gate: Y = NOT(A AND B)
    // Run test vectors directly- this also exercises compilation.
    const result = await builder.runTestVectors('A B Y\n0 0 1\n0 1 1\n1 0 1\n1 1 0');
    expect(result.passed).toBe(4);
    expect(result.failed).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 7. Subcircuit appears in palette
  // -------------------------------------------------------------------------

  test('new subcircuit appears in the palette', async () => {
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    const nameInput = dialog.locator('input[type="text"]').first();
    await nameInput.fill('MyNAND');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // The palette should now contain an entry for "MyNAND"
    const paletteItem = builder.page.locator('.palette-component-name').filter({
      hasText: 'MyNAND',
    });
    // Search for it using the palette search to ensure it's findable
    const searchInput = builder.page.locator('.palette-search-input');
    await searchInput.fill('MyNAND');
    await builder.page.waitForTimeout(200);
    await expect(paletteItem.first()).toBeVisible({ timeout: 3000 });

    // Clear search
    await searchInput.fill('');
  });

  // -------------------------------------------------------------------------
  // 8. Double-click drill-down into subcircuit definition
  // -------------------------------------------------------------------------

  test('double-click on subcircuit navigates inside with breadcrumb', async () => {
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // Double-click the subcircuit instance to drill down
    const subEl = await findElement(builder, 'Subcircuit');
    expect(subEl).toBeTruthy();
    const coords = await builder.toPageCoords(subEl!.center.screenX, subEl!.center.screenY);
    // Click once to select, then double-click to navigate
    await builder.page.mouse.click(coords.x, coords.y);
    await builder.page.waitForTimeout(150);
    await builder.page.mouse.dblclick(coords.x, coords.y);
    await builder.page.waitForTimeout(500);

    // Breadcrumb should be visible showing the circuit hierarchy
    const breadcrumb = builder.page.locator('#circuit-breadcrumb');
    await expect(breadcrumb).toBeVisible({ timeout: 3000 });

    // Breadcrumb should show "Main > subcircuit_1" (we're inside subcircuit_1)
    const breadcrumbText = await breadcrumb.textContent();
    expect(breadcrumbText).toContain('Main');
    expect(breadcrumbText).toContain('subcircuit_1');

    // Verify getCircuitInfo() now reflects the subcircuit contents (And, Not, Port elements)
    const infoAfterDrillDown = await builder.getCircuitInfo();
    const typeIdsInside = infoAfterDrillDown.elements.map(e => e.typeId);
    expect(typeIdsInside.some(t => t.includes('And') || t.includes('NAnd'))).toBe(true);
    expect(typeIdsInside.some(t => t.includes('Port'))).toBe(true);

    // Navigate back by clicking the first breadcrumb entry ("Main")
    const mainCrumb = breadcrumb.locator('span').filter({ hasText: 'Main' });
    await mainCrumb.click();
    await builder.page.waitForTimeout(300);

    // Breadcrumb should be hidden (back at root)
    await expect(breadcrumb).not.toBeVisible({ timeout: 2000 });

    // Verify getCircuitInfo() now reflects the parent circuit (contains Subcircuit element)
    const infoAfterNav = await builder.getCircuitInfo();
    const typeIdsParent = infoAfterNav.elements.map(e => e.typeId);
    expect(typeIdsParent.some(t => t.includes('Subcircuit') || t.includes('subcircuit'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 9. Right-click "Open Subcircuit" navigates inside
  // -------------------------------------------------------------------------

  test('right-click "Open Subcircuit" navigates into definition', async () => {
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // Click the subcircuit to select it, then right-click
    const subEl = await findElement(builder, 'Subcircuit');
    expect(subEl).toBeTruthy();
    const coords = await builder.toPageCoords(subEl!.center.screenX, subEl!.center.screenY);
    await builder.page.mouse.click(coords.x, coords.y);
    await builder.page.waitForTimeout(100);
    await builder.page.mouse.click(coords.x, coords.y, { button: 'right' });
    await builder.page.waitForTimeout(200);

    // "Open Subcircuit" should be in the context menu
    await clickMenuItem(builder, 'Open Subcircuit');

    // Should now be inside the subcircuit- breadcrumb visible
    const breadcrumb = builder.page.locator('#circuit-breadcrumb');
    await expect(breadcrumb).toBeVisible({ timeout: 3000 });
    const breadcrumbText = await breadcrumb.textContent();
    expect(breadcrumbText).toContain('subcircuit_1');

    // Verify getCircuitInfo() reflects subcircuit contents (contains Port elements)
    const infoInside = await builder.getCircuitInfo();
    const typeIdsInside = infoInside.elements.map(e => e.typeId);
    expect(typeIdsInside.some(t => t.includes('Port'))).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 10. Right-click "Edit Symbol…" opens dialog with existing ports
  // -------------------------------------------------------------------------

  test('right-click "Edit Symbol…" re-opens dialog with existing port data', async () => {
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    let dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // Select the subcircuit, then right-click → Edit Symbol…
    const subEl = await findElement(builder, 'Subcircuit');
    expect(subEl).toBeTruthy();
    const coords = await builder.toPageCoords(subEl!.center.screenX, subEl!.center.screenY);
    await builder.page.mouse.click(coords.x, coords.y);
    await builder.page.waitForTimeout(100);
    await builder.page.mouse.click(coords.x, coords.y, { button: 'right' });
    await builder.page.waitForTimeout(200);

    await clickMenuItem(builder, 'Edit Symbol\u2026');

    dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // The dialog should show Port elements from the subcircuit definition
    const portRows = dialog.locator('table tbody tr');
    const rowCount = await portRows.count();
    expect(rowCount).toBe(3); // 3 Port elements inside the subcircuit

    // The name should be pre-filled with the existing name
    const nameInput = dialog.locator('input[type="text"]').first();
    expect(await nameInput.inputValue()).toBe('subcircuit_1');

    // Change a face and confirm- the subcircuit should update
    const firstFaceSelect = dialog.locator('table select').first();
    const curFace = await firstFaceSelect.inputValue();
    const newFace = curFace === 'left' ? 'right' : 'left';
    await firstFaceSelect.selectOption(newFace);
    await builder.page.waitForTimeout(100);

    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // Verify the subcircuit instance still exists and has updated pins
    const updatedSubEl = await findElement(builder, 'Subcircuit');
    expect(updatedSubEl).toBeTruthy();
    expect(updatedSubEl!.pins.length).toBe(3);
  });

  // -------------------------------------------------------------------------
  // 11. Undo restores original elements
  // -------------------------------------------------------------------------

  test('Ctrl+Z undoes subcircuit creation, restoring original elements', async () => {
    await buildAndNotChainCircuit(builder);
    const infoBefore = await builder.getCircuitInfo();
    expect(infoBefore.elementCount).toBe(5);

    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // Verify subcircuit was created
    const infoAfterCreate = await builder.getCircuitInfo();
    expect(infoAfterCreate.elements.some(e => e.typeId.includes('Subcircuit'))).toBe(true);

    // Undo
    await builder.undo();
    await builder.page.waitForTimeout(300);

    // Original elements should be restored
    const infoAfterUndo = await builder.getCircuitInfo();
    expect(infoAfterUndo.elementCount).toBe(infoBefore.elementCount);
    expect(infoAfterUndo.elements.some(e => e.typeId.includes('Subcircuit'))).toBe(false);
    expect(infoAfterUndo.elements.some(e => e.typeId === 'And')).toBe(true);
    expect(infoAfterUndo.elements.some(e => e.typeId === 'Not')).toBe(true);
  });

  // -------------------------------------------------------------------------
  // 12. Duplicate name is rejected
  // -------------------------------------------------------------------------

  test('duplicate subcircuit name is rejected by the dialog', async () => {
    // Build and create a first subcircuit
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    let dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    const nameInput = dialog.locator('input[type="text"]').first();
    await nameInput.fill('DupTest');
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // Now build a second pair of components and try to use the same name
    await builder.placeLabeled('And', 22, 10, 'H1');
    await builder.placeLabeled('Not', 26, 11, 'H2');
    await builder.drawWire('H1', 'out', 'H2', 'in');
    await builder.page.waitForTimeout(100);

    // Select H1 + H2
    await selectTwoByLabel(builder, 'H1', 'H2');

    // Right-click → Make Subcircuit
    await rightClickElement(builder, 'H1');
    await builder.page.waitForTimeout(200);
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Try to use the duplicate name
    const nameInput2 = dialog.locator('input[type="text"]').first();
    await nameInput2.fill('DupTest');
    await builder.page.waitForTimeout(100);

    // Click Create- should stay open because name is duplicate
    await dialog.getByRole('button', { name: 'Create' }).click();
    await builder.page.waitForTimeout(200);
    await expect(dialog).toBeVisible(); // Still open- validation failed

    // An error message should be visible about the duplicate name
    const errorSpan = dialog.locator('span').filter({ hasText: /already exists/ });
    await expect(errorSpan).toBeVisible();

    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  // -------------------------------------------------------------------------
  // 13. Auto-name increments for second subcircuit
  // -------------------------------------------------------------------------

  test('second subcircuit auto-names as subcircuit_2', async () => {
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    let dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });
    // Accept subcircuit_1
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // Place two more components and select them
    await builder.placeLabeled('Or', 22, 10, 'H1');
    await builder.placeLabeled('Not', 26, 11, 'H2');
    await builder.drawWire('H1', 'out', 'H2', 'in');

    await selectTwoByLabel(builder, 'H1', 'H2');
    await rightClickElement(builder, 'H1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Should auto-name as subcircuit_2
    const nameInput = dialog.locator('input[type="text"]').first();
    expect(await nameInput.inputValue()).toBe('subcircuit_2');

    await dialog.getByRole('button', { name: 'Cancel' }).click();
  });

  // -------------------------------------------------------------------------
  // 14. Chip has correct pin assignments on both sides
  // -------------------------------------------------------------------------

  test('subcircuit chip has pins distributed on left and right faces', async () => {
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Verify the face assignments: In_1 and In_2 should be on left,
    // out should be on right (based on centroid-relative positioning)
    const faceSelects = dialog.locator('table select');
    const faceCount = await faceSelects.count();
    expect(faceCount).toBe(3);

    // Collect face values
    const faces: string[] = [];
    for (let i = 0; i < faceCount; i++) {
      faces.push(await faceSelects.nth(i).inputValue());
    }
    // Should have at least one 'left' and one 'right' (not all on same side)
    expect(faces.includes('left') || faces.includes('top')).toBe(true);
    expect(faces.includes('right') || faces.includes('bottom')).toBe(true);

    // Create the subcircuit
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // Verify the subcircuit instance has pins on both sides of its body
    const subEl = await findElement(builder, 'Subcircuit');
    expect(subEl).toBeTruthy();

    // Pins should not all share the same x-coordinate (would mean all on one side)
    const pinXs = subEl!.pins.map(p => p.screenX);
    const uniqueX = new Set(pinXs);
    expect(uniqueX.size).toBeGreaterThan(1);
  });

  // -------------------------------------------------------------------------
  // 15. Modified face assignments change chip pin positions
  // -------------------------------------------------------------------------

  test('moving all ports to left face puts all pins on the left side', async () => {
    await buildAndNotChainCircuit(builder);
    await selectTwoByLabel(builder, 'G1', 'G2');
    await rightClickElement(builder, 'G1');
    await clickMenuItem(builder, 'Make Subcircuit\u2026');

    const dialog = builder.page.locator('.subcircuit-dialog');
    await expect(dialog).toBeVisible({ timeout: 3000 });

    // Force all face selects to 'left'
    const faceSelects = dialog.locator('table select');
    const faceCount = await faceSelects.count();
    for (let i = 0; i < faceCount; i++) {
      await faceSelects.nth(i).selectOption('left');
    }
    await builder.page.waitForTimeout(100);

    // Create
    await dialog.getByRole('button', { name: 'Create' }).click();
    await expect(dialog).not.toBeVisible({ timeout: 2000 });

    // All pins should be on the left side of the chip (same x-coordinate)
    const subEl = await findElement(builder, 'Subcircuit');
    expect(subEl).toBeTruthy();
    const pinXs = subEl!.pins.map(p => p.screenX);
    const uniqueX = new Set(pinXs);
    // All on left side = 1 unique x coordinate
    expect(uniqueX.size).toBe(1);
  });
});

/**
 * Temporary headed debug tests — run with:
 *   npx playwright test e2e/gui/debug-failures.spec.ts --headed --workers=1
 *
 * Each test pauses at the point of failure so you can inspect UI state.
 * Delete this file once investigations are complete.
 */
import { test, expect } from '@playwright/test';
import { UICircuitBuilder } from '../fixtures/ui-circuit-builder';

test.describe('Debug: And gate compile error (Cat B)', () => {
  test('And at bitWidth=1 — pause before verifyNoErrors', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    // Place And gate
    await builder.placeLabeled('And', 10, 8, 'DUT');

    // Resolve display label for bitWidth
    const propLabel = await builder.resolvePropertyLabel('And', 'bitWidth');
    console.log('Resolved propLabel for bitWidth:', propLabel);

    // Set bitWidth = 1 (the default — should be no-op)
    await builder.setComponentProperty('DUT', propLabel, 1);

    // Place SRC In, wire to And
    const bitsLabel = await builder.resolvePropertyLabel('In', 'bitWidth');
    await builder.placeLabeled('In', 3, 8, 'SRC');
    await builder.setComponentProperty('SRC', bitsLabel, 1);
    await builder.drawWire('SRC', 'out', 'DUT', 'In_1');

    // Place DST Out, wire from And
    await builder.placeLabeled('Out', 18, 8, 'DST');
    await builder.setComponentProperty('DST', bitsLabel, 1);
    await builder.drawWire('DUT', 'out', 'DST', 'in');

    // Step — this triggers compile
    await builder.stepViaUI();

    // PAUSE HERE — inspect status bar for error message
    console.log('=== PAUSING: Check status bar for error ===');
    await page.pause();

    await builder.verifyNoErrors();
  });
});

test.describe('Debug: Subcircuit dialog (Cat E)', () => {
  test('create subcircuit from selection — pause before dialog check', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    // Place two components
    await builder.placeLabeled('And', 8, 8, 'G1');
    await builder.placeLabeled('Not', 14, 8, 'G2');

    // Wire them
    await builder.drawWire('G1', 'out', 'G2', 'in');

    // Select both (shift-click)
    const info = await builder.getCircuitInfo();
    const g1 = info.elements.find(e => e.label === 'G1')!;
    const g2 = info.elements.find(e => e.label === 'G2')!;

    const c1 = await builder.toPageCoords(g1.center.screenX, g1.center.screenY);
    const c2 = await builder.toPageCoords(g2.center.screenX, g2.center.screenY);

    await page.mouse.click(c1.x, c1.y);
    await page.keyboard.down('Shift');
    await page.mouse.click(c2.x, c2.y);
    await page.keyboard.up('Shift');
    await page.waitForTimeout(300);

    // Right-click on G1
    await page.mouse.click(c1.x, c1.y, { button: 'right' });
    await page.waitForTimeout(200);

    // PAUSE HERE — check if context menu has "Make Subcircuit..." option
    console.log('=== PAUSING: Check context menu for Make Subcircuit... ===');
    await page.pause();
  });
});

test.describe('Debug: NOr placement count (Cat B)', () => {
  test('place NOr — pause after placement', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    const before = await builder.getCircuitInfo();
    console.log('Element count before:', before.elementCount);

    await builder.placeComponent('NOr', 10, 8);

    const after = await builder.getCircuitInfo();
    console.log('Element count after:', after.elementCount);

    // PAUSE HERE — check if NOr was actually placed on canvas
    console.log('=== PAUSING: Verify NOr appeared on canvas ===');
    await page.pause();

    expect(after.elementCount).toBe(before.elementCount + 1);
  });
});

test.describe('Debug: Hotload params analog null (Cat C)', () => {
  test('BJT circuit — pause after stepAndReadAnalog returns', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    // Build BJT common-emitter circuit
    await builder.placeLabeled('DcVoltageSource', 7, 5, 'Vcc');
    await builder.placeLabeled('CurrentSource', 7, 12, 'Ib');
    await builder.placeLabeled('Resistor', 14, 5, 'Rc');
    await builder.placeLabeled('NpnBJT', 16, 9, 'Q1');
    await builder.placeComponent('Ground', 11, 16);
    await builder.placeComponent('Ground', 18, 16);
    await builder.placeComponent('Ground', 11, 9);
    await builder.placeLabeled('Probe', 22, 7, 'Pc');

    await builder.setComponentProperty('Vcc', 'voltage', 12);
    await builder.setComponentProperty('Ib', 'current', 0.00005);
    await builder.setComponentProperty('Rc', 'resistance', 10000);

    await builder.drawWire('Vcc', 'pos', 'Rc', 'A');
    await builder.drawWire('Rc', 'B', 'Q1', 'C');
    await builder.drawWire('Ib', 'pos', 'Q1', 'B');
    await builder.drawWireFromPin('Q1', 'E', 18, 16);
    await builder.drawWireFromPin('Vcc', 'neg', 11, 16);
    await builder.drawWireFromPin('Ib', 'neg', 11, 9);
    await builder.drawWire('Rc', 'B', 'Pc', 'in');

    // Step once — should compile
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Check analog state before 200 steps
    const preState = await builder.getAnalogState();
    console.log('Pre-state (after 1 step):', JSON.stringify(preState));

    // Now do the 200 steps
    const result = await builder.stepAndReadAnalog('5m');
    console.log('stepAndReadAnalog(200) result:', JSON.stringify(result));

    // PAUSE — inspect console for null vs valid state
    console.log('=== PAUSING: Check console output for analog state ===');
    await page.pause();

    expect(result).not.toBeNull();
  });
});

test.describe('Debug: Master 3 circuit layout', () => {
  test('Master 3 — pause after wiring to verify layout', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    // --- DAC inputs (col 3) ---
    await builder.placeLabeled('Const', 3, 8, 'D0');
    await builder.setComponentProperty('D0', 'value', 0);
    await builder.placeLabeled('Const', 3, 11, 'D1');
    await builder.setComponentProperty('D1', 'value', 1);
    await builder.placeLabeled('Const', 3, 14, 'D2');
    await builder.setComponentProperty('D2', 'value', 0);
    await builder.placeLabeled('Const', 3, 18, 'D3');
    await builder.setComponentProperty('D3', 'value', 1);

    await builder.placeLabeled('DAC', 15, 15, 'DAC1');
    await builder.setComponentProperty('DAC1', 'Resolution (bits)', 4);

    await builder.placeLabeled('DcVoltageSource', 8, 3, 'Vref');
    await builder.placeComponent('Ground', 8, 8);
    await builder.placeComponent('Ground', 17, 22);

    await builder.placeLabeled('Resistor', 25, 15, 'R1');
    await builder.placeLabeled('Capacitor', 33, 15, 'C1');
    await builder.placeComponent('Ground', 37, 16);
    await builder.placeLabeled('Probe', 31, 13, 'P_DAC');

    await builder.placeLabeled('VoltageComparator', 33, 19, 'CMP');
    await builder.placeLabeled('DcVoltageSource', 25, 21, 'Vref2');
    await builder.setComponentProperty('Vref2', 'voltage', 2.5);
    await builder.placeComponent('Ground', 25, 24);

    await builder.placeLabeled('And', 38, 18, 'GA');
    await builder.placeLabeled('Const', 38, 20, 'C_EN');
    await builder.placeLabeled('Clock', 34, 24, 'CLK');
    await builder.placeLabeled('Counter', 44, 18, 'CNT');
    await builder.placeLabeled('Out', 48, 18, 'Q');

    // Wiring
    await builder.drawWireFromPinExplicit('Vref', 'neg', 8, 8);
    await builder.drawWireExplicit('Vref', 'pos', 'DAC1', 'VREF', [[17, 3]]);
    await builder.drawWireFromPinExplicit('DAC1', 'GND', 17, 22);

    await builder.drawWireExplicit('D3', 'out', 'DAC1', 'D3');
    await builder.drawWireExplicit('DAC1', 'D2', 'D2', 'out', [[13, 15], [11, 14], [11, 15]]);
    await builder.drawWireExplicit('DAC1', 'D1', 'D1', 'out', [[12, 14], [12, 11]]);
    await builder.drawWireExplicit('D0', 'out', 'DAC1', 'D0', [[5, 8], [5, 10], [13, 10], [13, 13]]);

    await builder.drawWireExplicit('R1', 'A', 'DAC1', 'OUT');
    await builder.drawWireExplicit('R1', 'B', 'C1', 'pos');
    await builder.drawWireFromPinExplicit('P_DAC', 'in', 31, 15);
    await builder.drawWireFromPinExplicit('CMP', 'in-', 29, 15, [[29, 20]]);
    await builder.drawWireFromPinExplicit('C1', 'neg', 37, 16);
    await builder.drawWireExplicit('CMP', 'out', 'GA', 'In_1', [[37, 18]]);
    await builder.drawWireExplicit('CMP', 'in+', 'Vref2', 'pos', [[30, 18], [30, 21]]);
    await builder.drawWireFromPinExplicit('Vref2', 'neg', 25, 24);
    await builder.drawWireExplicit('C_EN', 'out', 'GA', 'In_2');
    await builder.drawWireExplicit('GA', 'out', 'CNT', 'en', [[42, 19], [42, 18]]);
    await builder.drawWireExplicit('CLK', 'out', 'CNT', 'C', [[43, 24], [43, 19]]);
    await builder.drawWireExplicit('CNT', 'out', 'Q', 'in');

    console.log('=== PAUSING: Verify Master 3 circuit layout ===');
    await page.pause();
  });
});

test.describe('Debug: Master 2 circuit layout', () => {
  test('Master 2 — pause before assertions to verify layout', async ({ page }) => {
    const builder = new UICircuitBuilder(page);
    await builder.load();

    // Full Master 2: switched divider, RC, opamp, BJT
    await builder.placeLabeled('DcVoltageSource', 3, 3, 'Vs');
    await builder.placeLabeled('In', 3, 7, 'CTRL');
    await builder.placeLabeled('SwitchSPST', 12, 3, 'SW');
    await builder.placeLabeled('Resistor', 20, 3, 'R1');
    await builder.setComponentProperty('R1', 'resistance', 10000);
    await builder.placeLabeled('Resistor', 28, 3, 'R2');
    await builder.setComponentProperty('R2', 'resistance', 10000);
    await builder.placeComponent('Ground', 3, 4);
    await builder.placeComponent('Ground', 32, 8);
    await builder.placeLabeled('Probe', 26, 1, 'P_DIV');

    await builder.placeLabeled('Resistor', 20, 11, 'R3');
    await builder.placeLabeled('Capacitor', 28, 11, 'C1');
    await builder.placeComponent('Ground', 32, 12);
    await builder.placeLabeled('Probe', 26, 9, 'P_RC');

    await builder.placeLabeled('OpAmp', 28, 19, 'AMP');
    await builder.placeLabeled('Probe', 36, 19, 'P_AMP');

    await builder.placeLabeled('Resistor', 20, 25, 'Rb');
    await builder.setComponentProperty('Rb', 'resistance', 100000);
    await builder.placeLabeled('NpnBJT', 28, 25, 'Q1');
    await builder.placeLabeled('Resistor', 36, 24, 'Rc');
    await builder.setComponentProperty('Rc', 'resistance', 1000);
    await builder.placeLabeled('DcVoltageSource', 36, 30, 'Vcc');
    await builder.setComponentProperty('Vcc', 'voltage', 12);
    await builder.placeComponent('Ground', 32, 30);
    await builder.placeLabeled('Probe', 44, 23, 'P_CE');

    // Wiring
    await builder.drawWireExplicit('Vs', 'pos', 'SW', 'in');
    await builder.drawWireExplicit('CTRL', 'out', 'SW', 'ctrl', [[14, 7]]);
    await builder.drawWireExplicit('SW', 'out', 'R1', 'A');
    await builder.drawWireFromPinExplicit('R2', 'B', 32, 8);
    await builder.drawWireFromPinExplicit('Vs', 'neg', 3, 4);
    await builder.drawWireExplicit('R1', 'B', 'R2', 'A');
    await builder.drawWireFromPinExplicit('P_DIV', 'in', 26, 3);
    await builder.drawWireFromPinExplicit('R3', 'A', 26, 3, [[18, 11], [18, 7], [26, 7]]);
    await builder.drawWireExplicit('R3', 'B', 'C1', 'pos');
    await builder.drawWireFromPinExplicit('C1', 'neg', 32, 12);
    await builder.drawWireFromPinExplicit('P_RC', 'in', 26, 11);
    await builder.drawWireFromPinExplicit('AMP', 'in+', 26, 11, [[26, 20]]);
    await builder.drawWireExplicit('AMP', 'in-', 'AMP', 'out', [[27, 18], [27, 15], [35, 15], [35, 19]]);
    await builder.drawWireFromPinExplicit('P_AMP', 'in', 35, 19);
    await builder.drawWireFromPinExplicit('Rb', 'A', 35, 19, [[19, 25], [19, 23], [35, 23]]);
    await builder.drawWireExplicit('Rb', 'B', 'Q1', 'B');
    await builder.drawWireExplicit('Q1', 'C', 'Rc', 'A');
    await builder.drawWireFromPinExplicit('P_CE', 'in', 36, 24, [[36, 23]]);
    await builder.drawWireExplicit('Rc', 'B', 'Vcc', 'pos');
    await builder.drawWireFromPinExplicit('Q1', 'E', 32, 30);
    await builder.drawWireFromPinExplicit('Vcc', 'neg', 32, 30);

    // Compile
    await builder.stepViaUI();
    await builder.verifyNoErrors();

    // Toggle CTRL
    await builder.stepViaUI();
    await builder.clickGrid(2, 7);

    // Step to 50ms
    await builder.stepToTimeViaUI('50m');

    const signals = await builder.readAllSignals();
    console.log('Master 2 signals:', JSON.stringify(signals));

    console.log('=== PAUSING: Verify Master 2 circuit and voltages ===');
    await page.pause();
  });
});


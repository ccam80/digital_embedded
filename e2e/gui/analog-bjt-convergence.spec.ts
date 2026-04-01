/**
 * E2E regression test — BJT buck converter convergence.
 *
 * Loads fixtures/buckbjt.dts via postMessage (same as a user opening a file),
 * clicks Step (which triggers compileAndBind + coordinator.step), and verifies
 * that no convergence error appears in the status bar.
 *
 * This is a true GUI interaction test — no mode switching, no bridge hacks.
 * The unified compiler auto-detects analog from the circuit's components.
 *
 * Regression: BJT updateOperatingPoint wrote back pnjlim-limited Vbe without
 * adjusting Vbc, corrupting the companion model and causing NR divergence.
 *
 * The circuit contains a 10V DC supply driving NPN/PNP BJTs, NMOS, passives,
 * and a freewheeling diode. Probes: V_SUPPLY, V_SWITCH, V_OUT.
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const fixturesDir = resolve(__dirname, '../../fixtures');

/** Probe labels present in the buckbjt.dts fixture. */
const PROBE_LABELS = ['V_SUPPLY', 'V_SWITCH', 'V_OUT'] as const;

/**
 * Maximum absolute voltage we expect from a 10V-supply BJT buck converter.
 * The inductor can overshoot during switching transients, but anything beyond
 * 50V indicates a diverged Newton-Raphson iteration, not a real circuit state.
 */
const MAX_VOLTAGE = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function clickIframeButton(harness: SimulatorHarness, buttonId: string): Promise<void> {
  await harness.page.evaluate((id) => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    iframe.contentWindow!.document.getElementById(id)?.click();
  }, buttonId);
}

/** Read the status bar text inside the simulator iframe. */
async function getStatusText(harness: SimulatorHarness): Promise<string> {
  return harness.page.evaluate(() => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    const el = iframe.contentWindow!.document.getElementById('status-bar')
      ?? iframe.contentWindow!.document.querySelector('.status-bar')
      ?? iframe.contentWindow!.document.querySelector('[class*="status"]');
    return el?.textContent?.trim() ?? '';
  });
}

/** Check if the status bar shows an error (red/error class or error keywords). */
async function hasStatusError(harness: SimulatorHarness): Promise<boolean> {
  return harness.page.evaluate(() => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    const doc = iframe.contentWindow!.document;
    // Check for status bar with error class
    const statusEl = doc.getElementById('status-bar')
      ?? doc.querySelector('.status-bar')
      ?? doc.querySelector('[class*="status"]');
    if (!statusEl) return false;
    const text = statusEl.textContent?.toLowerCase() ?? '';
    const hasErrorClass = statusEl.classList.contains('error')
      || statusEl.classList.contains('status-error');
    return hasErrorClass || /converg|error|failed|singular/i.test(text);
  });
}

/**
 * Evaluate an expression against the test bridge inside the simulator iframe.
 * The expression receives `bridge` (the `window.__test` object) as its argument.
 */
function bridgeEval<T>(harness: SimulatorHarness, expr: string): Promise<T> {
  return harness.page.evaluate((code) => {
    const iframe = document.getElementById('sim') as HTMLIFrameElement;
    const bridge = (iframe.contentWindow as any).__test;
    return new Function('bridge', `return ${code}`)(bridge);
  }, expr) as Promise<T>;
}

/** Shorthand: read the analog engine state via the test bridge. */
async function getAnalogState(harness: SimulatorHarness): Promise<{
  simTime: number;
  nodeVoltages: Record<string, number>;
  nodeCount: number;
} | null> {
  return bridgeEval(harness, 'bridge.getAnalogState()');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('BJT buck converter convergence', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
    await harness.iframe.locator('#sim-canvas').waitFor({ state: 'visible' });
    await page.waitForTimeout(500);
  });

  test('load buckbjt.dts and step — no convergence error, voltages sane', async () => {
    // Load the fixture exactly as a user would (via postMessage)
    const xml = readFileSync(resolve(fixturesDir, 'buckbjt.dts'), 'utf-8');
    await harness.loadDigXml(xml);

    // Click Step — this triggers compileAndBind() then coordinator.step()
    // On first load, compileAndBind auto-detects analog via facade.compile()
    await clickIframeButton(harness, 'btn-step');
    await harness.page.waitForTimeout(500);

    // The status bar should NOT show a convergence error
    const statusText = await getStatusText(harness);
    const hasError = await hasStatusError(harness);
    expect(hasError, `Status bar shows error: "${statusText}"`).toBe(false);

    // Read analog state from the test bridge
    const state = await getAnalogState(harness);
    expect(state, 'Analog engine should be active after stepping an analog circuit').not.toBeNull();

    // simTime must be finite and positive (the engine advanced at least one timestep)
    expect(Number.isFinite(state!.simTime), `simTime is not finite: ${state!.simTime}`).toBe(true);
    expect(state!.simTime).toBeGreaterThan(0);

    // The compiled circuit should expose labeled probe nodes
    const voltageKeys = Object.keys(state!.nodeVoltages);
    expect(voltageKeys.length, 'nodeVoltages should not be empty').toBeGreaterThan(0);

    // Every node voltage must be finite (no NaN/Infinity from diverged NR)
    for (const [label, v] of Object.entries(state!.nodeVoltages)) {
      expect(Number.isFinite(v), `Voltage at "${label}" is not finite: ${v}`).toBe(true);
      expect(Math.abs(v), `Voltage at "${label}" out of range: ${v}V`).toBeLessThanOrEqual(MAX_VOLTAGE);
    }

    // Probe labels from the fixture should appear in the voltage map
    for (const probe of PROBE_LABELS) {
      expect(voltageKeys, `Expected probe "${probe}" in nodeVoltages`).toContain(probe);
    }
  });

  test('load buckbjt.dts and run briefly — voltages remain bounded', async () => {
    const xml = readFileSync(resolve(fixturesDir, 'buckbjt.dts'), 'utf-8');
    await harness.loadDigXml(xml);

    // Step once first to trigger compilation (same pattern as analog-ui-fixup)
    await clickIframeButton(harness, 'btn-step');
    await harness.page.waitForTimeout(300);

    // Now run continuously
    await clickIframeButton(harness, 'btn-run');
    await harness.page.waitForTimeout(600);

    // Snapshot analog state while the engine is still alive (before stop)
    const state = await getAnalogState(harness);

    // Now stop
    await clickIframeButton(harness, 'btn-stop');
    await harness.page.waitForTimeout(200);

    const statusText = await getStatusText(harness);
    const hasError = await hasStatusError(harness);
    expect(hasError, `Status bar shows error: "${statusText}"`).toBe(false);

    // The engine should have been active during the run
    expect(state, 'Analog engine should be active during run (read before stop)').not.toBeNull();
    expect(Number.isFinite(state!.simTime), `simTime is not finite: ${state!.simTime}`).toBe(true);
    expect(state!.simTime, 'simTime should have advanced meaningfully during run').toBeGreaterThan(0);

    // All voltages finite and bounded — no NR divergence during continuous run
    for (const [label, v] of Object.entries(state!.nodeVoltages)) {
      expect(Number.isFinite(v), `Voltage at "${label}" is not finite after run: ${v}`).toBe(true);
      expect(Math.abs(v), `Voltage at "${label}" out of range after run: ${v}V`).toBeLessThanOrEqual(MAX_VOLTAGE);
    }

    // Probe nodes must still be present
    const voltageKeys = Object.keys(state!.nodeVoltages);
    for (const probe of PROBE_LABELS) {
      expect(voltageKeys, `Expected probe "${probe}" after run`).toContain(probe);
    }
  });

  test('load buckbjt.dts and step 20 times — all voltages finite and evolving', async () => {
    const xml = readFileSync(resolve(fixturesDir, 'buckbjt.dts'), 'utf-8');
    await harness.loadDigXml(xml);

    // Step once to compile, then read initial state
    await clickIframeButton(harness, 'btn-step');
    await harness.page.waitForTimeout(300);

    const stateAfter1 = await getAnalogState(harness);
    expect(stateAfter1, 'Analog engine should be active after first step').not.toBeNull();
    const timeAfter1 = stateAfter1!.simTime;

    // Step 19 more times (total 20)
    for (let i = 0; i < 19; i++) {
      await clickIframeButton(harness, 'btn-step');
    }
    await harness.page.waitForTimeout(300);

    // No error in status bar
    const hasError = await hasStatusError(harness);
    const statusText = await getStatusText(harness);
    expect(hasError, `Status bar shows error: "${statusText}"`).toBe(false);

    const stateAfter20 = await getAnalogState(harness);
    expect(stateAfter20, 'Analog engine should be active after 20 steps').not.toBeNull();

    // simTime must have advanced from step 1 to step 20
    expect(stateAfter20!.simTime).toBeGreaterThan(timeAfter1);

    // All voltages finite and bounded at every probe
    const voltageKeys = Object.keys(stateAfter20!.nodeVoltages);
    for (const [label, v] of Object.entries(stateAfter20!.nodeVoltages)) {
      expect(Number.isFinite(v), `Voltage at "${label}" is not finite after 20 steps: ${v}`).toBe(true);
      expect(Math.abs(v), `Voltage at "${label}" out of range after 20 steps: ${v}V`).toBeLessThanOrEqual(MAX_VOLTAGE);
    }

    // Probe labels must be present
    for (const probe of PROBE_LABELS) {
      expect(voltageKeys, `Expected probe "${probe}" after 20 steps`).toContain(probe);
    }

    // At least one probe voltage should have changed between step 1 and step 20.
    // The circuit has an AC driving source, so transient voltages must evolve.
    const voltagesAfter1 = stateAfter1!.nodeVoltages;
    const voltagesAfter20 = stateAfter20!.nodeVoltages;
    const anyChanged = PROBE_LABELS.some(
      p => voltagesAfter1[p] !== undefined
        && voltagesAfter20[p] !== undefined
        && voltagesAfter1[p] !== voltagesAfter20[p],
    );
    expect(anyChanged, 'At least one probe voltage should change over 20 steps (transient sim)').toBe(true);
  });
});

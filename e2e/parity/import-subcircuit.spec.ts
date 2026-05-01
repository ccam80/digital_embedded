/**
 * Parity tests- sim-import-subcircuit via postMessage.
 *
 * These catch the blind spot where the headless facade works but the browser
 * wiring (postMessage handler, subcircuit registration, serialization) fails.
 *
 * Three behaviours under test:
 *   1. Happy path- valid DTS JSON payload yields sim-subcircuit-imported with
 *      the correct name and pin list.
 *   2. Error path- missing name/data fields yield sim-error.
 *   3. Round-trip- importing multiple subcircuits yields distinct responses.
 */
import { test, expect } from '@playwright/test';
import { SimulatorHarness } from '../fixtures/simulator-harness';

// ---------------------------------------------------------------------------
// Minimal DTS JSON helpers
// ---------------------------------------------------------------------------

/**
 * Build a DTS JSON string for a subcircuit that has the given input and output
 * pin labels.  Uses the built-in In / Out element types so no extra component
 * registration is needed.
 */
function makeSubcircuitDts(
  name: string,
  inputLabels: string[],
  outputLabels: string[],
): string {
  const elements: object[] = [];
  let x = 0;

  for (const label of inputLabels) {
    elements.push({
      type: 'In',
      id: `in_${label}`,
      position: { x, y: 0 },
      rotation: 0,
      properties: { label, bitWidth: 1 },
    });
    x += 100;
  }

  for (const label of outputLabels) {
    elements.push({
      type: 'Out',
      id: `out_${label}`,
      position: { x, y: 0 },
      rotation: 0,
      properties: { label, bitWidth: 1 },
    });
    x += 100;
  }

  return JSON.stringify({
    format: 'dts',
    version: 1,
    circuit: {
      name,
      elements,
      wires: [],
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe('Parity: sim-import-subcircuit via postMessage', () => {
  let harness: SimulatorHarness;

  test.beforeEach(async ({ page }) => {
    harness = new SimulatorHarness(page);
    await harness.load();
  });

  test('imports subcircuit and responds with name and pin list', async () => {
    const dts = makeSubcircuitDts('AndChip', ['A', 'B'], ['Y']);

    await harness.postToSim({
      type: 'sim-import-subcircuit',
      name: 'AndChip',
      data: dts,
    });

    const msg = await harness.waitForMessage<{
      type: 'sim-subcircuit-imported';
      name: string;
      pins: string[];
    }>('sim-subcircuit-imported');

    expect(msg.name).toBe('AndChip');
    // Pin list must contain all declared interface labels
    expect(msg.pins).toContain('A');
    expect(msg.pins).toContain('B');
    expect(msg.pins).toContain('Y');
  });

  test('pins array length matches number of declared interface pins', async () => {
    const dts = makeSubcircuitDts('TwoInputOneOutput', ['X', 'Y'], ['Z']);

    await harness.postToSim({
      type: 'sim-import-subcircuit',
      name: 'TwoInputOneOutput',
      data: dts,
    });

    const msg = await harness.waitForMessage<{
      type: 'sim-subcircuit-imported';
      name: string;
      pins: string[];
    }>('sim-subcircuit-imported');

    expect(msg.pins).toHaveLength(3); // X, Y, Z
  });

  test('missing name field returns sim-error', async () => {
    const dts = makeSubcircuitDts('SomeChip', ['A'], ['Q']);

    // Deliberately omit the name field
    await harness.postToSim({
      type: 'sim-import-subcircuit',
      name: '',
      data: dts,
    });

    const msg = await harness.waitForMessage<{ type: string; error: string }>(
      'sim-error',
    );
    expect(msg.error).toBeTruthy();
  });

  test('missing data field returns sim-error', async () => {
    // Deliberately omit the data field
    await harness.postToSim({
      type: 'sim-import-subcircuit',
      name: 'SomeChip',
      data: '',
    });

    const msg = await harness.waitForMessage<{ type: string; error: string }>(
      'sim-error',
    );
    expect(msg.error).toBeTruthy();
  });

  test('malformed DTS JSON data returns sim-error', async () => {
    await harness.postToSim({
      type: 'sim-import-subcircuit',
      name: 'BadChip',
      data: '{ not valid json %%%',
    });

    const msg = await harness.waitForMessage<{ type: string; error: string }>(
      'sim-error',
    );
    expect(msg.error).toBeTruthy();
  });

  test('importing multiple subcircuits yields distinct sim-subcircuit-imported responses', async () => {
    const dtsA = makeSubcircuitDts('ChipA', ['A'], ['QA']);
    const dtsB = makeSubcircuitDts('ChipB', ['B'], ['QB']);

    await harness.postToSim({
      type: 'sim-import-subcircuit',
      name: 'ChipA',
      data: dtsA,
    });
    const msgA = await harness.waitForMessage<{
      type: 'sim-subcircuit-imported';
      name: string;
      pins: string[];
    }>('sim-subcircuit-imported');

    await harness.postToSim({
      type: 'sim-import-subcircuit',
      name: 'ChipB',
      data: dtsB,
    });
    const msgB = await harness.waitForMessage<{
      type: 'sim-subcircuit-imported';
      name: string;
      pins: string[];
    }>('sim-subcircuit-imported');

    expect(msgA.name).toBe('ChipA');
    expect(msgA.pins).toContain('A');
    expect(msgA.pins).toContain('QA');

    expect(msgB.name).toBe('ChipB');
    expect(msgB.pins).toContain('B');
    expect(msgB.pins).toContain('QB');
  });
});

/**
 * SimulatorHarness — Playwright helper for interacting with the simulator
 * via the postMessage API through the harness.html iframe wrapper.
 *
 * IMPORTANT: The actual postMessage API in app-init.ts uses these types:
 *   - sim-load-url, sim-load-data → sim-loaded
 *   - sim-test (with testData field) → sim-test-result
 *   - sim-get-circuit → sim-circuit-data
 *   - sim-set-base, sim-set-locked, sim-set-palette → sim-loaded
 *   - sim-highlight, sim-clear-highlight
 *   - sim-set-readonly-components, sim-set-instructions
 *
 * NOTE: sim-set-input, sim-step, sim-read-output, sim-read-all-signals
 * are defined in PostMessageAdapter but NOT wired in app-init.ts.
 */
import type { Page } from '@playwright/test';

export interface TestResultMessage {
  type: 'sim-test-result';
  passed: number;
  failed: number;
  total: number;
  details: Array<{
    passed: boolean;
    inputs: Record<string, number>;
    expected: Record<string, number>;
    actual: Record<string, number>;
  }>;
}

export class SimulatorHarness {
  constructor(readonly page: Page) {}

  /** Navigate to the harness page and wait for the simulator to be ready. */
  async load(): Promise<void> {
    await this.page.goto('/e2e/fixtures/harness.html');
    await this.page.waitForFunction(
      () => document.getElementById('sim') !== null,
      { timeout: 10_000 },
    );
    await this.waitForMessage('sim-ready');
  }

  /** Send a postMessage to the simulator iframe. */
  async postToSim(msg: Record<string, unknown>): Promise<void> {
    await this.page.evaluate((m) => {
      (window as any).__postToSim(m);
    }, msg);
  }

  /** Wait for a specific message type from the simulator. */
  async waitForMessage<T = Record<string, unknown>>(
    type: string,
    timeoutMs = 10_000,
  ): Promise<T> {
    return this.page.evaluate(
      ({ type, timeoutMs }) => (window as any).__waitForMessage(type, timeoutMs),
      { type, timeoutMs },
    ) as Promise<T>;
  }

  /** Load a .dig XML string into the simulator via base64 encoding. */
  async loadDigXml(xml: string): Promise<void> {
    const b64 = Buffer.from(xml, 'utf-8').toString('base64');
    await this.postToSim({ type: 'sim-load-data', data: b64 });
    await this.waitForMessage('sim-loaded');
  }

  /** Load a circuit from a URL (relative to the server root). */
  async loadDigUrl(url: string): Promise<void> {
    await this.postToSim({ type: 'sim-load-url', url });
    await this.waitForMessage('sim-loaded');
  }

  /**
   * Run test vectors against the loaded circuit.
   * Uses the actual `sim-test` message type (not `sim-run-tests`).
   */
  async runTests(testData: string): Promise<TestResultMessage> {
    await this.postToSim({ type: 'sim-test', testData });
    return this.waitForMessage<TestResultMessage>('sim-test-result');
  }

  /** Export the current circuit as base64-encoded .dig XML. */
  async getCircuit(): Promise<string> {
    await this.postToSim({ type: 'sim-get-circuit' });
    const msg = await this.waitForMessage<{
      type: 'sim-circuit-data';
      data: string;
      format: string;
    }>('sim-circuit-data');
    return msg.data;
  }

  /** Get a frame locator for the simulator iframe. */
  get iframe() {
    return this.page.frameLocator('#sim');
  }
}

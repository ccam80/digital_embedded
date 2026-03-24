/**
 * SimulatorHarness — Playwright helper for interacting with the simulator
 * via the postMessage API through the harness.html iframe wrapper.
 *
 * IMPORTANT: The actual postMessage API in app-init.ts uses these types:
 *   - digital-load-url, digital-load-data → digital-loaded
 *   - digital-test (with testData field) → digital-test-result
 *   - digital-get-circuit → digital-circuit-data
 *   - digital-set-base, digital-set-locked, digital-set-palette → digital-loaded
 *   - digital-highlight, digital-clear-highlight
 *   - digital-set-readonly-components, digital-set-instructions
 *
 * NOTE: digital-set-input, digital-step, digital-read-output, digital-read-all-signals
 * are defined in PostMessageAdapter but NOT wired in app-init.ts.
 */
import type { Page } from '@playwright/test';

export interface TestResultMessage {
  type: 'digital-test-result';
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
    await this.waitForMessage('digital-ready');
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
    await this.postToSim({ type: 'digital-load-data', data: b64 });
    await this.waitForMessage('digital-loaded');
  }

  /** Load a circuit from a URL (relative to the server root). */
  async loadDigUrl(url: string): Promise<void> {
    await this.postToSim({ type: 'digital-load-url', url });
    await this.waitForMessage('digital-loaded');
  }

  /**
   * Run test vectors against the loaded circuit.
   * Uses the actual `digital-test` message type (not `digital-run-tests`).
   */
  async runTests(testData: string): Promise<TestResultMessage> {
    await this.postToSim({ type: 'digital-test', testData });
    return this.waitForMessage<TestResultMessage>('digital-test-result');
  }

  /** Export the current circuit as base64-encoded .dig XML. */
  async getCircuit(): Promise<string> {
    await this.postToSim({ type: 'digital-get-circuit' });
    const msg = await this.waitForMessage<{
      type: 'digital-circuit-data';
      data: string;
      format: string;
    }>('digital-circuit-data');
    return msg.data;
  }

  /** Get a frame locator for the simulator iframe. */
  get iframe() {
    return this.page.frameLocator('#sim');
  }
}

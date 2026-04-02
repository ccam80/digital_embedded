/**
 * PostMessageAdapter — single source of truth for the postMessage wire protocol.
 *
 * Translates incoming messages from a parent frame into simulator operations
 * and posts structured responses back. All message handling is centralized here
 * — no inline handlers in app-init.ts.
 *
 * GUI-specific operations (loading into the editor, palette filtering,
 * highlighting, instructions panel) are handled via callback hooks injected
 * at construction time, keeping this module free of DOM dependencies.
 *
 * Parent → Simulator message types:
 *
 *   Core:
 *     sim-load-url          — fetch URL then load circuit
 *     sim-load-data         — base64-decode then load circuit
 *     sim-load-json         — deserialize DTS then load circuit
 *     sim-set-signal        — write a signal value by label (analog or digital)
 *     sim-step              — single propagation step
 *     sim-run-tests         — run test vectors (headless runner)
 *     sim-test              — run test vectors (tutorial-style, with label validation)
 *     sim-read-signal       — read a signal value by label (analog or digital)
 *     sim-read-all-signals  — snapshot all labeled signals
 *     sim-get-circuit       — export current circuit as base64 DTS JSON
 *     sim-set-base          — update resolver base path
 *     sim-set-locked        — enable / disable locked mode
 *     sim-load-memory       — load hex/binary data into RAM/ROM
 *
 *   Tutorial / UI:
 *     sim-set-palette             — restrict component palette
 *     sim-highlight               — highlight components by label
 *     sim-clear-highlight         — clear all highlights
 *     sim-set-readonly-components — lock specific components
 *     sim-set-instructions        — show/hide instructions panel
 *     sim-load-tutorial           — load a TutorialManifest and start embedded runner
 *     sim-tutorial-goto           — jump to a specific tutorial step by index
 *
 * Simulator → Parent response types:
 *     sim-ready        — sent once on init
 *     sim-loaded       — circuit/setting applied
 *     sim-error        — error occurred
 *     sim-output       — response to sim-read-signal
 *     sim-signals      — response to sim-read-all-signals
 *     sim-test-result  — response to sim-test / sim-run-tests
 *     sim-circuit-data — response to sim-get-circuit
 *     sim-tutorial-loaded       — tutorial manifest accepted, runner active
 *     sim-tutorial-step-changed — step navigation occurred
 *     sim-tutorial-check-result — validation result for a step
 */

import type { FileResolver } from './file-resolver.js';
import { CacheResolver, ChainResolver, HttpResolver } from './file-resolver.js';
import { deserializeDts } from './dts-deserializer.js';
import { serializeCircuitToDig } from './dig-serializer.js';
import type { ComponentRegistry } from '../core/registry.js';
import type { Circuit } from '../core/circuit.js';
import { DefaultSimulatorFacade } from '../headless/default-facade.js';
import { parseTestData } from '../testing/parser.js';
import { executeTests } from '../testing/executor.js';
import type { RunnerFacade } from '../testing/executor.js';
import { detectInputCount } from '../testing/detect-input-count.js';
import type { SimulatorFacade } from '../headless/facade.js';

// ---------------------------------------------------------------------------
// Callback hooks — injected by app-init.ts for GUI integration
// ---------------------------------------------------------------------------

/**
 * Hooks that the host (app-init.ts) provides for operations that touch
 * the editor, canvas, or DOM. All are optional — headless-only hosts
 * can omit them entirely.
 */
export interface PostMessageHooks {
  /**
   * Load an XML circuit into the editor (updates canvas, viewport, palette).
   * When provided, this is used instead of facade.loadDig() so the editor
   * shows the loaded circuit. Should throw on parse errors.
   */
  loadCircuitXml?(xml: string): Promise<void> | void;

  /**
   * Load a Circuit object directly into the editor, preserving all in-memory
   * state including modelParamDeltas on element PropertyBags.
   * When provided, used by sim-load-data when the payload is DTS JSON format.
   */
  loadCircuitDts?(circuit: import('../core/circuit.js').Circuit): Promise<void> | void;

  /**
   * Return the editor's current live circuit.
   * Required for operations that read or test the circuit the user sees.
   */
  getCircuit?(): Circuit;

  /**
   * Serialize the current circuit to .dig XML.
   * Used internally for XML-based operations. For export, serializeDts is preferred.
   */
  serializeCircuit?(): string;

  /**
   * Serialize the current circuit to DTS JSON format.
   * Used by sim-get-circuit to produce an export that preserves modelParamDeltas.
   */
  serializeDts?(): string;

  /** Restrict palette to listed component type names (null = show all). */
  setPalette?(components: string[] | null): void;

  /** Highlight components by label, auto-clearing after `durationMs`. */
  highlight?(labels: string[], durationMs: number): void;

  /** Clear all highlights. */
  clearHighlight?(): void;

  /** Mark specific components as readonly (null = clear all). */
  setReadonlyComponents?(labels: string[] | null): void;

  /** Show/hide the instructions panel (null = hide). */
  setInstructions?(markdown: string | null): void;

  /** Load a tutorial manifest and start the embedded tutorial runner. */
  loadTutorial?(manifest: unknown, basePath?: unknown): void;

  /** Jump to a specific tutorial step by index. */
  tutorialGoto?(stepIndex: number): void;

  /** Update the base path for file resolution. */
  setBasePath?(basePath: string): void;

  /** Set locked mode on/off. */
  setLocked?(locked: boolean): void;

  /** Step the simulation (advance clocks + propagate). */
  step?(): void;

  /** Write a signal value by label. */
  setSignal?(label: string, value: number): void;

  /** Read a signal value by label. */
  readSignal?(label: string): number;

  /** Read all labeled signals. */
  readAllSignals?(): Record<string, number>;

  /** Get the facade instance (for test runners that need it). */
  getFacade?(): SimulatorFacade;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface PostMessageAdapterOptions {
  /** The ComponentRegistry for component lookup and DTS deserialization. */
  registry: ComponentRegistry;
  /** The FileResolver to use for subcircuit lookups. */
  resolver: FileResolver;
  /** GUI integration hooks (all optional for headless use). */
  hooks?: PostMessageHooks;
  /**
   * The postMessage target for outgoing responses.
   * In browser context this is `window.parent`.
   */
  target: { postMessage(msg: unknown, origin: string): void };
  /**
   * The event target that emits incoming 'message' events.
   * In browser context this is `window`.
   */
  eventSource: { addEventListener(type: string, handler: (e: MessageEvent) => void): void };
  /**
   * Optional fetch implementation (defaults to globalThis.fetch).
   */
  fetchFn?: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;
}

// ---------------------------------------------------------------------------
// PostMessageAdapter
// ---------------------------------------------------------------------------

export class PostMessageAdapter {
  private readonly _registry: ComponentRegistry;
  private readonly _resolver: FileResolver;
  private readonly _hooks: PostMessageHooks;
  private readonly _target: { postMessage(msg: unknown, origin: string): void };
  private readonly _fetchFn: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

  /** Facade created on-demand for headless simulation (no GUI hooks). */
  private _facade: DefaultSimulatorFacade | null = null;
  private _locked: boolean = false;

  constructor(opts: PostMessageAdapterOptions) {
    this._registry = opts.registry;
    this._resolver = opts.resolver;
    this._hooks = opts.hooks ?? {};
    this._target = opts.target;
    this._fetchFn =
      opts.fetchFn ??
      ((url: string) => globalThis.fetch(url));

    opts.eventSource.addEventListener('message', (e: MessageEvent) => {
      void this._handleMessage(e);
    });
  }

  /** Send the initial `sim-ready` message. Call once after init. */
  init(): void {
    this._post({ type: 'sim-ready' });
  }

  /** Read the current locked state. */
  get locked(): boolean {
    return this._locked;
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  private async _handleMessage(e: MessageEvent): Promise<void> {
    const msg = e.data;
    if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') {
      return;
    }

    try {
      switch (msg.type) {
        // --- Core: circuit loading ---
        case 'sim-load-url':
          await this._handleLoadUrl(msg);
          break;
        case 'sim-load-data':
          await this._handleLoadData(msg);
          break;
        case 'sim-load-json':
          await this._handleLoadJson(msg);
          break;

        // --- Core: headless simulation ---
        case 'sim-set-signal':
          this._handleSetSignal(msg);
          break;
        case 'sim-step':
          this._handleStep();
          break;
        case 'sim-read-signal':
          this._handleReadSignal(msg);
          break;
        case 'sim-read-all-signals':
          this._handleReadAllSignals();
          break;

        // --- Core: testing ---
        case 'sim-test':
          await this._handleTestTutorial(msg);
          break;
        case 'sim-run-tests':
          await this._handleRunTests(msg);
          break;

        // --- Core: circuit export ---
        case 'sim-get-circuit':
          this._handleGetCircuit();
          break;

        // --- Core: configuration ---
        case 'sim-set-base':
          this._handleSetBase(msg);
          break;
        case 'sim-set-locked':
          this._handleSetLocked(msg);
          break;
        case 'sim-load-memory':
          this._handleLoadMemory(msg);
          break;

        // --- Tutorial / UI ---
        case 'sim-set-palette':
          this._handleSetPalette(msg);
          break;
        case 'sim-highlight':
          this._handleHighlight(msg);
          break;
        case 'sim-clear-highlight':
          this._hooks.clearHighlight?.();
          break;
        case 'sim-set-readonly-components':
          this._handleSetReadonlyComponents(msg);
          break;
        case 'sim-set-instructions':
          this._handleSetInstructions(msg);
          break;

        // --- Tutorial runner ---
        case 'sim-load-tutorial':
          this._hooks.loadTutorial?.(msg.manifest, msg.basePath);
          break;
        case 'sim-tutorial-goto':
          this._hooks.tutorialGoto?.(Number(msg.stepIndex ?? 0));
          break;

        default:
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._post({ type: 'sim-error', error: message });
    }
  }

  // -------------------------------------------------------------------------
  // Loading handlers
  // -------------------------------------------------------------------------

  private async _handleLoadUrl(msg: { url?: unknown }): Promise<void> {
    const url = String(msg.url ?? '');
    if (!url) {
      this._post({ type: 'sim-error', error: 'No URL provided' });
      return;
    }
    const response = await this._fetchFn(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch circuit: ${url}`);
    }
    const text = await response.text();
    if (text.trimStart().startsWith('{')) {
      await this._loadCircuitDts(text);
    } else {
      await this._loadCircuit(text);
    }
    this._post({ type: 'sim-loaded' });
  }

  private async _handleLoadData(msg: { data?: unknown }): Promise<void> {
    const encoded = String(msg.data ?? '');
    if (!encoded) {
      this._post({ type: 'sim-error', error: 'No data provided' });
      return;
    }
    const decoded = atob(encoded);
    if (decoded.trimStart().startsWith('{')) {
      await this._loadCircuitDts(decoded);
    } else {
      await this._loadCircuit(decoded);
    }
    this._post({ type: 'sim-loaded' });
  }

  private async _handleLoadJson(msg: { data?: unknown }): Promise<void> {
    await this._loadCircuitDts(String(msg.data ?? ''));
    this._post({ type: 'sim-loaded' });
  }

  // -------------------------------------------------------------------------
  // Headless simulation handlers
  // -------------------------------------------------------------------------

  private _handleSetSignal(msg: { label?: unknown; value?: unknown }): void {
    const label = String(msg.label ?? '');
    const value = Number(msg.value ?? 0);
    if (this._hooks.setSignal) {
      this._hooks.setSignal(label, value);
    } else {
      this._ensureFacade();
      const facade = this._facade!;
      facade.setSignal(facade.getCoordinator(), label, value);
    }
  }

  private _handleStep(): void {
    if (this._hooks.step) {
      this._hooks.step();
    } else {
      this._ensureFacade();
      const facade = this._facade!;
      facade.step(facade.getCoordinator());
    }
  }

  private _handleReadSignal(msg: { label?: unknown }): void {
    const label = String(msg.label ?? '');
    let value: number;
    if (this._hooks.readSignal) {
      value = this._hooks.readSignal(label);
    } else {
      this._ensureFacade();
      const facade = this._facade!;
      value = facade.readSignal(facade.getCoordinator(), label);
    }
    this._post({ type: 'sim-output', label, value });
  }

  private _handleReadAllSignals(): void {
    let signals: Record<string, number>;
    if (this._hooks.readAllSignals) {
      signals = this._hooks.readAllSignals();
    } else {
      this._ensureFacade();
      const facade = this._facade!;
      signals = facade.readAllSignals(facade.getCoordinator());
    }
    const simTime = this._facade?.getCoordinator().simTime ?? null;
    this._post({ type: 'sim-signals', signals, simTime });
  }

  // -------------------------------------------------------------------------
  // Testing handlers
  // -------------------------------------------------------------------------

  /**
   * `sim-run-tests` — headless test execution via SimulationRunner.
   * Uses facade.runTests pattern: recompiles, runs all test vectors.
   */
  private async _handleRunTests(msg: { testData?: unknown }): Promise<void> {
    const circuit = this._getCircuit();
    const testDataStr = msg.testData != null ? String(msg.testData) : undefined;
    const facade = this._hooks.getFacade?.() ?? this._getOwnFacade();
    const coordinator = facade.compile(circuit);

    if (testDataStr) {
      const inputCount = detectInputCount(circuit, this._registry, testDataStr);
      const parsed = parseTestData(testDataStr, inputCount);
      const results = await executeTests(facade as RunnerFacade, coordinator, circuit, parsed);
      this._postTestResult(results);
    } else {
      const testcaseEl = circuit.elements.find(el => el.typeId === 'Testcase');
      if (!testcaseEl) {
        throw new Error('No test data provided and no Testcase component found in circuit.');
      }
      const embedded = (testcaseEl.getProperties().get('testDataCompiled')
        ?? testcaseEl.getProperties().get('testData')
        ?? testcaseEl.getProperties().get('Testdata')
        ?? '') as string;
      if (!embedded) {
        throw new Error('Testcase component has no test data.');
      }
      const inputCount = detectInputCount(circuit, this._registry, embedded);
      const parsed = parseTestData(embedded, inputCount);
      const results = await executeTests(facade as RunnerFacade, coordinator, circuit, parsed);
      this._postTestResult(results);
    }
  }

  /**
   * `sim-test` — tutorial-style test execution with label validation
   * and user-friendly error messages.
   */
  private async _handleTestTutorial(msg: { testData?: unknown }): Promise<void> {
    const testDataStr = String(msg.testData ?? '');
    if (!testDataStr) {
      this._post({ type: 'sim-error', error: 'No testData provided' });
      return;
    }

    const circuit = this._getCircuit();

    try {
      const facade = this._hooks.getFacade?.() ?? this._getOwnFacade();
      const coordinator = facade.compile(circuit);

      // Determine input/output labels from compiled labelSignalMap domain.
      // Analog-domain entries are inputs (sources). For digital, use element
      // typeId to distinguish inputs (In, Clock, Port) from outputs (Out, Port).
      const circuitInputLabels = new Set<string>();
      const circuitOutputLabels = new Set<string>();
      for (const el of circuit.elements) {
        const lbl = el.getProperties().getOrDefault('label', '') as string;
        if (!lbl) continue;
        const addr = coordinator.compiled.labelSignalMap.get(lbl);
        if (!addr) continue;
        if (addr.domain === 'analog') {
          circuitInputLabels.add(lbl);
        } else if (el.typeId === 'In' || el.typeId === 'Clock' || el.typeId === 'Port') {
          circuitInputLabels.add(lbl);
        } else {
          circuitOutputLabels.add(lbl);
        }
      }

      // Validate signal names against collected labels
      const hdrLine = testDataStr.split('\n').find(
        (l) => l.trim().length > 0 && !l.trim().startsWith('#'),
      ) ?? '';
      const hdrNames = hdrLine.trim().split(/\s+/).filter((n) => n.length > 0 && n !== '|');
      const missingLabels = hdrNames.filter(
        (n) => !circuitInputLabels.has(n) && !circuitOutputLabels.has(n),
      );
      if (missingLabels.length > 0) {
        const errorMsg =
          `Test signals not found in circuit: ${missingLabels.join(', ')}. ` +
          `Make sure your components have labels that match the test vector signal names ` +
          `(${hdrNames.join(', ')}). Double-click a component to set its label.`;
        this._post({ type: 'sim-error', error: errorMsg });
        return;
      }

      let detectedInputCount = 0;
      for (const n of hdrNames) {
        if (circuitInputLabels.has(n)) detectedInputCount++;
        else break;
      }
      const parsed = parseTestData(
        testDataStr,
        detectedInputCount > 0 ? detectedInputCount : undefined,
      );
      const results = await executeTests(facade as RunnerFacade, coordinator, circuit, parsed);
      this._postTestResult(results);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      let userMsg: string;
      if (errMsg.includes('did not stabilize') || errMsg.includes('oscillation') || errMsg.includes('iterations')) {
        userMsg = 'Circuit did not converge within iteration limit.';
      } else if (errMsg.includes('not found') || errMsg.includes('label')) {
        userMsg = errMsg;
      } else {
        userMsg = `Test error: ${errMsg}`;
      }
      this._post({ type: 'sim-error', error: userMsg });
    }
  }

  // -------------------------------------------------------------------------
  // Circuit export
  // -------------------------------------------------------------------------

  private _handleGetCircuit(): void {
    if (this._hooks.serializeDts) {
      const dtsJson = this._hooks.serializeDts();
      const encoded = btoa(dtsJson);
      this._post({
        type: 'sim-circuit-data',
        data: encoded,
        format: 'dts-json-base64',
      });
      return;
    }
    if (!this._hooks.serializeCircuit) {
      throw new Error('Circuit export not available.');
    }
    const xml = this._hooks.serializeCircuit();
    const encoded = btoa(xml);
    this._post({
      type: 'sim-circuit-data',
      data: encoded,
      format: 'dig-xml-base64',
    });
  }

  // -------------------------------------------------------------------------
  // Configuration handlers
  // -------------------------------------------------------------------------

  private _handleSetBase(msg: { basePath?: unknown }): void {
    const basePath = String(msg.basePath ?? './');
    this._clearCaches();
    this._updateResolverBasePath(basePath);
    this._hooks.setBasePath?.(basePath);
    this._post({ type: 'sim-loaded' });
  }

  private _handleSetLocked(msg: { locked?: unknown }): void {
    this._locked = Boolean(msg.locked);
    this._hooks.setLocked?.(this._locked);
  }

  private _handleLoadMemory(msg: { label?: unknown; data?: unknown; format?: unknown }): void {
    const circuit = this._getCircuit();
    const label = String(msg.label ?? '');
    const memoryElement = circuit.elements.find(
      (el) => (el as { label?: string }).label === label,
    );
    if (memoryElement === undefined) {
      throw new Error(`No memory component with label "${label}" found in circuit`);
    }

    const hookFacade = this._hooks.getFacade?.();
    const engine = (hookFacade as unknown as { getActiveCoordinator?(): import('../solver/coordinator.js').DefaultSimulationCoordinator | null } | undefined)?.getActiveCoordinator?.()
      ?? this._facade?.getActiveCoordinator();
    if (engine && typeof (engine as unknown as { loadMemory?: unknown }).loadMemory === 'function') {
      (engine as unknown as { loadMemory(l: string, d: string, f: string): void })
        .loadMemory(label, String(msg.data ?? ''), String(msg.format ?? 'hex'));
    } else {
      (memoryElement as unknown as { loadData(d: string, f: string): void })
        .loadData(String(msg.data ?? ''), String(msg.format ?? 'hex'));
    }
  }

  // -------------------------------------------------------------------------
  // Tutorial / UI handlers
  // -------------------------------------------------------------------------

  private _handleSetPalette(msg: { components?: unknown }): void {
    const raw = msg.components;
    if (Array.isArray(raw)) {
      const names = raw.map(String).filter((s: string) => s.length > 0);
      this._hooks.setPalette?.(names.length > 0 ? names : null);
    } else {
      this._hooks.setPalette?.(null);
    }
    this._post({ type: 'sim-loaded' });
  }

  private _handleHighlight(msg: { labels?: unknown; duration?: unknown }): void {
    const labels = msg.labels;
    if (!Array.isArray(labels)) {
      this._post({ type: 'sim-error', error: 'highlight requires labels array' });
      return;
    }
    const duration = typeof msg.duration === 'number' ? msg.duration : 3000;
    this._hooks.highlight?.(labels.map(String), duration);
  }

  private _handleSetReadonlyComponents(msg: { labels?: unknown }): void {
    const labels = msg.labels;
    if (labels === null || labels === undefined) {
      this._hooks.setReadonlyComponents?.(null);
    } else if (Array.isArray(labels)) {
      this._hooks.setReadonlyComponents?.(labels.map(String));
    }
  }

  private _handleSetInstructions(msg: { markdown?: unknown }): void {
    const markdown = msg.markdown;
    if (markdown === null || markdown === undefined) {
      this._hooks.setInstructions?.(null);
    } else {
      this._hooks.setInstructions?.(String(markdown));
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Load a circuit from XML. Uses the GUI hook if available (so the editor
   * shows the circuit), otherwise falls back to headless compilation.
   */
  private async _loadCircuitDts(json: string): Promise<void> {
    const { circuit } = deserializeDts(json, this._registry);
    if (this._hooks.loadCircuitDts) {
      await this._hooks.loadCircuitDts(circuit);
    } else if (this._hooks.loadCircuitXml) {
      const xml = serializeCircuitToDig(circuit, this._registry);
      await this._hooks.loadCircuitXml(xml);
    } else {
      this._getOwnFacade().compile(circuit);
    }
  }

  private async _loadCircuit(xml: string): Promise<void> {
    if (this._hooks.loadCircuitXml) {
      await this._hooks.loadCircuitXml(xml);
    } else {
      const { loadDig } = await import('../io/dig-loader.js');
      const circuit = loadDig(xml, this._registry);
      this._getOwnFacade().compile(circuit);
    }
  }

  /** Get the current circuit — prefers the GUI hook, falls back to error. */
  private _getCircuit(): Circuit {
    if (this._hooks.getCircuit) {
      return this._hooks.getCircuit();
    }
    throw new Error('No circuit loaded. Send sim-load-url or sim-load-data first.');
  }

  /** Get or create the adapter's own facade (headless-only mode). */
  private _getOwnFacade(): DefaultSimulatorFacade {
    if (!this._facade) {
      this._facade = new DefaultSimulatorFacade(this._registry);
    }
    return this._facade;
  }

  /** Ensure own facade exists and has a compiled engine. */
  private _ensureFacade(): void {
    if (!this._facade?.getActiveCoordinator()) {
      throw new Error('No circuit loaded. Send sim-load-url or sim-load-data first.');
    }
  }

  /** Post a test result in the canonical format. */
  private _postTestResult(results: { passed: number; failed: number; total: number; vectors: Array<{ passed: boolean; inputs: Record<string, number>; expectedOutputs: Record<string, number>; actualOutputs: Record<string, number> }> }): void {
    this._post({
      type: 'sim-test-result',
      passed: results.passed,
      failed: results.failed,
      total: results.total,
      details: results.vectors.map((v) => ({
        passed: v.passed,
        inputs: v.inputs,
        expected: v.expectedOutputs,
        actual: v.actualOutputs,
      })),
    });
  }

  private _clearCaches(): void {
    for (const r of this._flattenResolvers()) {
      if (r instanceof CacheResolver) {
        r.clear();
      } else if (
        typeof (r as unknown as { clear?: () => void }).clear === 'function'
      ) {
        (r as unknown as { clear(): void }).clear();
      }
    }
  }

  private _updateResolverBasePath(basePath: string): void {
    for (const r of this._flattenResolvers()) {
      if (r instanceof HttpResolver) {
        r.setBasePath(basePath);
      } else if (
        typeof (r as unknown as { setBasePath?: (p: string) => void }).setBasePath === 'function'
      ) {
        (r as unknown as { setBasePath(p: string): void }).setBasePath(basePath);
      }
    }
  }

  private _flattenResolvers(): readonly FileResolver[] {
    if (this._resolver instanceof ChainResolver) {
      return this._resolver.resolvers;
    }
    return [this._resolver];
  }

  private _post(msg: unknown): void {
    this._target.postMessage(msg, '*');
  }
}

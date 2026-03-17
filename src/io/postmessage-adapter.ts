/**
 * PostMessageAdapter — thin adapter translating postMessage wire protocol to
 * SimulatorFacade calls.
 *
 * Listens for window messages from a parent frame and maps each message type
 * to the appropriate facade / binding call. Responses are posted back to the
 * originating frame via postMessage.
 *
 * All incoming messages are wrapped in try/catch. Errors produce a
 * `digital-error` response message.
 *
 * Parent → Simulator message types:
 *   digital-load-url      — fetch URL then loadDig
 *   digital-load-data     — base64-decode then loadDig
 *   digital-load-json     — deserializeDts then load circuit + subcircuits
 *   digital-set-input     — set input signal by label
 *   digital-step          — single propagation step
 *   digital-run-tests     — run test vectors, optional testData override
 *   digital-read-output   — read output signal by label
 *   digital-read-all-signals — snapshot all labeled signals
 *   digital-set-base      — update resolver base path, clear subcircuit cache
 *   digital-set-locked    — enable / disable locked mode
 *   digital-load-memory   — load hex/binary data into a RAM/ROM component
 *
 * Simulator → Parent response types:
 *   digital-ready         — sent once on init
 *   digital-loaded        — circuit loaded successfully
 *   digital-error         — error occurred
 *   digital-output        — response to digital-read-output
 *   digital-signals       — response to digital-read-all-signals
 *   digital-test-results  — response to digital-run-tests
 */

import type { SimulatorFacade } from '../headless/facade.js';
import type { EditorBinding } from '../integration/editor-binding.js';
import type { FileResolver } from './file-resolver.js';
import { CacheResolver, ChainResolver, HttpResolver } from './file-resolver.js';
import { deserializeDts } from './dts-deserializer.js';
import type { ComponentRegistry } from '../core/registry.js';
import type { Circuit } from '../core/circuit.js';
import type { SimulationEngine } from '../core/engine-interface.js';

// ---------------------------------------------------------------------------
// Incoming message shapes
// ---------------------------------------------------------------------------

interface LoadUrlMessage {
  type: 'digital-load-url';
  url: string;
}

interface LoadDataMessage {
  type: 'digital-load-data';
  data: string;
}

interface LoadJsonMessage {
  type: 'digital-load-json';
  data: string;
}

interface SetInputMessage {
  type: 'digital-set-input';
  label: string;
  value: number;
}

interface StepMessage {
  type: 'digital-step';
}

interface RunTestsMessage {
  type: 'digital-run-tests';
  testData?: string;
}

interface ReadOutputMessage {
  type: 'digital-read-output';
  label: string;
}

interface ReadAllSignalsMessage {
  type: 'digital-read-all-signals';
}

interface SetBaseMessage {
  type: 'digital-set-base';
  basePath: string;
}

interface SetLockedMessage {
  type: 'digital-set-locked';
  locked: boolean;
}

interface LoadMemoryMessage {
  type: 'digital-load-memory';
  label: string;
  data: string;
  format: 'hex' | 'binary';
}

type IncomingMessage =
  | LoadUrlMessage
  | LoadDataMessage
  | LoadJsonMessage
  | SetInputMessage
  | StepMessage
  | RunTestsMessage
  | ReadOutputMessage
  | ReadAllSignalsMessage
  | SetBaseMessage
  | SetLockedMessage
  | LoadMemoryMessage;

// ---------------------------------------------------------------------------
// PostMessageAdapter
// ---------------------------------------------------------------------------

/**
 * Adapter options injected at construction time.
 */
export interface PostMessageAdapterOptions {
  /** The SimulatorFacade providing circuit operations. */
  facade: SimulatorFacade;
  /** The EditorBinding that holds current circuit / engine state. */
  binding: EditorBinding;
  /** The FileResolver to use for subcircuit lookups. */
  resolver: FileResolver;
  /** The ComponentRegistry for deserializing .dts documents. */
  registry: ComponentRegistry;
  /**
   * The postMessage target used for outgoing responses.
   * In browser context this is `window.parent`.
   * Injected for testability.
   */
  target: { postMessage(msg: unknown, origin: string): void };
  /**
   * The event target that emits incoming 'message' events.
   * In browser context this is `window`.
   * Injected for testability.
   */
  eventSource: { addEventListener(type: string, handler: (e: MessageEvent) => void): void };
  /**
   * Optional fetch implementation (defaults to globalThis.fetch).
   * Injected for testability.
   */
  fetchFn?: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;
}

/**
 * PostMessageAdapter: bridges the postMessage wire protocol to facade calls.
 *
 * Construct with the required dependencies and call init() to send the
 * initial `digital-ready` message and start listening for incoming messages.
 */
export class PostMessageAdapter {
  private readonly _facade: SimulatorFacade;
  private readonly _resolver: FileResolver;
  private readonly _registry: ComponentRegistry;
  private readonly _target: { postMessage(msg: unknown, origin: string): void };
  private readonly _fetchFn: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

  private _circuit: Circuit | null = null;
  private _engine: SimulationEngine | null = null;
  private _locked: boolean = false;

  constructor(opts: PostMessageAdapterOptions) {
    this._facade = opts.facade;
    void opts.binding; // binding not stored; reserved for future use
    this._resolver = opts.resolver;
    this._registry = opts.registry;
    this._target = opts.target;
    this._fetchFn =
      opts.fetchFn ??
      ((globalThis as unknown as { fetch: typeof fetch }).fetch as typeof this._fetchFn);

    opts.eventSource.addEventListener('message', (e: MessageEvent) => {
      void this._handleMessage(e);
    });
  }

  /**
   * Send the initial `digital-ready` message to the parent frame.
   * Call once after the simulator has fully initialized.
   */
  init(): void {
    this._post({ type: 'digital-ready' });
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  private async _handleMessage(e: MessageEvent): Promise<void> {
    const msg = e.data as IncomingMessage;
    if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') {
      return;
    }

    try {
      switch (msg.type) {
        case 'digital-load-url':
          await this._handleLoadUrl(msg);
          break;
        case 'digital-load-data':
          this._handleLoadData(msg);
          break;
        case 'digital-load-json':
          this._handleLoadJson(msg);
          break;
        case 'digital-set-input':
          this._handleSetInput(msg);
          break;
        case 'digital-step':
          this._handleStep();
          break;
        case 'digital-run-tests':
          this._handleRunTests(msg);
          break;
        case 'digital-read-output':
          this._handleReadOutput(msg);
          break;
        case 'digital-read-all-signals':
          this._handleReadAllSignals();
          break;
        case 'digital-set-base':
          this._handleSetBase(msg);
          break;
        case 'digital-set-locked':
          this._handleSetLocked(msg);
          break;
        case 'digital-load-memory':
          this._handleLoadMemory(msg);
          break;
        default:
          // Unknown message types are silently ignored.
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this._post({ type: 'digital-error', error: message });
    }
  }

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  private async _handleLoadUrl(msg: LoadUrlMessage): Promise<void> {
    const response = await this._fetchFn(msg.url);
    if (!response.ok) {
      throw new Error(`Failed to fetch circuit: ${msg.url}`);
    }
    const xml = await response.text();
    this._loadCircuit(xml);
    this._post({ type: 'digital-loaded' });
  }

  private _handleLoadData(msg: LoadDataMessage): void {
    const xml = atob(msg.data);
    this._loadCircuit(xml);
    this._post({ type: 'digital-loaded' });
  }

  private _handleLoadJson(msg: LoadJsonMessage): void {
    const { circuit } = deserializeDts(msg.data, this._registry);
    this._circuit = circuit;
    this._engine = this._facade.compile(circuit);
    this._post({ type: 'digital-loaded' });
  }

  private _handleSetInput(msg: SetInputMessage): void {
    const engine = this._requireEngine();
    this._facade.setInput(engine, msg.label, msg.value);
  }

  private _handleStep(): void {
    const engine = this._requireEngine();
    this._facade.step(engine);
  }

  private _handleRunTests(msg: RunTestsMessage): void {
    const engine = this._requireEngine();
    const circuit = this._requireCircuit();
    const results = this._facade.runTests(engine, circuit, msg.testData);
    this._post({ type: 'digital-test-results', results });
  }

  private _handleReadOutput(msg: ReadOutputMessage): void {
    const engine = this._requireEngine();
    const value = this._facade.readOutput(engine, msg.label);
    this._post({ type: 'digital-output', label: msg.label, value });
  }

  private _handleReadAllSignals(): void {
    const engine = this._requireEngine();
    const signals = this._facade.readAllSignals(engine);
    this._post({ type: 'digital-signals', signals });
  }

  private _handleSetBase(msg: SetBaseMessage): void {
    this._clearCaches();
    this._updateResolverBasePath(msg.basePath);
  }

  private _handleSetLocked(msg: SetLockedMessage): void {
    this._locked = msg.locked;
  }

  private _handleLoadMemory(msg: LoadMemoryMessage): void {
    const circuit = this._requireCircuit();
    const engine = this._requireEngine();

    const memoryElement = circuit.elements.find(
      (el) => (el as { label?: string }).label === msg.label,
    );
    if (memoryElement === undefined) {
      throw new Error(`No memory component with label "${msg.label}" found in circuit`);
    }

    if (typeof (engine as unknown as { loadMemory?: unknown }).loadMemory === 'function') {
      (
        engine as unknown as {
          loadMemory(label: string, data: string, format: string): void;
        }
      ).loadMemory(msg.label, msg.data, msg.format);
    } else {
      (
        memoryElement as unknown as {
          loadData(data: string, format: string): void;
        }
      ).loadData(msg.data, msg.format);
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private _loadCircuit(xml: string): void {
    const circuit = this._facade.loadDig(xml);
    this._circuit = circuit;
    this._engine = this._facade.compile(circuit);
  }

  private _requireCircuit(): Circuit {
    if (this._circuit === null) {
      throw new Error('No circuit loaded. Send digital-load-url or digital-load-data first.');
    }
    return this._circuit;
  }

  private _requireEngine(): SimulationEngine {
    if (this._engine === null) {
      throw new Error('No circuit loaded. Send digital-load-url or digital-load-data first.');
    }
    return this._engine;
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
        typeof (r as unknown as { setBasePath?: (p: string) => void }).setBasePath ===
        'function'
      ) {
        (r as unknown as { setBasePath(p: string): void }).setBasePath(basePath);
      }
    }
  }

  /** Unwrap ChainResolver to access inner resolvers; otherwise return singleton. */
  private _flattenResolvers(): readonly FileResolver[] {
    if (this._resolver instanceof ChainResolver) {
      return this._resolver.resolvers;
    }
    return [this._resolver];
  }

  private _post(msg: unknown): void {
    this._target.postMessage(msg, '*');
  }

  /**
   * Read the current locked state.
   */
  get locked(): boolean {
    return this._locked;
  }
}

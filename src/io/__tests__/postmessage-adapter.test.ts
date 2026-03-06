/**
 * Tests for PostMessageAdapter — task 6.4.2.
 *
 * Verifies the postMessage wire protocol adapter. All dependencies are
 * injected via the options object so tests run without a real browser.
 *
 * Test scenarios:
 *   loadUrl         — digital-load-url → facade.loadDig called, digital-loaded sent
 *   loadData        — digital-load-data with base64 .dig → circuit loaded
 *   loadJson        — digital-load-json with .digb content → circuit + subcircuits loaded
 *   setInput        — digital-set-input → facade.setInput called with correct args
 *   readOutput      — digital-read-output → digital-output response with correct value
 *   runTests        — digital-run-tests → digital-test-results response
 *   setBase         — digital-set-base → resolver base path updated and cache cleared
 *   errorHandling   — message that causes error → digital-error response
 *   loadMemory      — digital-load-memory → memory component data loaded
 *   readyOnInit     — digital-ready sent when adapter is initialized
 */

import { describe, it, expect, vi } from "vitest";
import { PostMessageAdapter } from "../postmessage-adapter.js";
import type { PostMessageAdapterOptions } from "../postmessage-adapter.js";
import type { SimulatorFacade } from "@/headless/facade";
import type { EditorBinding } from "@/integration/editor-binding";
import type { SimulationEngine } from "@/core/engine-interface";
import { CacheResolver, HttpResolver, ChainResolver } from "../file-resolver.js";
import type { FileResolver } from "../file-resolver.js";
import { Circuit } from "@/core/circuit";
import type { ComponentRegistry } from "@/core/registry";
import type { TestResults } from "@/headless/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stub Circuit suitable for use as a loaded circuit. */
function makeStubCircuit(): Circuit {
  return new Circuit({ name: "stub" });
}

/** Build a stub engine. */
const stubEngine = {} as SimulationEngine;

/** Minimal mock ComponentRegistry. */
function makeRegistry(): ComponentRegistry {
  return {
    get: vi.fn().mockReturnValue(undefined),
    getAll: vi.fn().mockReturnValue([]),
    register: vi.fn(),
  } as unknown as ComponentRegistry;
}

/**
 * Build a PostMessageAdapter with injected mocks.
 *
 * Returns the adapter, the mock target (captured outgoing messages),
 * and a dispatch helper that fires a simulated incoming MessageEvent.
 */
function makeAdapter(
  facadeOverrides: Partial<SimulatorFacade> = {},
  resolverOverride?: FileResolver,
  fetchOverride?: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>,
): {
  adapter: PostMessageAdapter;
  sent: unknown[];
  dispatch: (data: unknown) => Promise<void>;
  facade: SimulatorFacade;
  cache: CacheResolver;
  http: HttpResolver;
} {
  const circuit = makeStubCircuit();

  const facade: SimulatorFacade = {
    loadDig: vi.fn().mockReturnValue(circuit),
    compile: vi.fn().mockReturnValue(stubEngine),
    step: vi.fn(),
    run: vi.fn(),
    runToStable: vi.fn(),
    setInput: vi.fn(),
    readOutput: vi.fn().mockReturnValue(42),
    readAllSignals: vi.fn().mockReturnValue({ A: 1, B: 0 }),
    runTests: vi.fn().mockReturnValue({
      passed: 2,
      failed: 0,
      total: 2,
      vectors: [],
    } satisfies TestResults),
    createCircuit: vi.fn().mockReturnValue(circuit),
    addComponent: vi.fn(),
    connect: vi.fn(),
    serialize: vi.fn().mockReturnValue("{}"),
    deserialize: vi.fn().mockReturnValue(circuit),
    ...facadeOverrides,
  } as unknown as SimulatorFacade;

  const binding: EditorBinding = {
    bind: vi.fn(),
    unbind: vi.fn(),
    getWireValue: vi.fn().mockReturnValue(0),
    getPinValue: vi.fn().mockReturnValue(0),
    setInput: vi.fn(),
    isBound: false,
    engine: null,
  } as unknown as EditorBinding;

  const cache = new CacheResolver();
  const http = new HttpResolver("./");
  const resolver: FileResolver = resolverOverride ?? new ChainResolver([cache, http]);

  const registry = makeRegistry();

  const sent: unknown[] = [];
  const target = {
    postMessage: vi.fn((msg: unknown) => {
      sent.push(msg);
    }),
  };

  // Collect registered message listeners so we can dispatch to them.
  const listeners: Array<(e: MessageEvent) => void> = [];
  const eventSource = {
    addEventListener: vi.fn((_type: string, handler: (e: MessageEvent) => void) => {
      listeners.push(handler);
    }),
  };

  const opts: PostMessageAdapterOptions = {
    facade,
    binding,
    resolver,
    registry,
    target,
    eventSource,
    ...(fetchOverride !== undefined ? { fetchFn: fetchOverride } : {}),
  };

  const adapter = new PostMessageAdapter(opts);

  const dispatch = async (data: unknown): Promise<void> => {
    const event = { data } as MessageEvent;
    for (const listener of listeners) {
      await listener(event);
    }
  };

  return { adapter, sent, dispatch, facade, cache, http };
}

// ---------------------------------------------------------------------------
// readyOnInit
// ---------------------------------------------------------------------------

describe("PostMessageAdapter.init", () => {
  it("readyOnInit — digital-ready sent when adapter is initialized", () => {
    const { adapter, sent } = makeAdapter();
    adapter.init();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: "digital-ready" });
  });
});

// ---------------------------------------------------------------------------
// loadUrl
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-load-url", () => {
  it("loadUrl — facade.loadDig called, digital-loaded response sent", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<circuit>xml</circuit>",
    });
    const { sent, dispatch, facade } = makeAdapter({}, undefined, fetchFn);

    await dispatch({ type: "digital-load-url", url: "http://example.com/and.dig" });

    expect(fetchFn).toHaveBeenCalledWith("http://example.com/and.dig");
    expect(facade.loadDig).toHaveBeenCalledWith("<circuit>xml</circuit>");
    expect(sent).toContainEqual({ type: "digital-loaded" });
  });

  it("loadUrl — fetch failure sends digital-error", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, text: async () => "" });
    const { sent, dispatch } = makeAdapter({}, undefined, fetchFn);

    await dispatch({ type: "digital-load-url", url: "http://example.com/missing.dig" });

    expect(sent.some((m) => (m as { type: string }).type === "digital-error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// loadData
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-load-data", () => {
  it("loadData — base64-decoded XML passed to facade.loadDig, digital-loaded sent", async () => {
    const xml = "<circuit>test xml</circuit>";
    const base64 = btoa(xml);
    const { sent, dispatch, facade } = makeAdapter();

    await dispatch({ type: "digital-load-data", data: base64 });

    expect(facade.loadDig).toHaveBeenCalledWith(xml);
    expect(sent).toContainEqual({ type: "digital-loaded" });
  });
});

// ---------------------------------------------------------------------------
// loadJson
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-load-json", () => {
  it("loadJson — valid digb JSON loads circuit and compiles engine, digital-loaded sent", async () => {
    // A minimal .digb document that satisfies the schema validator.
    const digbJson = JSON.stringify({
      format: "digb",
      version: 1,
      circuit: {
        name: "test",
        elements: [],
        wires: [],
      },
    });

    const { sent, dispatch, facade } = makeAdapter({
      compile: vi.fn().mockReturnValue(stubEngine),
    });

    // Override loadDig so loadJson path doesn't call it (loadJson uses deserializeDigb).
    // facade.loadDig should NOT be called for loadJson.
    await dispatch({ type: "digital-load-json", data: digbJson });

    // digital-loaded should have been sent.
    expect(sent).toContainEqual({ type: "digital-loaded" });
    // facade.compile should have been called (circuit was compiled).
    expect(facade.compile).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setInput
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-set-input", () => {
  it("setInput — facade.setInput called with correct label and value", async () => {
    const { dispatch, facade } = makeAdapter();

    // First load a circuit so the engine is set.
    await dispatch({ type: "digital-load-data", data: btoa("<circuit/>") });
    await dispatch({ type: "digital-set-input", label: "SW0", value: 1 });

    expect(facade.setInput).toHaveBeenCalledWith(stubEngine, "SW0", 1);
  });

  it("setInput without loaded circuit sends digital-error", async () => {
    const { sent, dispatch } = makeAdapter();

    await dispatch({ type: "digital-set-input", label: "SW0", value: 1 });

    expect(sent.some((m) => (m as { type: string }).type === "digital-error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readOutput
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-read-output", () => {
  it("readOutput — digital-output response sent with correct label and value", async () => {
    const { sent, dispatch, facade } = makeAdapter({
      readOutput: vi.fn().mockReturnValue(7),
    });

    await dispatch({ type: "digital-load-data", data: btoa("<circuit/>") });
    await dispatch({ type: "digital-read-output", label: "OUT0" });

    expect(facade.readOutput).toHaveBeenCalledWith(stubEngine, "OUT0");
    expect(sent).toContainEqual({ type: "digital-output", label: "OUT0", value: 7 });
  });
});

// ---------------------------------------------------------------------------
// runTests
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-run-tests", () => {
  it("runTests — digital-test-results response contains TestResults", async () => {
    const expectedResults: TestResults = {
      passed: 3,
      failed: 1,
      total: 4,
      vectors: [],
    };
    const { sent, dispatch } = makeAdapter({
      runTests: vi.fn().mockReturnValue(expectedResults),
    });

    await dispatch({ type: "digital-load-data", data: btoa("<circuit/>") });
    await dispatch({ type: "digital-run-tests" });

    expect(sent).toContainEqual({ type: "digital-test-results", results: expectedResults });
  });

  it("runTests — optional testData forwarded to facade.runTests", async () => {
    const { dispatch, facade } = makeAdapter();

    await dispatch({ type: "digital-load-data", data: btoa("<circuit/>") });
    await dispatch({ type: "digital-run-tests", testData: "A B Y\n0 0 0\n1 1 1" });

    expect(facade.runTests).toHaveBeenCalledWith(
      stubEngine,
      expect.anything(),
      "A B Y\n0 0 0\n1 1 1",
    );
  });
});

// ---------------------------------------------------------------------------
// setBase
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-set-base", () => {
  it("setBase — HttpResolver base path updated", async () => {
    const http = new HttpResolver("old/");
    const resolver = new ChainResolver([http]);
    const { dispatch } = makeAdapter({}, resolver);

    await dispatch({ type: "digital-set-base", basePath: "new/" });

    expect(http.getBasePath()).toBe("new/");
  });

  it("setBase — CacheResolver cache cleared", async () => {
    const cache = new CacheResolver();
    cache.set("X", "<circuit/>");
    expect(cache.size).toBe(1);

    const resolver = new ChainResolver([cache]);
    const { dispatch: _dispatch } = makeAdapter({}, resolver);

    // setBase clears the cache when the resolver directly is a CacheResolver.
    // Use a CacheResolver directly as the resolver (not chained) to test that path.
    const directCache = new CacheResolver();
    directCache.set("Y", "<circuit/>");

    const { dispatch: dispatch2 } = makeAdapter({}, directCache);
    await dispatch2({ type: "digital-set-base", basePath: "updated/" });

    expect(directCache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// errorHandling
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — error handling", () => {
  it("errorHandling — message that causes an error sends digital-error response", async () => {
    const { sent, dispatch } = makeAdapter({
      loadDig: vi.fn().mockImplementation(() => {
        throw new Error("parse failure");
      }),
    });

    await dispatch({ type: "digital-load-data", data: btoa("<bad-circuit/>") });

    const errorMsgs = sent.filter(
      (m) => (m as { type: string }).type === "digital-error",
    ) as Array<{ type: string; error: string }>;
    expect(errorMsgs).toHaveLength(1);
    expect(errorMsgs[0].error).toContain("parse failure");
  });

  it("unknown message types are ignored without error", async () => {
    const { sent, dispatch } = makeAdapter();

    await dispatch({ type: "digital-unknown-message-type" });

    expect(sent).toHaveLength(0);
  });

  it("non-object messages are ignored", async () => {
    const { sent, dispatch } = makeAdapter();

    await dispatch("not an object");
    await dispatch(42);
    await dispatch(null);

    expect(sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// loadMemory
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-load-memory", () => {
  it("loadMemory — memory component loadData called with correct args", async () => {
    const loadDataFn = vi.fn();
    const circuit = new Circuit({ name: "mem" });
    // Add a fake memory element with a label property.
    const fakeMemEl = Object.assign(Object.create(null), {
      label: "RAM0",
      instanceId: "ram-0",
      position: { x: 0, y: 0 },
      rotation: 0,
      typeId: "RAM",
      getPins: () => [],
      loadData: loadDataFn,
    });
    circuit.elements.push(fakeMemEl);

    const { dispatch } = makeAdapter({
      loadDig: vi.fn().mockReturnValue(circuit),
      compile: vi.fn().mockReturnValue(stubEngine),
    });

    // Load the circuit first so this._circuit is set.
    await dispatch({ type: "digital-load-data", data: btoa("<circuit/>") });
    await dispatch({
      type: "digital-load-memory",
      label: "RAM0",
      data: "FF00FF00",
      format: "hex",
    });

    expect(loadDataFn).toHaveBeenCalledWith("FF00FF00", "hex");
  });

  it("loadMemory — missing label sends digital-error", async () => {
    const { sent, dispatch } = makeAdapter();

    await dispatch({ type: "digital-load-data", data: btoa("<circuit/>") });
    await dispatch({
      type: "digital-load-memory",
      label: "NONEXISTENT",
      data: "FF",
      format: "hex",
    });

    const errorMsgs = sent.filter(
      (m) => (m as { type: string }).type === "digital-error",
    );
    expect(errorMsgs).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// setLocked
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-set-locked", () => {
  it("locked state toggled on and off", async () => {
    const { adapter, dispatch } = makeAdapter();

    expect(adapter.locked).toBe(false);

    await dispatch({ type: "digital-set-locked", locked: true });
    expect(adapter.locked).toBe(true);

    await dispatch({ type: "digital-set-locked", locked: false });
    expect(adapter.locked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// digital-step
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-step", () => {
  it("step — facade.step called with engine", async () => {
    const { dispatch, facade } = makeAdapter();

    await dispatch({ type: "digital-load-data", data: btoa("<circuit/>") });
    await dispatch({ type: "digital-step" });

    expect(facade.step).toHaveBeenCalledWith(stubEngine);
  });
});

// ---------------------------------------------------------------------------
// digital-read-all-signals
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-read-all-signals", () => {
  it("readAllSignals — digital-signals response sent with signal map", async () => {
    const signalMap = { A: 1, B: 0, Y: 1 };
    const { sent, dispatch } = makeAdapter({
      readAllSignals: vi.fn().mockReturnValue(signalMap),
    });

    await dispatch({ type: "digital-load-data", data: btoa("<circuit/>") });
    await dispatch({ type: "digital-read-all-signals" });

    expect(sent).toContainEqual({ type: "digital-signals", signals: signalMap });
  });
});

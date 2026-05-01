/**
 * Tests for PostMessageAdapter.
 *
 * Verifies the postMessage wire protocol adapter. All dependencies are
 * injected via the options object so tests run without a real browser.
 *
 * Test scenarios:
 *   readyOnInit    - sim-ready sent when adapter is initialized
 *   loadUrl        - sim-load-url → hook called, sim-loaded sent
 *   loadData       - sim-load-data with base64 .dig → hook called
 *   setBase        - sim-set-base → resolver base path updated, cache cleared
 *   setLocked      - sim-set-locked → hook called, locked state updated
 *   setPalette     - sim-set-palette → hook called
 *   test           - sim-test → sim-test-result response
 *   getCircuit     - sim-get-circuit → sim-circuit-data response
 *   highlight      - sim-highlight → hook called
 *   errorHandling  - message that causes error → sim-error response
 *   stepDelegation - sim-step delegates to hooks.step when present
 *   stepClockCanary- sim-step via postMessage advances clocks (regression canary)
 */

import { describe, it, expect, vi } from "vitest";
import { PostMessageAdapter } from "../postmessage-adapter.js";
import type { PostMessageAdapterOptions, PostMessageHooks } from "../postmessage-adapter.js";
import { CacheResolver, HttpResolver, ChainResolver } from "../file-resolver.js";
import type { FileResolver } from "../file-resolver.js";
import { ComponentRegistry } from "@/core/registry";
import { Circuit } from "@/core/circuit";
import { createDefaultRegistry } from "@/components/register-all";
import { DefaultSimulatorFacade } from "@/headless/default-facade";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a stub Circuit suitable for use as a loaded circuit. */
function makeStubCircuit(): Circuit {
  return new Circuit({ name: "stub" });
}

/**
 * Build a PostMessageAdapter with injected mocks.
 *
 * Returns the adapter, captured outgoing messages, and a dispatch helper.
 */
function makeAdapter(
  hooksOverride: PostMessageHooks = {},
  resolverOverride?: FileResolver,
  fetchOverride?: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>,
): {
  adapter: PostMessageAdapter;
  sent: unknown[];
  dispatch: (data: unknown) => Promise<void>;
  hooks: PostMessageHooks;
  cache: CacheResolver;
  http: HttpResolver;
} {
  const cache = new CacheResolver();
  const http = new HttpResolver("./");
  const resolver: FileResolver = resolverOverride ?? new ChainResolver([cache, http]);

  const registry = new ComponentRegistry();

  const sent: unknown[] = [];
  const target = {
    postMessage: vi.fn((msg: unknown) => {
      sent.push(msg);
    }),
  };

  const listeners: Array<(e: MessageEvent) => void> = [];
  const eventSource = {
    addEventListener: vi.fn((_type: string, handler: (e: MessageEvent) => void) => {
      listeners.push(handler);
    }),
  };

  const stubCircuit = makeStubCircuit();
  const hooks: PostMessageHooks = {
    loadCircuitXml: vi.fn(),
    getCircuit: vi.fn().mockReturnValue(stubCircuit),
    setBasePath: vi.fn(),
    setLocked: vi.fn(),
    setPalette: vi.fn(),
    highlight: vi.fn(),
    clearHighlight: vi.fn(),
    setReadonlyComponents: vi.fn(),
    setInstructions: vi.fn(),
    ...hooksOverride,
  };

  const opts: PostMessageAdapterOptions = {
    registry,
    resolver,
    hooks,
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
    // Allow microtasks to settle (for async handlers)
    await new Promise((r) => setTimeout(r, 0));
  };

  return { adapter, sent, dispatch, hooks, cache, http };
}

// ---------------------------------------------------------------------------
// readyOnInit
// ---------------------------------------------------------------------------

describe("PostMessageAdapter.init", () => {
  it("readyOnInit- sim-ready sent when adapter is initialized", () => {
    const { adapter, sent } = makeAdapter();
    adapter.init();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ type: "sim-ready" });
  });
});

// ---------------------------------------------------------------------------
// loadUrl
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-load-url", () => {
  it("loadUrl- hook called, sim-loaded response sent", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<circuit>xml</circuit>",
    });
    const { sent, dispatch, hooks } = makeAdapter({}, undefined, fetchFn);

    await dispatch({ type: "sim-load-url", url: "http://example.com/and.dig" });

    expect(fetchFn).toHaveBeenCalledWith("http://example.com/and.dig");
    expect(hooks.loadCircuitXml).toHaveBeenCalledWith("<circuit>xml</circuit>");
    expect(sent).toContainEqual({ type: "sim-loaded" });
  });

  it("loadUrl- fetch failure sends sim-error", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, text: async () => "" });
    const { sent, dispatch } = makeAdapter({}, undefined, fetchFn);

    await dispatch({ type: "sim-load-url", url: "http://example.com/missing.dig" });

    expect(sent.some((m) => (m as { type: string }).type === "sim-error")).toBe(true);
  });

  it("loadUrl- empty URL sends sim-error", async () => {
    const { sent, dispatch } = makeAdapter();

    await dispatch({ type: "sim-load-url", url: "" });

    expect(sent).toContainEqual({ type: "sim-error", error: "No URL provided" });
  });
});

// ---------------------------------------------------------------------------
// loadData
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-load-data", () => {
  it("loadData- hook called with decoded XML, sim-loaded sent", async () => {
    const xml = "<circuit>test xml</circuit>";
    const base64 = btoa(xml);
    const { sent, dispatch, hooks } = makeAdapter();

    await dispatch({ type: "sim-load-data", data: base64 });

    expect(hooks.loadCircuitXml).toHaveBeenCalledWith(xml);
    expect(sent).toContainEqual({ type: "sim-loaded" });
  });

  it("loadData- empty data sends sim-error", async () => {
    const { sent, dispatch } = makeAdapter();

    await dispatch({ type: "sim-load-data", data: "" });

    expect(sent).toContainEqual({ type: "sim-error", error: "No data provided" });
  });
});

// ---------------------------------------------------------------------------
// setBase
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-set-base", () => {
  it("setBase- HttpResolver base path updated", async () => {
    const http = new HttpResolver("old/");
    const resolver = new ChainResolver([http]);
    const { dispatch, hooks } = makeAdapter({}, resolver);

    await dispatch({ type: "sim-set-base", basePath: "new/" });

    expect(http.getBasePath()).toBe("new/");
    expect(hooks.setBasePath).toHaveBeenCalledWith("new/");
  });

  it("setBase- CacheResolver cache cleared", async () => {
    const directCache = new CacheResolver();
    directCache.set("Y", "<circuit/>");
    expect(directCache.size).toBe(1);

    const { dispatch } = makeAdapter({}, directCache);
    await dispatch({ type: "sim-set-base", basePath: "updated/" });

    expect(directCache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// setLocked
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-set-locked", () => {
  it("locked state toggled and hook called", async () => {
    const { adapter, dispatch, hooks } = makeAdapter();

    expect(adapter.locked).toBe(false);

    await dispatch({ type: "sim-set-locked", locked: true });
    expect(adapter.locked).toBe(true);
    expect(hooks.setLocked).toHaveBeenCalledWith(true);

    await dispatch({ type: "sim-set-locked", locked: false });
    expect(adapter.locked).toBe(false);
    expect(hooks.setLocked).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// setPalette
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-set-palette", () => {
  it("setPalette- hook called with component names", async () => {
    const { sent, dispatch, hooks } = makeAdapter();

    await dispatch({ type: "sim-set-palette", components: ["And", "Or", "Not"] });

    expect(hooks.setPalette).toHaveBeenCalledWith(["And", "Or", "Not"]);
    expect(sent).toContainEqual({ type: "sim-loaded" });
  });

  it("setPalette- null clears allowlist", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "sim-set-palette", components: null });

    expect(hooks.setPalette).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// getCircuit
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-get-circuit", () => {
  it("getCircuit- serializeDts hook preferred: produces dts-json-base64 format", async () => {
    const dtsJson = JSON.stringify({ format: "dts", version: 1, circuit: { name: "test", elements: [], wires: [] } });
    const { sent, dispatch } = makeAdapter({
      serializeDts: () => dtsJson,
      serializeCircuit: () => "<circuit>xml</circuit>",
    });

    await dispatch({ type: "sim-get-circuit" });

    const msg = sent.find((m) => (m as { type: string }).type === "sim-circuit-data") as {
      type: string;
      data: string;
      format: string;
    };
    expect(msg).toBeTruthy();
    expect(msg.format).toBe("dts-json-base64");
    expect(atob(msg.data)).toBe(dtsJson);
  });

  it("getCircuit- falls back to dig-xml-base64 when serializeDts not provided", async () => {
    const { sent, dispatch } = makeAdapter({
      serializeCircuit: () => "<circuit>serialized</circuit>",
    });

    await dispatch({ type: "sim-get-circuit" });

    const msg = sent.find((m) => (m as { type: string }).type === "sim-circuit-data") as {
      type: string;
      data: string;
      format: string;
    };
    expect(msg).toBeTruthy();
    expect(msg.format).toBe("dig-xml-base64");
    expect(atob(msg.data)).toBe("<circuit>serialized</circuit>");
  });

  it("getCircuit- no hooks at all sends sim-error", async () => {
    const { sent, dispatch } = makeAdapter({});

    await dispatch({ type: "sim-get-circuit" });

    expect(sent.some((m) => (m as { type: string }).type === "sim-error")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sim-load-data with DTS JSON format
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-load-data DTS detection", () => {
  it("load-data with DTS JSON base64 calls loadCircuitXml (via dig fallback)", async () => {
    const registry = createDefaultRegistry();
    const circuit = new Circuit({ name: "dts-load-test" });
    const { serializeCircuit: serializeDtsCircuit } = await import("../dts-serializer.js");
    const dtsJson = serializeDtsCircuit(circuit);
    const b64 = btoa(dtsJson);

    const loadCircuitXml = vi.fn();
    const sent: unknown[] = [];
    const target = { postMessage: vi.fn((msg) => sent.push(msg)) };
    const listeners: Array<(e: MessageEvent) => void> = [];
    const eventSource = {
      addEventListener: vi.fn((_type: string, handler: (e: MessageEvent) => void) => {
        listeners.push(handler);
      }),
    };

    const { ChainResolver, HttpResolver, CacheResolver } = await import("../file-resolver.js");
    const resolver = new ChainResolver([new CacheResolver(), new HttpResolver("./")]);

    const adapter = new PostMessageAdapter({
      registry,
      resolver,
      target,
      eventSource,
      hooks: { loadCircuitXml },
    });

    const dispatch = async (data: unknown) => {
      const event = { data } as MessageEvent;
      for (const l of listeners) await l(event);
      await new Promise((r) => setTimeout(r, 0));
    };

    void adapter;
    await dispatch({ type: "sim-load-data", data: b64 });

    expect(sent).toContainEqual({ type: "sim-loaded" });
    expect(loadCircuitXml).toHaveBeenCalledTimes(1);
  });

  it("load-data with XML base64 still routes to loadCircuitXml as XML", async () => {
    const xml = "<circuit>test</circuit>";
    const b64 = btoa(xml);
    const loadCircuitXml = vi.fn();
    const { sent, dispatch } = makeAdapter({ loadCircuitXml });

    await dispatch({ type: "sim-load-data", data: b64 });

    expect(loadCircuitXml).toHaveBeenCalledWith(xml);
    expect(sent).toContainEqual({ type: "sim-loaded" });
  });
});

// ---------------------------------------------------------------------------
// highlight
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-highlight", () => {
  it("highlight- hook called with labels and duration", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "sim-highlight", labels: ["A", "B"], duration: 5000 });

    expect(hooks.highlight).toHaveBeenCalledWith(["A", "B"], 5000);
  });

  it("highlight- default duration 3000ms", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "sim-highlight", labels: ["X"] });

    expect(hooks.highlight).toHaveBeenCalledWith(["X"], 3000);
  });

  it("highlight- non-array labels sends error", async () => {
    const { sent, dispatch } = makeAdapter();

    await dispatch({ type: "sim-highlight", labels: "not-an-array" });

    expect(sent).toContainEqual({
      type: "sim-error",
      error: "highlight requires labels array",
    });
  });
});

// ---------------------------------------------------------------------------
// clearHighlight
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-clear-highlight", () => {
  it("clearHighlight- hook called", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "sim-clear-highlight" });

    expect(hooks.clearHighlight).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setReadonlyComponents
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-set-readonly-components", () => {
  it("setReadonlyComponents- hook called with labels", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "sim-set-readonly-components", labels: ["A", "B"] });

    expect(hooks.setReadonlyComponents).toHaveBeenCalledWith(["A", "B"]);
  });

  it("setReadonlyComponents- null clears all", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "sim-set-readonly-components", labels: null });

    expect(hooks.setReadonlyComponents).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// setInstructions
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-set-instructions", () => {
  it("setInstructions- hook called with markdown", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "sim-set-instructions", markdown: "# Hello" });

    expect(hooks.setInstructions).toHaveBeenCalledWith("# Hello");
  });

  it("setInstructions- null hides panel", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "sim-set-instructions", markdown: null });

    expect(hooks.setInstructions).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// error handling
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- error handling", () => {
  it("hook error sends sim-error response", async () => {
    const { sent, dispatch } = makeAdapter({
      loadCircuitXml: vi.fn().mockImplementation(() => {
        throw new Error("parse failure");
      }),
    });

    await dispatch({ type: "sim-load-data", data: btoa("<bad-circuit/>") });

    const errorMsgs = sent.filter(
      (m) => (m as { type: string }).type === "sim-error",
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
// step delegation- hooks.step called when present
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-step delegation", () => {
  it("sim-step delegates to hooks.step when provided", async () => {
    const stepHook = vi.fn();
    const { dispatch } = makeAdapter({ step: stepHook });

    await dispatch({ type: "sim-step" });

    expect(stepHook).toHaveBeenCalledTimes(1);
  });

  it("sim-set-signal delegates to hooks.setSignal when provided", async () => {
    const setSignalHook = vi.fn();
    const { dispatch } = makeAdapter({ setSignal: setSignalHook });

    await dispatch({ type: "sim-set-signal", label: "A", value: 1 });

    expect(setSignalHook).toHaveBeenCalledWith("A", 1);
  });

  it("sim-read-signal delegates to hooks.readSignal when provided", async () => {
    const readSignalHook = vi.fn().mockReturnValue(1);
    const { sent, dispatch } = makeAdapter({ readSignal: readSignalHook });

    await dispatch({ type: "sim-read-signal", label: "Q" });

    expect(readSignalHook).toHaveBeenCalledWith("Q");
    expect(sent).toContainEqual({ type: "sim-output", label: "Q", value: 1 });
  });

  it("sim-read-all-signals delegates to hooks.readAllSignals when provided", async () => {
    const readAllHook = vi.fn().mockReturnValue({ A: 1, B: 0 });
    const { sent, dispatch } = makeAdapter({ readAllSignals: readAllHook });

    await dispatch({ type: "sim-read-all-signals" });

    expect(readAllHook).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual({ type: "sim-signals", signals: { A: 1, B: 0 }, simTime: null });
  });
});

// ---------------------------------------------------------------------------
// Regression canary: sim-step via postMessage advances clocks
//
// This tests the specific bug class from spec section 9:
// "sequential circuit with Clock works in MCP circuit_test but
//  flip-flops don't toggle via PostMessage sim-step"
// ---------------------------------------------------------------------------

describe("PostMessageAdapter- sim-step clock canary", () => {
  it("sim-step via postMessage advances clocks- D flip-flop latches input", async () => {
    const registry = createDefaultRegistry();
    const facade = new DefaultSimulatorFacade(registry);

    // Build a D flip-flop circuit: Clock + D input → D_FF → Q output
    const circuit = facade.build({
      components: [
        { id: "clk", type: "Clock", props: { label: "CLK" } },
        { id: "d",   type: "In",    props: { label: "D",   bitWidth: 1 } },
        { id: "ff",  type: "D_FF" },
        { id: "q",   type: "Out",   props: { label: "Q" } },
      ],
      connections: [
        ["clk:out", "ff:C"],
        ["d:out",   "ff:D"],
        ["ff:Q",    "q:in"],
      ],
    });

    // Compile the circuit via the facade
    const engine = facade.compile(circuit);

    // Build adapter with hooks wired to the facade
    const sent: unknown[] = [];
    const listeners: Array<(e: MessageEvent) => void> = [];

    const adapter = new PostMessageAdapter({
      registry,
      resolver: new CacheResolver(),
      target: { postMessage: (msg: unknown) => { sent.push(msg); } },
      eventSource: { addEventListener: (_t: string, h: (e: MessageEvent) => void) => { listeners.push(h); } },
      hooks: {
        getCircuit: () => circuit,
        step() { facade.step(engine); },
        setSignal(label: string, value: number) { facade.setSignal(engine, label, value); },
        readSignal(label: string): number { return facade.readSignal(engine, label); },
        readAllSignals(): Record<string, number> { return facade.readAllSignals(engine); },
        getFacade() { return facade; },
      },
    });
    void adapter;

    const dispatch = async (data: unknown): Promise<void> => {
      const event = { data } as MessageEvent;
      for (const listener of listeners) await listener(event);
      await new Promise((r) => setTimeout(r, 0));
    };

    // Read Q before any stepping- FF not yet latched, Q must be 0
    await dispatch({ type: "sim-read-signal", label: "Q" });
    const initialOutputMsg = sent.find(
      (m) => (m as { type: string }).type === "sim-output",
    ) as { type: string; label: string; value: number } | undefined;
    expect(initialOutputMsg).toBeTruthy();
    expect(initialOutputMsg!.label).toBe("Q");
    expect(initialOutputMsg!.value).toBe(0);

    // Set D=1
    await dispatch({ type: "sim-set-signal", label: "D", value: 1 });

    // Step once to advance clock edge and propagate- Q must become 1
    await dispatch({ type: "sim-step" });

    // Read Q after stepping
    sent.length = 0; // clear previous messages so find() returns the new one
    await dispatch({ type: "sim-read-signal", label: "Q" });

    const outputMsg = sent.find(
      (m) => (m as { type: string }).type === "sim-output",
    ) as { type: string; label: string; value: number } | undefined;

    expect(outputMsg).toBeTruthy();
    expect(outputMsg!.label).toBe("Q");
    expect(outputMsg!.value).toBe(1);
  });
});

/**
 * Tests for PostMessageAdapter.
 *
 * Verifies the postMessage wire protocol adapter. All dependencies are
 * injected via the options object so tests run without a real browser.
 *
 * Test scenarios:
 *   readyOnInit     — digital-ready sent when adapter is initialized
 *   loadUrl         — digital-load-url → hook called, digital-loaded sent
 *   loadData        — digital-load-data with base64 .dig → hook called
 *   setBase         — digital-set-base → resolver base path updated, cache cleared
 *   setLocked       — digital-set-locked → hook called, locked state updated
 *   setPalette      — digital-set-palette → hook called
 *   test            — digital-test → digital-test-result response
 *   getCircuit      — digital-get-circuit → digital-circuit-data response
 *   highlight       — digital-highlight → hook called
 *   errorHandling   — message that causes error → digital-error response
 *   stepDelegation  — digital-step delegates to hooks.step when present
 *   stepClockCanary — digital-step via postMessage advances clocks (regression canary)
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
    serializeCircuit: vi.fn().mockReturnValue("<circuit/>"),
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
  it("loadUrl — hook called, digital-loaded response sent", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<circuit>xml</circuit>",
    });
    const { sent, dispatch, hooks } = makeAdapter({}, undefined, fetchFn);

    await dispatch({ type: "digital-load-url", url: "http://example.com/and.dig" });

    expect(fetchFn).toHaveBeenCalledWith("http://example.com/and.dig");
    expect(hooks.loadCircuitXml).toHaveBeenCalledWith("<circuit>xml</circuit>");
    expect(sent).toContainEqual({ type: "digital-loaded" });
  });

  it("loadUrl — fetch failure sends digital-error", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, text: async () => "" });
    const { sent, dispatch } = makeAdapter({}, undefined, fetchFn);

    await dispatch({ type: "digital-load-url", url: "http://example.com/missing.dig" });

    expect(sent.some((m) => (m as { type: string }).type === "digital-error")).toBe(true);
  });

  it("loadUrl — empty URL sends digital-error", async () => {
    const { sent, dispatch } = makeAdapter();

    await dispatch({ type: "digital-load-url", url: "" });

    expect(sent).toContainEqual({ type: "digital-error", error: "No URL provided" });
  });
});

// ---------------------------------------------------------------------------
// loadData
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-load-data", () => {
  it("loadData — hook called with decoded XML, digital-loaded sent", async () => {
    const xml = "<circuit>test xml</circuit>";
    const base64 = btoa(xml);
    const { sent, dispatch, hooks } = makeAdapter();

    await dispatch({ type: "digital-load-data", data: base64 });

    expect(hooks.loadCircuitXml).toHaveBeenCalledWith(xml);
    expect(sent).toContainEqual({ type: "digital-loaded" });
  });

  it("loadData — empty data sends digital-error", async () => {
    const { sent, dispatch } = makeAdapter();

    await dispatch({ type: "digital-load-data", data: "" });

    expect(sent).toContainEqual({ type: "digital-error", error: "No data provided" });
  });
});

// ---------------------------------------------------------------------------
// setBase
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-set-base", () => {
  it("setBase — HttpResolver base path updated", async () => {
    const http = new HttpResolver("old/");
    const resolver = new ChainResolver([http]);
    const { dispatch, hooks } = makeAdapter({}, resolver);

    await dispatch({ type: "digital-set-base", basePath: "new/" });

    expect(http.getBasePath()).toBe("new/");
    expect(hooks.setBasePath).toHaveBeenCalledWith("new/");
  });

  it("setBase — CacheResolver cache cleared", async () => {
    const directCache = new CacheResolver();
    directCache.set("Y", "<circuit/>");
    expect(directCache.size).toBe(1);

    const { dispatch } = makeAdapter({}, directCache);
    await dispatch({ type: "digital-set-base", basePath: "updated/" });

    expect(directCache.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// setLocked
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-set-locked", () => {
  it("locked state toggled and hook called", async () => {
    const { adapter, dispatch, hooks } = makeAdapter();

    expect(adapter.locked).toBe(false);

    await dispatch({ type: "digital-set-locked", locked: true });
    expect(adapter.locked).toBe(true);
    expect(hooks.setLocked).toHaveBeenCalledWith(true);

    await dispatch({ type: "digital-set-locked", locked: false });
    expect(adapter.locked).toBe(false);
    expect(hooks.setLocked).toHaveBeenCalledWith(false);
  });
});

// ---------------------------------------------------------------------------
// setPalette
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-set-palette", () => {
  it("setPalette — hook called with component names", async () => {
    const { sent, dispatch, hooks } = makeAdapter();

    await dispatch({ type: "digital-set-palette", components: ["And", "Or", "Not"] });

    expect(hooks.setPalette).toHaveBeenCalledWith(["And", "Or", "Not"]);
    expect(sent).toContainEqual({ type: "digital-loaded" });
  });

  it("setPalette — null clears allowlist", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "digital-set-palette", components: null });

    expect(hooks.setPalette).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// getCircuit
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-get-circuit", () => {
  it("getCircuit — digital-circuit-data response with base64 XML", async () => {
    const { sent, dispatch } = makeAdapter({
      serializeCircuit: () => "<circuit>serialized</circuit>",
    });

    await dispatch({ type: "digital-get-circuit" });

    const msg = sent.find((m) => (m as { type: string }).type === "digital-circuit-data") as {
      type: string;
      data: string;
      format: string;
    };
    expect(msg).toBeTruthy();
    expect(msg.format).toBe("dig-xml-base64");
    expect(atob(msg.data)).toBe("<circuit>serialized</circuit>");
  });
});

// ---------------------------------------------------------------------------
// highlight
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-highlight", () => {
  it("highlight — hook called with labels and duration", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "digital-highlight", labels: ["A", "B"], duration: 5000 });

    expect(hooks.highlight).toHaveBeenCalledWith(["A", "B"], 5000);
  });

  it("highlight — default duration 3000ms", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "digital-highlight", labels: ["X"] });

    expect(hooks.highlight).toHaveBeenCalledWith(["X"], 3000);
  });

  it("highlight — non-array labels sends error", async () => {
    const { sent, dispatch } = makeAdapter();

    await dispatch({ type: "digital-highlight", labels: "not-an-array" });

    expect(sent).toContainEqual({
      type: "digital-error",
      error: "highlight requires labels array",
    });
  });
});

// ---------------------------------------------------------------------------
// clearHighlight
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-clear-highlight", () => {
  it("clearHighlight — hook called", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "digital-clear-highlight" });

    expect(hooks.clearHighlight).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setReadonlyComponents
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-set-readonly-components", () => {
  it("setReadonlyComponents — hook called with labels", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "digital-set-readonly-components", labels: ["A", "B"] });

    expect(hooks.setReadonlyComponents).toHaveBeenCalledWith(["A", "B"]);
  });

  it("setReadonlyComponents — null clears all", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "digital-set-readonly-components", labels: null });

    expect(hooks.setReadonlyComponents).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// setInstructions
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-set-instructions", () => {
  it("setInstructions — hook called with markdown", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "digital-set-instructions", markdown: "# Hello" });

    expect(hooks.setInstructions).toHaveBeenCalledWith("# Hello");
  });

  it("setInstructions — null hides panel", async () => {
    const { dispatch, hooks } = makeAdapter();

    await dispatch({ type: "digital-set-instructions", markdown: null });

    expect(hooks.setInstructions).toHaveBeenCalledWith(null);
  });
});

// ---------------------------------------------------------------------------
// error handling
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — error handling", () => {
  it("hook error sends digital-error response", async () => {
    const { sent, dispatch } = makeAdapter({
      loadCircuitXml: vi.fn().mockImplementation(() => {
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
// step delegation — hooks.step called when present
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-step delegation", () => {
  it("digital-step delegates to hooks.step when provided", async () => {
    const stepHook = vi.fn();
    const { dispatch } = makeAdapter({ step: stepHook });

    await dispatch({ type: "digital-step" });

    expect(stepHook).toHaveBeenCalledTimes(1);
  });

  it("digital-set-input delegates to hooks.setInput when provided", async () => {
    const setInputHook = vi.fn();
    const { dispatch } = makeAdapter({ setInput: setInputHook });

    await dispatch({ type: "digital-set-input", label: "A", value: 1 });

    expect(setInputHook).toHaveBeenCalledWith("A", 1);
  });

  it("digital-read-output delegates to hooks.readOutput when provided", async () => {
    const readOutputHook = vi.fn().mockReturnValue(1);
    const { sent, dispatch } = makeAdapter({ readOutput: readOutputHook });

    await dispatch({ type: "digital-read-output", label: "Q" });

    expect(readOutputHook).toHaveBeenCalledWith("Q");
    expect(sent).toContainEqual({ type: "digital-output", label: "Q", value: 1 });
  });

  it("digital-read-all-signals delegates to hooks.readAllSignals when provided", async () => {
    const readAllHook = vi.fn().mockReturnValue({ A: 1, B: 0 });
    const { sent, dispatch } = makeAdapter({ readAllSignals: readAllHook });

    await dispatch({ type: "digital-read-all-signals" });

    expect(readAllHook).toHaveBeenCalledTimes(1);
    expect(sent).toContainEqual({ type: "digital-signals", signals: { A: 1, B: 0 } });
  });
});

// ---------------------------------------------------------------------------
// Regression canary: digital-step via postMessage advances clocks
//
// This tests the specific bug class from spec section 9:
// "sequential circuit with Clock works in MCP circuit_test but
//  flip-flops don't toggle via PostMessage digital-step"
// ---------------------------------------------------------------------------

describe("PostMessageAdapter — digital-step clock canary", () => {
  it("digital-step via postMessage advances clocks — D flip-flop latches input", async () => {
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
        setInput(label: string, value: number) { facade.setInput(engine, label, value); },
        readOutput(label: string): number { return facade.readOutput(engine, label); },
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

    // Read Q before any stepping — FF not yet latched, Q must be 0
    await dispatch({ type: "digital-read-output", label: "Q" });
    const initialOutputMsg = sent.find(
      (m) => (m as { type: string }).type === "digital-output",
    ) as { type: string; label: string; value: number } | undefined;
    expect(initialOutputMsg).toBeTruthy();
    expect(initialOutputMsg!.label).toBe("Q");
    expect(initialOutputMsg!.value).toBe(0);

    // Set D=1
    await dispatch({ type: "digital-set-input", label: "D", value: 1 });

    // Step once to advance clock edge and propagate — Q must become 1
    await dispatch({ type: "digital-step" });

    // Read Q after stepping
    sent.length = 0; // clear previous messages so find() returns the new one
    await dispatch({ type: "digital-read-output", label: "Q" });

    const outputMsg = sent.find(
      (m) => (m as { type: string }).type === "digital-output",
    ) as { type: string; label: string; value: number } | undefined;

    expect(outputMsg).toBeTruthy();
    expect(outputMsg!.label).toBe("Q");
    expect(outputMsg!.value).toBe(1);
  });
});

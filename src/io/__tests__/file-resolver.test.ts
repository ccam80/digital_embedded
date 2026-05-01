/**
 * Tests for file-resolver.ts- FileResolver implementations.
 */

import { describe, it, expect, vi } from "vitest";
import {
  EmbeddedResolver,
  CacheResolver,
  HttpResolver,
  NodeResolver,
  ChainResolver,
  ResolverNotFoundError,
  createDefaultResolver,
} from "../file-resolver.js";

// ---------------------------------------------------------------------------
// EmbeddedResolver
// ---------------------------------------------------------------------------

describe("EmbeddedResolver", () => {
  it("embeddedResolver- resolves name present in embedded map", async () => {
    const map = new Map([
      ["FullAdder", "<circuit>full adder xml</circuit>"],
      ["HalfAdder", "<circuit>half adder xml</circuit>"],
    ]);
    const resolver = new EmbeddedResolver(map);

    const content = await resolver.resolve("FullAdder");
    expect(content).toBe("<circuit>full adder xml</circuit>");
  });

  it("accepts plain object as initial map", async () => {
    const resolver = new EmbeddedResolver({
      MyCircuit: "<circuit>my xml</circuit>",
    });
    const content = await resolver.resolve("MyCircuit");
    expect(content).toBe("<circuit>my xml</circuit>");
  });

  it("embeddedMiss- resolves name not in embedded map throws ResolverNotFoundError", async () => {
    const resolver = new EmbeddedResolver(new Map());
    await expect(resolver.resolve("Missing")).rejects.toThrow(ResolverNotFoundError);
    await expect(resolver.resolve("Missing")).rejects.toThrow("Missing");
  });

  it("embeddedMiss- error carries the circuit name", async () => {
    const resolver = new EmbeddedResolver(new Map([["A", "<circuit/>"]]));
    try {
      await resolver.resolve("NotHere");
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ResolverNotFoundError);
      expect((e as ResolverNotFoundError).name_).toBe("NotHere");
    }
  });
});

// ---------------------------------------------------------------------------
// CacheResolver
// ---------------------------------------------------------------------------

describe("CacheResolver", () => {
  it("cacheResolver- resolves from pre-populated cache", async () => {
    const cache = new CacheResolver(new Map([["SR", "<circuit>sr latch</circuit>"]]));
    const content = await cache.resolve("SR");
    expect(content).toBe("<circuit>sr latch</circuit>");
  });

  it("set and resolve", async () => {
    const cache = new CacheResolver();
    cache.set("X", "<circuit>x</circuit>");
    const content = await cache.resolve("X");
    expect(content).toBe("<circuit>x</circuit>");
  });

  it("has- returns true for cached name", () => {
    const cache = new CacheResolver();
    cache.set("Y", "<circuit/>");
    expect(cache.has("Y")).toBe(true);
    expect(cache.has("Z")).toBe(false);
  });

  it("size- tracks number of entries", () => {
    const cache = new CacheResolver();
    expect(cache.size).toBe(0);
    cache.set("A", "<circuit/>");
    cache.set("B", "<circuit/>");
    expect(cache.size).toBe(2);
  });

  it("clear- removes all entries", async () => {
    const cache = new CacheResolver();
    cache.set("A", "<circuit/>");
    cache.clear();
    expect(cache.size).toBe(0);
    await expect(cache.resolve("A")).rejects.toThrow(ResolverNotFoundError);
  });

  it("miss- throws ResolverNotFoundError", async () => {
    const cache = new CacheResolver();
    await expect(cache.resolve("NotCached")).rejects.toThrow(ResolverNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// HttpResolver
// ---------------------------------------------------------------------------

describe("HttpResolver", () => {
  it("resolves via HTTP fetch", async () => {
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "<circuit>fetched</circuit>",
    });
    const resolver = new HttpResolver("circuits/", fetchFn);
    const content = await resolver.resolve("AndGate");
    expect(fetchFn).toHaveBeenCalledWith("circuits/AndGate.dig");
    expect(content).toBe("<circuit>fetched</circuit>");
  });

  it("throws ResolverNotFoundError when fetch returns non-ok", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, text: async () => "" });
    const resolver = new HttpResolver("circuits/", fetchFn);
    await expect(resolver.resolve("Missing")).rejects.toThrow(ResolverNotFoundError);
  });

  it("getBasePath and setBasePath", () => {
    const resolver = new HttpResolver("original/");
    expect(resolver.getBasePath()).toBe("original/");
    resolver.setBasePath("updated/");
    expect(resolver.getBasePath()).toBe("updated/");
  });

  it("default basePath is ./", () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    const resolver = new HttpResolver(undefined, fetchFn);
    resolver.resolve("X");
    expect(fetchFn).toHaveBeenCalledWith("./X.dig");
  });
});

// ---------------------------------------------------------------------------
// NodeResolver
// ---------------------------------------------------------------------------

describe("NodeResolver", () => {
  it("resolves by calling readFileFn with path", async () => {
    const readFileFn = vi.fn().mockResolvedValue("<circuit>node content</circuit>");
    const resolver = new NodeResolver("circuits/", readFileFn);
    const content = await resolver.resolve("HalfAdder");
    expect(readFileFn).toHaveBeenCalledWith("circuits/HalfAdder.dig");
    expect(content).toBe("<circuit>node content</circuit>");
  });

  it("throws ResolverNotFoundError when readFileFn throws", async () => {
    const readFileFn = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const resolver = new NodeResolver("circuits/", readFileFn);
    await expect(resolver.resolve("Missing")).rejects.toThrow(ResolverNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// ChainResolver
// ---------------------------------------------------------------------------

describe("ChainResolver", () => {
  it("chainOrder- chain [embedded, cache], name in cache but not embedded → cache returns it", async () => {
    const embedded = new EmbeddedResolver(new Map([["A", "<circuit>A</circuit>"]]));
    const cache = new CacheResolver();
    cache.set("B", "<circuit>B from cache</circuit>");

    const chain = new ChainResolver([embedded, cache]);

    // A is in embedded
    expect(await chain.resolve("A")).toBe("<circuit>A</circuit>");
    // B is only in cache
    expect(await chain.resolve("B")).toBe("<circuit>B from cache</circuit>");
  });

  it("first resolver wins when both have the name", async () => {
    const r1 = new EmbeddedResolver(new Map([["X", "from r1"]]));
    const r2 = new EmbeddedResolver(new Map([["X", "from r2"]]));
    const chain = new ChainResolver([r1, r2]);
    expect(await chain.resolve("X")).toBe("from r1");
  });

  it("skips resolvers that throw ResolverNotFoundError", async () => {
    const miss = new EmbeddedResolver(new Map());
    const hit = new EmbeddedResolver(new Map([["Y", "found"]]));
    const chain = new ChainResolver([miss, hit]);
    expect(await chain.resolve("Y")).toBe("found");
  });

  it("throws ResolverNotFoundError when all resolvers miss", async () => {
    const r1 = new EmbeddedResolver(new Map());
    const r2 = new EmbeddedResolver(new Map());
    const chain = new ChainResolver([r1, r2]);
    await expect(chain.resolve("Z")).rejects.toThrow(ResolverNotFoundError);
  });

  it("propagates non-ResolverNotFoundError immediately", async () => {
    const badResolver: FileResolver = {
      resolve: async () => {
        throw new Error("Network error");
      },
    };
    const fallback = new EmbeddedResolver(new Map([["Z", "ok"]]));
    const chain = new ChainResolver([badResolver, fallback]);
    await expect(chain.resolve("Z")).rejects.toThrow("Network error");
  });

  it("empty chain throws ResolverNotFoundError", async () => {
    const chain = new ChainResolver([]);
    await expect(chain.resolve("anything")).rejects.toThrow(ResolverNotFoundError);
  });
});

// ---------------------------------------------------------------------------
// createDefaultResolver
// ---------------------------------------------------------------------------

describe("createDefaultResolver", () => {
  it("returns a FileResolver", () => {
    const resolver = createDefaultResolver("./");
    expect(typeof resolver.resolve).toBe("function");
  });
});

// Re-import FileResolver type for the test
type FileResolver = import("../file-resolver.js").FileResolver;

/**
 * Tests for HGS file resolvers- task 4.3.5.
 */

import { describe, it, expect } from "vitest";
import { BrowserFileResolver, NodeFileResolver } from "../file-resolver";

describe("BrowserFileResolver", () => {
  it("findsPreloadedFile", async () => {
    const resolver = new BrowserFileResolver();
    const data = new Uint8Array([0x01, 0x02, 0x03]);
    resolver.addFile("rom.hex", data);

    const result = await resolver.resolve("rom.hex", "");
    expect(result).toEqual(data);
  });

  it("throwsOnMissing", async () => {
    const resolver = new BrowserFileResolver();
    await expect(resolver.resolve("missing.hex", "")).rejects.toThrow(/not found/i);
  });

  it("matchesByBasename", async () => {
    const resolver = new BrowserFileResolver();
    const data = new Uint8Array([0xAA, 0xBB]);
    resolver.addFile("rom.hex", data);

    const result = await resolver.resolve("path/to/rom.hex", "");
    expect(result).toEqual(data);
  });

  it("storesMultipleFiles", async () => {
    const resolver = new BrowserFileResolver();
    resolver.addFile("a.hex", new Uint8Array([1]));
    resolver.addFile("b.hex", new Uint8Array([2]));

    expect(resolver.size).toBe(2);
    expect((await resolver.resolve("a.hex", ""))[0]).toBe(1);
    expect((await resolver.resolve("b.hex", ""))[0]).toBe(2);
  });

  it("clearRemovesAllFiles", async () => {
    const resolver = new BrowserFileResolver();
    resolver.addFile("rom.hex", new Uint8Array([1]));
    resolver.clear();

    expect(resolver.size).toBe(0);
    await expect(resolver.resolve("rom.hex", "")).rejects.toThrow();
  });

  it("throwsDescriptiveMessage", async () => {
    const resolver = new BrowserFileResolver();
    const err = await resolver.resolve("missing.hex", "").catch((e: unknown) => e);
    expect((err as Error).message).toContain("missing.hex");
  });
});

describe("NodeFileResolver", () => {
  it("resolvesFileFromRootPath", async () => {
    const data = new Uint8Array([0x01, 0x02]);
    const readFileFn = async (path: string): Promise<Uint8Array> => {
      if (path === "/circuits/rom.hex") return data;
      throw new Error(`File not found: ${path}`);
    };

    const resolver = new NodeFileResolver(readFileFn);
    const result = await resolver.resolve("rom.hex", "/circuits");
    expect(result).toEqual(data);
  });

  it("throwsOnReadFailure", async () => {
    const readFileFn = async (_path: string): Promise<Uint8Array> => {
      throw new Error("ENOENT: no such file");
    };

    const resolver = new NodeFileResolver(readFileFn);
    await expect(resolver.resolve("missing.hex", "/circuits")).rejects.toThrow(/Cannot read file/i);
  });

  it("handlesEmptyRootPath", async () => {
    const data = new Uint8Array([0xFF]);
    const readFileFn = async (path: string): Promise<Uint8Array> => {
      if (path === "rom.hex") return data;
      throw new Error(`not found: ${path}`);
    };

    const resolver = new NodeFileResolver(readFileFn);
    const result = await resolver.resolve("rom.hex", "");
    expect(result).toEqual(data);
  });
});

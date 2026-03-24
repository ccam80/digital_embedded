/**
 * HGS file resolver implementations.
 *
 * The FileResolver interface is defined in context.ts. This module provides
 * concrete implementations for browser and Node.js environments.
 *
 * BrowserFileResolver: uses a pre-loaded Map<string, Uint8Array> populated
 *   by drag-and-drop, <input type="file">, or fetch().
 *
 * NodeFileResolver: reads files from the filesystem using an injected
 *   readFileFn to avoid direct fs imports in browser-safe code.
 */

import type { FileResolver } from "./context";

// ---------------------------------------------------------------------------
// BrowserFileResolver
// ---------------------------------------------------------------------------

/**
 * Resolves HGS file references from a pre-loaded in-memory map.
 *
 * Filenames are matched by basename only (ignoring leading path components
 * from the rootPath). The caller must populate the resolver before running
 * any HGS code that calls loadHex() or loadFile().
 */
export class BrowserFileResolver implements FileResolver {
  private readonly _files: Map<string, Uint8Array>;

  constructor(initial?: Map<string, Uint8Array>) {
    this._files = initial ? new Map(initial) : new Map();
  }

  /**
   * Pre-load a file so it can be resolved by name later.
   */
  addFile(name: string, data: Uint8Array): void {
    this._files.set(name, data);
  }

  /**
   * Remove all pre-loaded files.
   */
  clear(): void {
    this._files.clear();
  }

  /**
   * Number of pre-loaded files.
   */
  get size(): number {
    return this._files.size;
  }

  async resolve(filename: string, _rootPath: string): Promise<Uint8Array> {
    const data = this._files.get(filename);
    if (data !== undefined) return data;

    // Also try matching by basename in case a path was passed
    const basename = filename.split("/").pop() ?? filename;
    const byBasename = this._files.get(basename);
    if (byBasename !== undefined) return byBasename;

    throw new Error(
      `File not found: "${filename}". Please load the file first using the file loader.`,
    );
  }
}

// ---------------------------------------------------------------------------
// NodeFileResolver
// ---------------------------------------------------------------------------

/**
 * Resolves HGS file references by reading from the filesystem.
 *
 * The readFileFn dependency is injected rather than importing fs directly,
 * keeping this module safe for bundlers that target the browser.
 *
 * Usage in Node.js:
 *   import { readFile } from "fs/promises";
 *   const resolver = new NodeFileResolver(
 *     async (path) => { const buf = await readFile(path); return new Uint8Array(buf); }
 *   );
 */
export class NodeFileResolver implements FileResolver {
  private readonly _readFileFn: (path: string) => Promise<Uint8Array>;

  constructor(readFileFn: (path: string) => Promise<Uint8Array>) {
    this._readFileFn = readFileFn;
  }

  async resolve(filename: string, rootPath: string): Promise<Uint8Array> {
    const separator = rootPath.endsWith("/") || rootPath.length === 0 ? "" : "/";
    const fullPath = rootPath.length > 0 ? `${rootPath}${separator}${filename}` : filename;
    try {
      return await this._readFileFn(fullPath);
    } catch (e) {
      throw new Error(`Cannot read file "${fullPath}": ${(e as Error).message}`);
    }
  }
}

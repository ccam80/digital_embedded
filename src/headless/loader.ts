/**
 * SimulationLoader — headless .dig and JSON circuit loading.
 *
 * Chains: XML string → parseDigXml() → DigCircuit → loadDigCircuit() → Circuit.
 *
 * Environment detection:
 *   - If the argument starts with "<": parse as XML directly (both environments).
 *   - Node.js: otherwise treat as a file path, read via fs.readFile().
 *   - Browser: otherwise treat as a URL, fetch() it.
 */

import type { ComponentRegistry } from "../core/registry.js";
import type { Circuit } from "../core/circuit.js";
import { parseDigXml } from "../io/dig-parser.js";
import { loadDigCircuit } from "../io/dig-loader.js";
import { deserializeDts } from "../io/dts-deserializer.js";

// ---------------------------------------------------------------------------
// Environment detection
// ---------------------------------------------------------------------------

/**
 * Returns true when running in a Node.js environment (not a browser).
 * Detection: `process` object exists and has a `versions.node` field.
 */
function isNodeEnvironment(): boolean {
  return (
    typeof process !== "undefined" &&
    process.versions != null &&
    process.versions.node != null
  );
}

// ---------------------------------------------------------------------------
// XML content acquisition
// ---------------------------------------------------------------------------

/**
 * Acquire the XML string for a .dig file from the Node.js filesystem.
 * Reads the file at `pathOrXml` as UTF-8 text.
 */
async function readFileNode(filePath: string): Promise<string> {
  const { readFile } = await import("fs/promises");
  return readFile(filePath, "utf-8");
}

/**
 * Acquire the XML string for a .dig file via browser fetch().
 * Treats `pathOrXml` as a URL.
 */
async function fetchBrowser(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `SimulationLoader: failed to fetch "${url}": ${response.status} ${response.statusText}`,
    );
  }
  return response.text();
}

// ---------------------------------------------------------------------------
// SimulationLoader
// ---------------------------------------------------------------------------

/**
 * Loader module for the SimulatorFacade.
 *
 * Handles both .dig XML import and native JSON load.
 * Environment-aware: uses fs.readFile() in Node.js and fetch() in the browser.
 */
export class SimulationLoader {
  private readonly _registry: ComponentRegistry;

  constructor(registry: ComponentRegistry) {
    this._registry = registry;
  }

  /**
   * Load a .dig circuit from an XML string or a file/URL path.
   *
   * - If `pathOrXml` starts with `<`: parse as .dig XML directly.
   * - Node.js: otherwise read the file at `pathOrXml` from the filesystem.
   * - Browser: otherwise fetch the URL at `pathOrXml`.
   *
   * Returns the assembled Circuit.
   */
  async loadDig(pathOrXml: string): Promise<Circuit> {
    let xml: string;

    if (pathOrXml.trimStart().startsWith("<")) {
      xml = pathOrXml;
    } else if (isNodeEnvironment()) {
      xml = await readFileNode(pathOrXml);
    } else {
      xml = await fetchBrowser(pathOrXml);
    }

    const parsed = parseDigXml(xml);
    return loadDigCircuit(parsed, this._registry);
  }

  /**
   * Load a circuit from a native JSON string produced by serializeCircuit().
   * Synchronous — JSON parsing and element construction require no I/O.
   */
  loadJson(json: string): Circuit {
    return deserializeDts(json, this._registry);
  }
}

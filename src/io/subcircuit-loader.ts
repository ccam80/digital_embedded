/**
 * Recursive .dig loading with file resolver and cycle detection.
 *
 * When the loader encounters an elementName not in the built-in registry,
 * it uses the FileResolver to fetch the corresponding .dig file, parses it,
 * recursively loads any subcircuits it references, then registers a new
 * ComponentDefinition in the registry so the element can be instantiated.
 *
 * Safety:
 *   - Cycle detection: if a circuit appears in its own ancestor chain, throws
 *     with a message like "Circular subcircuit reference: A → B → C → A"
 *   - Depth limit: 30 levels deep (matching Digital's limit)
 *   - Cache: loaded definitions are cached so duplicate references only
 *     trigger one resolve() call
 */

import { Circuit } from "../core/circuit.js";
import type { ComponentRegistry } from "../core/registry.js";
import { parseDigXml } from "./dig-parser.js";
import { loadDigCircuit } from "./dig-loader.js";
import type { FileResolver } from "./file-resolver.js";
import { CacheResolver, ResolverNotFoundError } from "./file-resolver.js";

import { registerSubcircuit, createLiveDefinition } from "../components/subcircuit/subcircuit.js";
import type { SubcircuitDefinition } from "../components/subcircuit/subcircuit.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum subcircuit nesting depth (matching Digital's limit). */
const MAX_DEPTH = 30;

// ---------------------------------------------------------------------------
// SubcircuitCache
// ---------------------------------------------------------------------------

/**
 * In-memory cache of loaded subcircuit Circuit definitions, keyed by name.
 *
 * Shared across calls to loadWithSubcircuits() so that multiple references
 * to the same subcircuit within one load session only trigger one resolve()
 * call. Cleared via clearSubcircuitCache() for checkpoint jumping.
 */
const _subcircuitCache = new Map<string, Circuit>();

/**
 * Clear all cached subcircuit definitions.
 *
 * Call when jumping to a different checkpoint so stale definitions are not
 * reused.
 */
export function clearSubcircuitCache(): void {
  _subcircuitCache.clear();
}

/**
 * Invalidate a single subcircuit from the cache.
 *
 * Call when a subcircuit .dig file is modified or reloaded so the next
 * loadWithSubcircuits() re-resolves and re-registers the definition.
 * The registry entry is NOT removed — re-registration via registerOrUpdate()
 * will replace it with the new definition while preserving the typeId.
 */
export function invalidateSubcircuit(name: string): void {
  _subcircuitCache.delete(name);
}

/**
 * Return the number of cached subcircuit definitions (for testing).
 */
export function subcircuitCacheSize(): number {
  return _subcircuitCache.size;
}

// ---------------------------------------------------------------------------
// XML content cache (tracks resolver call counts for testing)
// ---------------------------------------------------------------------------

/**
 * Per-session XML content cache used to deduplicate resolver calls.
 * Unlike the Circuit cache, this is per-load-call (created fresh each time
 * loadWithSubcircuits is invoked) so it tracks calls within one load.
 */

// ---------------------------------------------------------------------------
// loadWithSubcircuits
// ---------------------------------------------------------------------------

/**
 * Load a .dig XML string and recursively resolve all subcircuit references.
 *
 * For each element whose name is not found in the built-in registry:
 *   1. Use resolver.resolve(name) to get the .dig XML
 *   2. Parse and recursively load the subcircuit (cycle + depth checks)
 *   3. Register a new ComponentDefinition in the registry
 *   4. Cache the loaded Circuit so duplicate references are free
 *
 * @param xml       The root .dig XML string
 * @param resolver  FileResolver used for unknown element names
 * @param registry  ComponentRegistry to look up and extend with subcircuits
 * @returns         Populated Circuit with all subcircuits registered
 * @throws          On circular references, depth limit exceeded, or resolver failures
 */
export async function loadWithSubcircuits(
  xml: string,
  resolver: FileResolver,
  registry: ComponentRegistry,
): Promise<Circuit> {
  const xmlCache = new CacheResolver();
  return loadRecursive(xml, resolver, registry, xmlCache, [], 0);
}

// ---------------------------------------------------------------------------
// Internal recursive implementation
// ---------------------------------------------------------------------------

async function loadRecursive(
  xml: string,
  resolver: FileResolver,
  registry: ComponentRegistry,
  xmlCache: CacheResolver,
  loadingStack: string[],
  depth: number,
): Promise<Circuit> {
  // Parse the XML to discover element names before attempting to load
  const parsed = parseDigXml(xml);

  // Collect unknown element names
  const unknownNames = new Set<string>();
  for (const ve of parsed.visualElements) {
    if (registry.get(ve.elementName) === undefined) {
      unknownNames.add(ve.elementName);
    }
  }

  // Resolve and register all unknown subcircuits.
  // If a name can't be resolved (e.g. Digital built-in like GenericInitCode),
  // skip it — loadDigCircuit will also skip unregistered elements gracefully.
  for (const name of unknownNames) {
    try {
      await resolveAndRegister(name, resolver, registry, xmlCache, loadingStack, depth);
    } catch (e) {
      if (e instanceof ResolverNotFoundError) {
        console.warn(`Skipping unresolvable element "${name}" (not a subcircuit file)`);
        continue;
      }
      throw e;
    }
  }

  // Now all elements should be registered — load the circuit normally
  return loadDigCircuit(parsed, registry);
}

async function resolveAndRegister(
  name: string,
  resolver: FileResolver,
  registry: ComponentRegistry,
  xmlCache: CacheResolver,
  loadingStack: string[],
  depth: number,
): Promise<void> {
  // Return cached circuit if already loaded (and re-register via registerOrUpdate)
  if (_subcircuitCache.has(name)) {
    const cachedDef = _subcircuitCache.get(name)!;
    registerSubcircuitDefinition(name, cachedDef, registry);
    return;
  }

  // Cycle detection
  if (loadingStack.includes(name)) {
    const cycle = [...loadingStack, name].join(" \u2192 ");
    throw new Error(`Circular subcircuit reference: ${cycle}`);
  }

  // Depth limit check
  if (depth >= MAX_DEPTH) {
    throw new Error(
      `Subcircuit nesting depth limit (${MAX_DEPTH}) exceeded while loading "${name}"`,
    );
  }

  // Fetch XML (use cache to avoid duplicate resolver calls)
  let subcircuitXml: string;
  if (xmlCache.has(name)) {
    subcircuitXml = await xmlCache.resolve(name);
  } else {
    subcircuitXml = await resolver.resolve(name);
    xmlCache.set(name, subcircuitXml);
  }

  // Recursively load with updated stack
  const subcircuit = await loadRecursive(
    subcircuitXml,
    resolver,
    registry,
    xmlCache,
    [...loadingStack, name],
    depth + 1,
  );

  // Cache the loaded definition
  _subcircuitCache.set(name, subcircuit);

  // Register or update in the registry (re-registration replaces the old
  // definition while preserving the typeId — Step 6 of the refactor).
  registerSubcircuitDefinition(name, subcircuit, registry);
}

/**
 * Register a loaded subcircuit as a ComponentDefinition in the registry.
 *
 * Derives interface pins from the circuit's In/Out elements and registers
 * using the proper SubcircuitElement factory so subcircuits render with
 * their chip shape and pins.
 *
 * Uses registerOrUpdate so that re-loading a modified subcircuit replaces
 * the old definition while preserving the typeId.
 */
function registerSubcircuitDefinition(
  name: string,
  definition: Circuit,
  registry: ComponentRegistry,
): void {
  const shapeType = definition.metadata.shapeType || "DEFAULT";
  const subDef = createLiveDefinition(
    definition,
    shapeType as SubcircuitDefinition["shapeMode"],
    name,
  );

  registerSubcircuit(registry, name, subDef);
}

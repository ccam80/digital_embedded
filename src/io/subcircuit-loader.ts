/**
 * Recursive .dig loading with file resolver and cycle detection.
 *
 * When the loader encounters an elementName not in the built-in registry,
 * it uses the FileResolver to fetch the corresponding .dig file, parses it,
 * recursively loads any subcircuits it references, then accumulates the
 * resulting SubcircuitDefinition into the circuit-scoped collectedDefs map.
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

import { createLiveDefinition } from "../components/subcircuit/subcircuit.js";
import type { SubcircuitDefinition } from "../components/subcircuit/subcircuit.js";
import { MAX_DEPTH } from "../core/constants.js";

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
 *   3. Accumulate the SubcircuitDefinition into the circuit-scoped collectedDefs map
 *   4. Cache the loaded Circuit so duplicate references are free
 *
 * The collected definitions are attached to circuit.metadata.subcircuits so
 * subcircuit elements can resolve their definitions without touching the global registry.
 *
 * @param xml       The root .dig XML string
 * @param resolver  FileResolver used for unknown element names
 * @param registry  ComponentRegistry to look up built-in component types
 * @returns         Populated Circuit with subcircuit definitions on circuit.metadata
 * @throws          On circular references, depth limit exceeded, or resolver failures
 */
export async function loadWithSubcircuits(
  xml: string,
  resolver: FileResolver,
  registry: ComponentRegistry,
): Promise<Circuit> {
  const xmlCache = new CacheResolver();
  const collectedDefs = new Map<string, SubcircuitDefinition>();
  const circuit = await loadRecursive(xml, resolver, registry, xmlCache, [], 0, collectedDefs);

  // Attach all resolved subcircuit definitions to the circuit's metadata
  if (collectedDefs.size > 0) {
    circuit.metadata.subcircuits = collectedDefs;
  }

  return circuit;
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
  collectedDefs?: Map<string, SubcircuitDefinition>,
): Promise<Circuit> {
  // Parse the XML to discover element names before attempting to load
  const parsed = parseDigXml(xml);

  // Collect unknown element names — check both global registry and
  // circuit-scoped subcircuit defs accumulated during this load session.
  const unknownNames = new Set<string>();
  for (const ve of parsed.visualElements) {
    if (registry.get(ve.elementName) === undefined &&
        !(collectedDefs?.has(ve.elementName))) {
      unknownNames.add(ve.elementName);
    }
  }

  // Resolve all unknown subcircuits into the collectedDefs accumulator.
  // If a name can't be resolved (e.g. Digital built-in like GenericInitCode),
  // skip it — loadDigCircuit will also skip unregistered elements gracefully.
  for (const name of unknownNames) {
    try {
      await resolveAndCollect(name, resolver, registry, xmlCache, loadingStack, depth, collectedDefs!);
    } catch (e) {
      if (e instanceof ResolverNotFoundError) {
        console.warn(`Skipping unresolvable element "${name}" (not a subcircuit file)`);
        continue;
      }
      throw e;
    }
  }

  // Load the circuit, passing accumulated subcircuit defs so they are
  // set on circuit.metadata before elements are created. This lets
  // resolveComponentDef() find subcircuit types without the global registry.
  return loadDigCircuit(parsed, registry, collectedDefs);
}

async function resolveAndCollect(
  name: string,
  resolver: FileResolver,
  registry: ComponentRegistry,
  xmlCache: CacheResolver,
  loadingStack: string[],
  depth: number,
  collectedDefs: Map<string, SubcircuitDefinition>,
): Promise<void> {
  // Already collected during this load session — skip
  if (collectedDefs.has(name)) return;

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
    collectedDefs,
  );

  // Collect the definition for circuit-scoped storage — no global registry mutation.
  const shapeType = subcircuit.metadata.shapeType || "DEFAULT";
  const subDef = createLiveDefinition(
    subcircuit,
    shapeType as SubcircuitDefinition["shapeMode"],
    name,
  );
  collectedDefs.set(name, subDef);
}

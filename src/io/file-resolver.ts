/**
 * File resolver interface and implementations for subcircuit loading.
 *
 * Resolvers are chained in order: embedded → cache → http → node.
 * The first resolver that can satisfy the request wins.
 *
 * FileResolver.resolve() takes a circuit name (no extension) and an optional
 * relativeTo path, and returns the .dig XML string content.
 *
 * Implementations:
 *   EmbeddedResolver — checks subcircuitDefinitions from a .digb document
 *   CacheResolver    — checks already-loaded definitions (in-memory Map)
 *   HttpResolver     — fetches ${basePath}/${name}.dig via HTTP
 *   NodeResolver     — reads from filesystem (Node.js only)
 *   ChainResolver    — tries each resolver in order, first match wins
 */

// ---------------------------------------------------------------------------
// FileResolver interface
// ---------------------------------------------------------------------------

/**
 * Resolves a subcircuit name to its .dig XML content.
 *
 * @param name       The subcircuit name (no .dig extension), e.g. "FullAdder"
 * @param relativeTo Optional path context for relative resolution
 * @returns          The .dig XML string content
 * @throws           If the name cannot be resolved
 */
export interface FileResolver {
  resolve(name: string, relativeTo?: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// ResolverNotFoundError
// ---------------------------------------------------------------------------

/**
 * Thrown when no resolver in the chain can satisfy the request.
 */
export class ResolverNotFoundError extends Error {
  readonly name_: string;

  constructor(name: string) {
    super(`Subcircuit not found: "${name}"`);
    this.name = "ResolverNotFoundError";
    this.name_ = name;
  }
}

// ---------------------------------------------------------------------------
// EmbeddedResolver
// ---------------------------------------------------------------------------

/**
 * Resolves subcircuit names from a pre-loaded embedded map.
 *
 * Used for .digb documents that bundle all subcircuit definitions inline.
 * The map key is the circuit name, the value is the .dig XML string.
 */
export class EmbeddedResolver implements FileResolver {
  private readonly _map: ReadonlyMap<string, string>;

  constructor(embedded: Map<string, string> | Record<string, string>) {
    if (embedded instanceof Map) {
      this._map = embedded;
    } else {
      this._map = new Map(Object.entries(embedded));
    }
  }

  async resolve(name: string): Promise<string> {
    const content = this._map.get(name);
    if (content === undefined) {
      throw new ResolverNotFoundError(name);
    }
    return content;
  }
}

// ---------------------------------------------------------------------------
// CacheResolver
// ---------------------------------------------------------------------------

/**
 * Resolves subcircuit names from an in-memory cache of already-resolved XML.
 *
 * The subcircuit loader populates this cache as subcircuits are loaded so
 * duplicate requests for the same subcircuit return the cached content
 * without hitting external sources.
 */
export class CacheResolver implements FileResolver {
  private readonly _cache: Map<string, string>;

  constructor(initial?: Map<string, string>) {
    this._cache = initial ? new Map(initial) : new Map();
  }

  async resolve(name: string): Promise<string> {
    const content = this._cache.get(name);
    if (content === undefined) {
      throw new ResolverNotFoundError(name);
    }
    return content;
  }

  /**
   * Store XML content for a subcircuit name in the cache.
   */
  set(name: string, content: string): void {
    this._cache.set(name, content);
  }

  /**
   * Check whether the cache has an entry for the given name.
   */
  has(name: string): boolean {
    return this._cache.has(name);
  }

  /**
   * Remove all entries from the cache.
   */
  clear(): void {
    this._cache.clear();
  }

  /**
   * Number of cached entries.
   */
  get size(): number {
    return this._cache.size;
  }
}

// ---------------------------------------------------------------------------
// HttpResolver
// ---------------------------------------------------------------------------

/**
 * Resolves subcircuit names by fetching ${basePath}/${name}.dig over HTTP.
 *
 * The basePath should end with "/" or be empty. The fetch call uses the
 * global fetch function (available in browsers and Node.js >= 18).
 */
export class HttpResolver implements FileResolver {
  private _basePath: string;
  private _fetchFn: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>;

  /**
   * @param basePath  Base URL path, e.g. "circuits/" or "https://example.com/circuits/"
   * @param fetchFn   Optional custom fetch implementation (for testing)
   */
  constructor(
    basePath: string = "./",
    fetchFn?: (url: string) => Promise<{ ok: boolean; text(): Promise<string> }>,
  ) {
    this._basePath = basePath;
    this._fetchFn = fetchFn ?? ((url: string) => globalThis.fetch(url));
  }

  /**
   * Update the base path (used when the tutorial checkpoint changes).
   */
  setBasePath(basePath: string): void {
    this._basePath = basePath;
  }

  /**
   * Return the current base path.
   */
  getBasePath(): string {
    return this._basePath;
  }

  async resolve(name: string): Promise<string> {
    const suffix = name.endsWith('.dig') ? '' : '.dig';
    const url = `${this._basePath}${name}${suffix}`;
    const response = await this._fetchFn(url);
    if (!response.ok) {
      throw new ResolverNotFoundError(name);
    }
    return response.text();
  }
}

// ---------------------------------------------------------------------------
// NodeResolver
// ---------------------------------------------------------------------------

/**
 * Resolves subcircuit names by reading files from the filesystem.
 *
 * For use in headless/Node.js environments. Reads ${basePath}/${name}.dig
 * using the Node.js `fs` module. The readFileFn dependency is injected to
 * keep this module browser-safe (no direct fs import at module load time).
 */
export class NodeResolver implements FileResolver {
  private readonly _basePath: string;
  private readonly _readFileFn: (path: string) => Promise<string>;

  /**
   * @param basePath    Directory path, e.g. "circuits/" or "./test-fixtures/"
   * @param readFileFn  Async function that reads a file path and returns its content
   */
  constructor(
    basePath: string,
    readFileFn: (path: string) => Promise<string>,
  ) {
    this._basePath = basePath;
    this._readFileFn = readFileFn;
  }

  async resolve(name: string): Promise<string> {
    const suffix = name.endsWith('.dig') ? '' : '.dig';
    const path = `${this._basePath}${name}${suffix}`;
    try {
      return await this._readFileFn(path);
    } catch {
      throw new ResolverNotFoundError(name);
    }
  }
}

// ---------------------------------------------------------------------------
// ChainResolver
// ---------------------------------------------------------------------------

/**
 * Tries each resolver in order and returns the result from the first one
 * that succeeds. Resolvers that throw ResolverNotFoundError are skipped.
 * Other errors propagate immediately.
 *
 * Resolution order: embedded → cache → http → node (by convention).
 * The actual order is determined by the order of resolvers passed to the
 * constructor.
 */
export class ChainResolver implements FileResolver {
  private readonly _resolvers: FileResolver[];

  constructor(resolvers: FileResolver[]) {
    this._resolvers = resolvers;
  }

  /** Access the inner resolvers (e.g. for cache clearing or base-path updates). */
  get resolvers(): readonly FileResolver[] {
    return this._resolvers;
  }

  async resolve(name: string, relativeTo?: string): Promise<string> {
    for (const resolver of this._resolvers) {
      try {
        return await resolver.resolve(name, relativeTo);
      } catch (e) {
        if (e instanceof ResolverNotFoundError) {
          continue;
        }
        throw e;
      }
    }
    throw new ResolverNotFoundError(name);
  }
}

// ---------------------------------------------------------------------------
// createDefaultResolver
// ---------------------------------------------------------------------------

/**
 * Create the default resolver chain for browser use.
 *
 * Order: cache → http
 *
 * The cache is returned so the caller can populate it as subcircuits are
 * loaded, and clear it when the checkpoint changes.
 *
 * @param basePath  HTTP base path for .dig file resolution (default "./")
 * @returns         The chain resolver (cache is embedded inside it)
 */
export function createDefaultResolver(basePath: string = "./"): FileResolver {
  const cache = new CacheResolver();
  const http = new HttpResolver(basePath);
  return new ChainResolver([cache, http]);
}

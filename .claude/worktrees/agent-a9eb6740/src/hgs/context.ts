/**
 * HGS evaluation context — port of Digital's hdl/hgs/Context.java.
 *
 * Hierarchical parent-child scope chain. Variable lookup walks the chain to
 * the root. The root context holds built-in functions and output buffer.
 */

import { HGSEvalError } from "./parser-error";
import { type HGSValue, HGSFunction } from "./value";

// ---------------------------------------------------------------------------
// FileResolver interface
// ---------------------------------------------------------------------------

export interface FileResolver {
  resolve(filename: string, rootPath: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// HGSContext
// ---------------------------------------------------------------------------

export class HGSContext {
  private readonly parent: HGSContext | null;
  private readonly vars: Map<string, HGSValue>;
  private readonly outputBuf: string[] | null;
  readonly rootPath: string;
  readonly fileResolver: FileResolver | null;

  constructor(options: {
    parent?: HGSContext;
    enableOutput?: boolean;
    rootPath?: string;
    fileResolver?: FileResolver;
  } = {}) {
    this.parent = options.parent ?? null;
    this.vars = new Map();
    this.outputBuf = (options.enableOutput ?? (options.parent === undefined)) ? [] : null;
    this.rootPath = options.rootPath ?? options.parent?.getRootPath() ?? "";
    this.fileResolver = options.fileResolver ?? options.parent?.fileResolver ?? null;
  }

  // ---------------------------------------------------------------------------
  // Variable management
  // ---------------------------------------------------------------------------

  declareVar(name: string, value: HGSValue): void {
    if (this.vars.has(name)) {
      throw new HGSEvalError(`variable '${name}' already declared`);
    }
    this.vars.set(name, value);
  }

  setVar(name: string, value: HGSValue): void {
    if (this.vars.has(name)) {
      this.vars.set(name, value);
    } else if (this.parent !== null) {
      this.parent.setVar(name, value);
    } else {
      throw new HGSEvalError(`variable '${name}' not declared`);
    }
  }

  getVar(name: string): HGSValue {
    const v = this.vars.get(name);
    if (v !== undefined) return v;
    if (this.parent !== null) return this.parent.getVar(name);
    throw new HGSEvalError(`variable not found: ${name}`);
  }

  hasVar(name: string): boolean {
    if (this.vars.has(name)) return true;
    if (this.parent !== null) return this.parent.hasVar(name);
    return false;
  }

  exportVar(name: string, value: HGSValue): void {
    if (this.parent === null) {
      this.declareVar(name, value);
    } else {
      this.parent.exportVar(name, value);
    }
  }

  /** Return all variable names declared directly in this scope. */
  getLocalKeys(): string[] {
    return Array.from(this.vars.keys());
  }

  // ---------------------------------------------------------------------------
  // Output buffer
  // ---------------------------------------------------------------------------

  print(str: string): void {
    if (this.outputBuf !== null) {
      this.outputBuf.push(str);
    } else if (this.parent !== null) {
      this.parent.print(str);
    }
  }

  getOutput(): string {
    if (this.outputBuf !== null) {
      return this.outputBuf.join("");
    }
    if (this.parent !== null) {
      return this.parent.getOutput();
    }
    return "";
  }

  clearOutput(): void {
    if (this.outputBuf !== null) {
      this.outputBuf.length = 0;
    } else if (this.parent !== null) {
      this.parent.clearOutput();
    }
  }

  // ---------------------------------------------------------------------------
  // Root path (for file resolution)
  // ---------------------------------------------------------------------------

  getRootPath(): string {
    if (this.parent !== null) return this.parent.getRootPath();
    return this.rootPath;
  }

  // ---------------------------------------------------------------------------
  // Child scope factory
  // ---------------------------------------------------------------------------

  /** Create a child scope that inherits variables and file resolver. */
  child(enableOutput: boolean = false): HGSContext {
    return new HGSContext({ parent: this, enableOutput });
  }
}

// ---------------------------------------------------------------------------
// Root context factory — registers all built-in functions
// ---------------------------------------------------------------------------

export function createRootContext(options: {
  fileResolver?: FileResolver;
  rootPath?: string;
} = {}): HGSContext {
  const ctx = new HGSContext({
    enableOutput: true,
    rootPath: options.rootPath ?? "",
    ...(options.fileResolver !== undefined ? { fileResolver: options.fileResolver } : {}),
  });

  // Built-ins are registered by builtins.ts after context creation.
  // This factory just creates the root context; registerBuiltins() populates it.
  return ctx;
}

// ---------------------------------------------------------------------------
// Helper: register a named built-in function into a context
// ---------------------------------------------------------------------------

export function registerBuiltin(ctx: HGSContext, name: string, fn: HGSFunction): void {
  ctx.declareVar(name, fn);
}

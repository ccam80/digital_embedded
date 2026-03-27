/**
 * Shared helpers for MCP tool registration.
 */

import { readFile, readdir } from "fs/promises";
import { NodeResolver } from "../../src/io/file-resolver.js";
import type { Circuit } from "../../src/core/circuit.js";

// ---------------------------------------------------------------------------
// wrapTool
// ---------------------------------------------------------------------------

type McpContent = { type: "text"; text: string };
type McpResponse = { content: McpContent[]; isError?: true };

/**
 * Wraps a tool handler that returns a string into the MCP response shape.
 * Catches errors and returns them as isError responses.
 */
export function wrapTool<TArgs>(
  errorPrefix: string,
  fn: (args: TArgs) => string | Promise<string>,
): (args: TArgs) => McpResponse | Promise<McpResponse> {
  return async (args: TArgs) => {
    try {
      const text = await fn(args);
      return { content: [{ type: "text" as const, text }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text" as const,
            text: `${errorPrefix}: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true as const,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// makeNodeResolver
// ---------------------------------------------------------------------------

export function makeNodeResolver(baseDir: string): NodeResolver {
  return new NodeResolver(
    baseDir + "/",
    (path: string) => readFile(path, "utf-8"),
    (path: string) => readdir(path),
  );
}

// ---------------------------------------------------------------------------
// SessionState
// ---------------------------------------------------------------------------

export class SessionState {
  readonly circuits = new Map<string, Circuit>();
  readonly circuitSourceDirs = new Map<string, string>();
  private handleCounter = 0;

  nextHandle(): string {
    return `c${this.handleCounter++}`;
  }

  getCircuit(handle: string): Circuit {
    const circuit = this.circuits.get(handle);
    if (!circuit) {
      throw new Error(
        `No circuit found for handle "${handle}". Use circuit_load or circuit_build first.`,
      );
    }
    return circuit;
  }

  store(circuit: Circuit, sourceDir?: string): string {
    const handle = this.nextHandle();
    this.circuits.set(handle, circuit);
    if (sourceDir) this.circuitSourceDirs.set(handle, sourceDir);
    return handle;
  }
}

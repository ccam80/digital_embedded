/**
 * ngspice-dll-path.ts — single source of truth for locating the instrumented
 * ngspice shared library used by the comparison harness and parity tests.
 *
 * Precedence (highest to lowest):
 *   1. an explicit `override` argument (e.g. the MCP `dllPath` tool argument);
 *   2. the `NGSPICE_DLL_PATH` environment variable;
 *   3. the in-tree default `DEFAULT_NGSPICE_DLL_PATH`, resolved against the
 *      current working directory so a fresh checkout with no env var still
 *      finds the freshly built DLL deterministically.
 *
 * The only DLL the harness ever loads is the instrumented build emitted by
 * `ref/ngspice/visualc/sharedspice.sln` (Release|x64) at
 * `ref/ngspice/visualc/sharedspice/Release.x64/ngspice.dll`. That build exports
 * `ni_ac_register` (ref/ngspice/src/maths/ni/niiter.c:334), the AC-capture
 * callback registration entry point the AC harness depends on. A stale legacy
 * `visualc-shared/spice.dll` lacks this symbol; `assertNgspiceDllHasAc` exists
 * to turn that mismatch into a loud, actionable failure rather than an opaque
 * koffi throw deep inside bridge setup.
 *
 * WHY THIS MODULE MUST STAY VITEST-FREE: the MCP server imports
 * `comparison-session.ts`, which imports this module. Importing `vitest` at
 * module load time crashes the server (vitest's globals are only valid inside
 * a test runner). Every `describe`/`describe.skip` gate therefore lives in the
 * test files that already import vitest (e.g. ngspice-parity/parity-helpers.ts),
 * never here. This file imports only `node:fs` and `node:path`.
 */

import { accessSync } from "node:fs";
import { resolve } from "node:path";

/**
 * In-tree default location of the instrumented ngspice DLL, resolved against
 * the current working directory. This is the ONLY DLL path literal in source.
 */
export const DEFAULT_NGSPICE_DLL_PATH = resolve(
  process.cwd(),
  "ref/ngspice/visualc/sharedspice/Release.x64/ngspice.dll",
);

/**
 * Resolve the ngspice DLL path under the documented precedence:
 * explicit override → NGSPICE_DLL_PATH env var → in-tree default.
 */
export function resolveNgspiceDllPath(override?: string): string {
  return override ?? process.env.NGSPICE_DLL_PATH ?? DEFAULT_NGSPICE_DLL_PATH;
}

/**
 * True when the resolved DLL file exists on disk. Drives the `describe.skip`
 * gates so DLL-absent machines skip the harness suites instead of going red.
 */
export function ngspiceDllFileExists(override?: string): boolean {
  try {
    accessSync(resolveNgspiceDllPath(override));
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-path memoised result of the AC-symbol verification. `undefined` means
 * "not yet checked"; a thrown verification re-runs only after the cache is
 * cleared (it is not — failures are deterministic for a given DLL).
 */
const _acSymbolVerified = new Map<string, boolean>();

/**
 * Verify the resolved DLL exports `ni_ac_register` (the AC-capture callback
 * registration entry point, niiter.c:334). Loads the DLL via koffi and probes
 * the symbol; a stale DLL that lacks it throws an actionable Error naming the
 * path, the missing symbol, and the remedy.
 *
 * Async because koffi loads via `await import(...)` under this package's pure
 * ESM module system; callers in already-async code paths must await it.
 */
export async function assertNgspiceDllHasAc(override?: string): Promise<void> {
  const dllPath = resolveNgspiceDllPath(override);
  if (_acSymbolVerified.get(dllPath)) return;

  const koffiModule = await import("koffi");
  const koffi = (koffiModule as { default?: unknown }).default ?? koffiModule;

  let lib: { func: (sig: string) => unknown };
  try {
    lib = (koffi as { load: (p: string) => typeof lib }).load(dllPath);
  } catch (err) {
    throw new Error(
      `Failed to load ngspice DLL at "${dllPath}": ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Build it via ref/ngspice/visualc/sharedspice.sln (Release|x64), or ` +
        `repoint NGSPICE_DLL_PATH at ref/ngspice/visualc/sharedspice/Release.x64/ngspice.dll. ` +
        `Do NOT use the legacy visualc-shared/spice.dll.`,
    );
  }

  try {
    lib.func("void ni_ac_register(void*)");
  } catch (err) {
    throw new Error(
      `ngspice DLL at "${dllPath}" is missing the 'ni_ac_register' symbol ` +
        `(${err instanceof Error ? err.message : String(err)}). This is a stale ` +
        `build without the AC-capture instrumentation. Rebuild ` +
        `ref/ngspice/visualc/sharedspice.sln (Release|x64), or repoint ` +
        `NGSPICE_DLL_PATH at ref/ngspice/visualc/sharedspice/Release.x64/ngspice.dll. ` +
        `Do NOT use the legacy visualc-shared/spice.dll.`,
    );
  }

  _acSymbolVerified.set(dllPath, true);
}

/**
 * In-tree default directory holding the XSPICE code-model libraries (`*.cm`),
 * built by `ref/ngspice/visualc/xspice/analog.vcxproj` (Release|x64) at
 * `codemodels/x64/Release/`. The standalone `ngspice.dll` is built WITHOUT code
 * models compiled in (visualc/how-to-ngspice-vstudio.txt:61-64); ngspice's
 * design loads them at runtime from `.cm` DLLs via the `codemodel` command.
 */
export const DEFAULT_NGSPICE_CODEMODEL_DIR = resolve(
  process.cwd(),
  "ref/ngspice/visualc/xspice/codemodels/x64/Release",
);

/**
 * Resolve the absolute paths of the XSPICE code-model libraries to load into
 * the instrumented ngspice via the `codemodel` command. Only files that exist
 * are returned (forward-slash form, ngspice-friendly), so a checkout that has
 * not built the code models simply loads none- non-code-model circuits are
 * unaffected. Precedence for the directory: explicit override →
 * NGSPICE_CODEMODEL_DIR env var → in-tree default.
 *
 * `analog64.cm` carries the analog code models (incl. `hyst`); extend the list
 * as further `.cm` libraries (digital, xtradev, …) are built and needed.
 */
export function resolveNgspiceCodemodelPaths(overrideDir?: string): string[] {
  const dir = overrideDir ?? process.env.NGSPICE_CODEMODEL_DIR ?? DEFAULT_NGSPICE_CODEMODEL_DIR;
  const found: string[] = [];
  for (const name of ["analog64.cm"]) {
    const p = resolve(dir, name);
    try {
      accessSync(p);
      found.push(p.replace(/\\/g, "/"));
    } catch {
      /* not built on this checkout- skip */
    }
  }
  return found;
}

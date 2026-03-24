/**
 * circuit-cli.ts — CLI wrapper for the headless circuit API.
 *
 * Usage:
 *   npx tsx scripts/circuit-cli.ts <command> [args...]
 *
 * Commands:
 *   list                        List all registered component types by category
 *   netlist  <path>              Full netlist: components, nets, diagnostics
 *   validate <path>              Just diagnostics
 *   describe <ComponentType>     Registry lookup for pin layout + properties
 *   patch    <path> <ops-json> [--scope <scope>] [--save]  Apply patches
 *   build    <spec-json> --out <path>  Build from declarative spec
 *   compile  <path>              Compile and report success/errors
 *   test     <path>              Run embedded test vectors
 */

import { readFileSync, writeFileSync, readFile, readdir } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createDefaultRegistry } from '@/components/register-all.js';
import { scan74xxPinMap } from '@/io/dig-pin-scanner.js';
import { DefaultSimulatorFacade } from '@/headless/default-facade.js';
import { FacadeError } from '@/headless/types.js';
import { extractEmbeddedTestData } from '@/headless/test-runner.js';
import { parseTestData } from '@/testing/parser.js';
import { executeTests } from '@/testing/executor.js';
import { loadDig } from '@/io/dig-loader.js';
import { loadWithSubcircuits } from '@/io/subcircuit-loader.js';
import { NodeResolver } from '@/io/file-resolver.js';
import { deserializeCircuit } from '@/io/load.js';
import { serializeCircuit } from '@/io/save.js';
import type {
  Netlist,
  ComponentDescriptor,
  NetDescriptor,
  Diagnostic,
  CircuitSpec,
  CircuitPatch,
} from '@/headless/netlist-types.js';
import type { ComponentDefinition } from '@/core/registry.js';

// ---------------------------------------------------------------------------
// Initialise registry + builder
// ---------------------------------------------------------------------------

const LIB_74XX_DIR = join(process.cwd(), "ref", "Digital", "src", "main", "dig", "lib", "DIL Chips", "74xx");
const pinMap74xx = scan74xxPinMap(LIB_74XX_DIR);
const registry = createDefaultRegistry(pinMap74xx);
const facade = new DefaultSimulatorFacade(registry);

// ---------------------------------------------------------------------------
// Helper: load a .dig file from disk and return a Circuit
// ---------------------------------------------------------------------------

async function loadCircuit(filePath: string) {
  const absPath = resolve(process.cwd(), filePath);
  const content = readFileSync(absPath, 'utf-8');
  const trimmed = content.trimStart();
  if (trimmed.startsWith('{')) {
    // JSON format (from build --out or serialize)
    return deserializeCircuit(content, registry);
  }
  // .dig XML format — use subcircuit-aware loader with a NodeResolver
  // rooted at the directory containing the file, so sibling .dig files
  // (subcircuits) are found automatically.
  const baseDir = dirname(absPath);
  const readFileFn = (path: string) => new Promise<string>((res, rej) => {
    readFile(path, 'utf-8', (err, data) => err ? rej(err) : res(data));
  });
  const readdirFn = (path: string) => new Promise<string[]>((res, rej) => {
    readdir(path, (err, entries) => err ? rej(err) : res(entries));
  });
  const nodeResolver = new NodeResolver(baseDir + '/', readFileFn, readdirFn);
  return loadWithSubcircuits(content, nodeResolver, registry);
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatPinDescriptors(pins: ComponentDescriptor['pins']): string {
  return pins
    .map((p) => `${p.label}[${p.bitWidth}-bit, ${p.direction}]`)
    .join(', ');
}

function formatNetlist(netlist: Netlist): string {
  const lines: string[] = [];

  // Components
  lines.push(`Components (${netlist.components.length}):`);
  for (const comp of netlist.components) {
    const label = comp.label ? `"${comp.label}"` : `(unlabeled)`;
    const pins = formatPinDescriptors(comp.pins);
    lines.push(`  [${comp.index}] ${comp.typeId} ${label} — pins: ${pins}`);
  }

  lines.push('');

  // Nets
  lines.push(`Nets (${netlist.nets.length}):`);
  for (const net of netlist.nets) {
    const widthStr =
      net.inferredWidth !== null ? `${net.inferredWidth}-bit` : 'width-conflict';
    lines.push(`  Net #${net.netId} [${widthStr}, ${net.pins.length} pins]:`);
    for (const pin of net.pins) {
      const addr = `${pin.componentLabel}:${pin.pinLabel}`;
      lines.push(
        `    ${addr} [${pin.declaredWidth}-bit, ${pin.pinDirection}]`
      );
    }
  }

  lines.push('');
  lines.push(formatDiagnostics(netlist.diagnostics));

  return lines.join('\n');
}

function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return 'Diagnostics: none';

  const lines: string[] = [`Diagnostics (${diagnostics.length}):`];
  for (const d of diagnostics) {
    const severity = d.severity.toUpperCase();
    let line = `  ${severity} ${d.code}: ${d.message}`;
    if (d.fix) {
      line += `\n    Fix: ${d.fix}`;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

function formatComponentDefinition(def: ComponentDefinition): string {
  const lines: string[] = [];
  lines.push(`${def.name} (category: ${def.category})`);

  if (def.pinLayout.length > 0) {
    const pinStr = def.pinLayout
      .map((p) => `${p.label}[${p.bitWidth ?? 1}-bit, ${p.direction}]`)
      .join(', ');
    lines.push(`  Pins: ${pinStr}`);
  } else {
    lines.push('  Pins: (none)');
  }

  if (def.propertyDefs.length > 0) {
    lines.push('  Properties:');
    for (const pd of def.propertyDefs) {
      const parts: string[] = [pd.type];
      if (pd.defaultValue !== undefined) parts.push(`default: ${String(pd.defaultValue)}`);
      if (pd.min !== undefined) parts.push(`min: ${pd.min}`);
      if (pd.max !== undefined) parts.push(`max: ${pd.max}`);
      lines.push(`    ${pd.key} (${parts.join(', ')})`);
      if (pd.description) {
        lines.push(`      ${pd.description}`);
      }
    }
  } else {
    lines.push('  Properties: (none)');
  }

  if (def.helpText) {
    lines.push(`  Help: ${def.helpText}`);
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function cmdNetlist(filePath: string): Promise<void> {
  const circuit = await loadCircuit(filePath);
  const netlist = facade.netlist(circuit);
  console.log(formatNetlist(netlist));
}

async function cmdValidate(filePath: string): Promise<void> {
  const circuit = await loadCircuit(filePath);
  const diagnostics = facade.validate(circuit);
  console.log(formatDiagnostics(diagnostics));
}

function cmdList(): void {
  const allDefs = registry.getAll();
  // Group by category
  const byCategory = new Map<string, string[]>();
  for (const def of allDefs) {
    const cat = def.category ?? 'UNCATEGORIZED';
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(def.name);
  }
  for (const [cat, names] of [...byCategory.entries()].sort()) {
    console.log(`${cat}:`);
    console.log(`  ${names.sort().join(', ')}`);
  }
  console.log(`\nTotal: ${allDefs.length} component types`);
}

function cmdDescribe(typeName: string): void {
  const def = facade.describeComponent(typeName);
  if (!def) {
    console.error(`Unknown component type: "${typeName}"`);
    console.error('Use `describe` with a registered type name (e.g. And, Or, FlipflopD).');
    process.exit(1);
  }
  console.log(formatComponentDefinition(def));
}

async function cmdPatch(
  filePath: string,
  opsJson: string,
  opts: { scope?: string; save?: boolean }
): Promise<void> {
  const circuit = await loadCircuit(filePath);
  let ops: CircuitPatch;
  try {
    ops = JSON.parse(opsJson) as CircuitPatch;
  } catch {
    console.error('Invalid JSON for patch operations.');
    process.exit(1);
  }

  const patchOpts = opts.scope ? { scope: opts.scope } : undefined;
  const { diagnostics } = facade.patch(circuit, ops, patchOpts);

  if (opts.save) {
    // Serialize back: we don't have a .dig serializer, so warn the user.
    // Instead, save circuit JSON via headless serialize if available.
    // For now, save as JSON sidecar.
    const outPath = filePath.replace(/\.dig$/, '.patched.json');
    // Build a minimal JSON representation (component positions/types/wires)
    const circuitJson = JSON.stringify(
      {
        elements: circuit.elements.map((e) => ({
          typeId: e.typeId,
          position: e.position,
          rotation: e.rotation,
          properties: Object.fromEntries(
            Object.entries(e.getProperties().toObject?.() ?? {})
          ),
        })),
        wires: circuit.wires.map((w) => ({
          start: w.start,
          end: w.end,
        })),
      },
      null,
      2
    );
    writeFileSync(resolve(process.cwd(), outPath), circuitJson, 'utf-8');
    console.log(`Patched circuit saved to: ${outPath}`);
  }

  console.log(formatDiagnostics(diagnostics));
}

function cmdBuild(specJson: string, outPath: string): void {
  let spec: CircuitSpec;
  try {
    spec = JSON.parse(specJson) as CircuitSpec;
  } catch {
    console.error('Invalid JSON for circuit spec.');
    process.exit(1);
  }

  const circuit = facade.build(spec);
  const diagnostics = facade.validate(circuit);

  if (diagnostics.some((d) => d.severity === 'error')) {
    console.log('Build produced errors:');
    console.log(formatDiagnostics(diagnostics));
    process.exit(1);
  }

  const circuitJson = serializeCircuit(circuit);

  const absOut = resolve(process.cwd(), outPath);
  writeFileSync(absOut, circuitJson, 'utf-8');

  console.log(`Circuit built successfully.`);
  console.log(`  Components: ${circuit.elements.length}`);
  console.log(`  Wires: ${circuit.wires.length}`);
  console.log(`  Output: ${absOut}`);

  if (diagnostics.length > 0) {
    console.log('');
    console.log(formatDiagnostics(diagnostics));
  } else {
    console.log('Diagnostics: none');
  }
}

async function cmdCompile(filePath: string): Promise<void> {
  const circuit = await loadCircuit(filePath);

  // Pre-check via netlist
  const diagnostics = facade.validate(circuit);
  const errors = diagnostics.filter((d) => d.severity === 'error');
  if (errors.length > 0) {
    console.log('Compilation blocked by pre-compile errors:');
    console.log(formatDiagnostics(errors));
    process.exit(1);
  }

  try {
    facade.compile(circuit);
    console.log('Compilation successful.');
    if (diagnostics.length > 0) {
      console.log('');
      console.log(formatDiagnostics(diagnostics));
    } else {
      console.log('Diagnostics: none');
    }
  } catch (err) {
    if (err instanceof FacadeError) {
      console.error(`Compilation error: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`Compilation error: ${err.message}`);
    } else {
      console.error('Compilation failed with an unknown error.');
    }
    process.exit(1);
  }
}

async function cmdTest(filePath: string): Promise<void> {
  const circuit = await loadCircuit(filePath);

  let engine;
  try {
    engine = facade.compile(circuit);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Compile error: ${msg}`);
    process.exit(1);
  }

  let results;
  try {
    const testData = extractEmbeddedTestData(circuit);
    if (!testData || testData.trim().length === 0) {
      console.error('Test error: No test data available: circuit contains no Testcase components.');
      process.exit(1);
    }
    const parsed = parseTestData(testData);
    results = executeTests(facade, engine, circuit, parsed);
  } catch (err) {
    if (err instanceof FacadeError) {
      console.error(`Test error: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`Test error: ${err.message}`);
    } else {
      console.error('Test run failed with an unknown error.');
    }
    process.exit(1);
  }

  const total = results.passed + results.failed;
  console.log(`Tests: ${results.passed}/${total} passed`);

  if (results.failed > 0) {
    console.log('');
    console.log('Failures:');
    for (const vec of results.vectors) {
      if (!vec.passed) {
        console.log(`  Vector ${vec.index}: FAIL`);
        if (vec.message) {
          console.log(`    ${vec.message}`);
        }
      }
    }
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Usage / help
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`circuit-cli — headless circuit API for the digital logic simulator

Usage:
  npx tsx scripts/circuit-cli.ts <command> [args...]

Commands:
  netlist  <path.dig>
      Print full netlist: components, nets, and diagnostics.

  validate <path.dig>
      Print diagnostics only (errors and warnings).

  describe <ComponentType>
      Show pin layout and properties for a component type (e.g. And, FlipflopD).

  patch    <path.dig> '<ops-json>' [--scope <scope>] [--save]
      Apply patch operations (JSON array) to the circuit and print diagnostics.
      --scope  Limit target resolution to a subcircuit (e.g. MCU/sysreg).
      --save   Write patched circuit to <path>.patched.json.

  build    '<spec-json>' --out <path>
      Build a circuit from a declarative JSON spec and write to <path>.

  compile  <path.dig>
      Compile the circuit and report success or structured errors.

  test     <path.dig>
      Compile and run embedded test vectors, reporting pass/fail.

Examples:
  npx tsx scripts/circuit-cli.ts validate circuits/and-gate.dig
  npx tsx scripts/circuit-cli.ts netlist circuits/half-adder.dig
  npx tsx scripts/circuit-cli.ts describe And
  npx tsx scripts/circuit-cli.ts patch circuits/sr-latch.dig '[{"op":"set","target":"Q","props":{"Bits":4}}]'
  npx tsx scripts/circuit-cli.ts compile circuits/and-gate.dig
  npx tsx scripts/circuit-cli.ts test circuits/and-gate.dig
`);
}

// ---------------------------------------------------------------------------
// Argument parsing and dispatch
// ---------------------------------------------------------------------------

async function parseArgs(argv: string[]): Promise<void> {
  // argv starts at index 2 (node, script, command, ...)
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printUsage();
    return;
  }

  const command = args[0];

  try {
    switch (command) {
      case 'list': {
        cmdList();
        break;
      }

      case 'netlist': {
        if (args.length < 2) {
          console.error('Usage: netlist <path.dig>');
          process.exit(1);
        }
        await cmdNetlist(args[1]);
        break;
      }

      case 'validate': {
        if (args.length < 2) {
          console.error('Usage: validate <path.dig>');
          process.exit(1);
        }
        await cmdValidate(args[1]);
        break;
      }

      case 'describe': {
        if (args.length < 2) {
          console.error('Usage: describe <ComponentType>');
          process.exit(1);
        }
        cmdDescribe(args[1]);
        break;
      }

      case 'patch': {
        if (args.length < 3) {
          console.error('Usage: patch <path.dig> <ops-json> [--scope <scope>] [--save]');
          process.exit(1);
        }
        const filePath = args[1];
        const opsJson = args[2];
        const patchOpts: { scope?: string; save?: boolean } = {};
        for (let i = 3; i < args.length; i++) {
          if (args[i] === '--scope' && i + 1 < args.length) {
            patchOpts.scope = args[++i];
          } else if (args[i] === '--save') {
            patchOpts.save = true;
          }
        }
        await cmdPatch(filePath, opsJson, patchOpts);
        break;
      }

      case 'build': {
        if (args.length < 2) {
          console.error('Usage: build <spec-json> --out <path>');
          process.exit(1);
        }
        const specJson = args[1];
        const outIdx = args.indexOf('--out');
        if (outIdx === -1 || outIdx + 1 >= args.length) {
          console.error('build requires --out <path>');
          process.exit(1);
        }
        cmdBuild(specJson, args[outIdx + 1]);
        break;
      }

      case 'compile': {
        if (args.length < 2) {
          console.error('Usage: compile <path.dig>');
          process.exit(1);
        }
        await cmdCompile(args[1]);
        break;
      }

      case 'test': {
        if (args.length < 2) {
          console.error('Usage: test <path.dig>');
          process.exit(1);
        }
        await cmdTest(args[1]);
        break;
      }

      default: {
        console.error(`Unknown command: "${command}"`);
        console.error('Run with --help to see available commands.');
        process.exit(1);
      }
    }
  } catch (err) {
    if (err instanceof FacadeError) {
      console.error(`Error: ${err.message}`);
    } else if (err instanceof Error) {
      // Avoid stack traces — print message only
      console.error(`Error: ${err.message}`);
    } else {
      console.error('Unexpected error:', err);
    }
    process.exit(1);
  }
}

parseArgs(process.argv);

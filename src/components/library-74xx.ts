/**
 * 74xx IC Library
 *
 * Manifest of all bundled 74xx-series integrated circuits.
 * Each entry describes one .dig subcircuit file in lib/74xx/.
 *
 * Registration: call register74xxLibrary() to add all ICs to the component
 * palette under the "74xx" category.
 */

import type { ComponentRegistry } from '../core/registry.js';
import { ComponentCategory } from '../core/registry.js';
import type { ComponentDefinition } from '../core/registry.js';
import { executeSubcircuit } from './subcircuit/subcircuit.js';
import { PropertyType } from '../core/properties.js';
import type { PropertyBag } from '../core/properties.js';
import type { PinDeclaration } from '../core/pin.js';
import { SubcircuitElement } from './subcircuit/subcircuit.js';
import type { SubcircuitDefinition } from './subcircuit/subcircuit.js';

// ---------------------------------------------------------------------------
// Manifest entry type
// ---------------------------------------------------------------------------

export interface Library74xxEntry {
  /** IC number without prefix, e.g. "7400". */
  name: string;
  /** Human-readable description of the IC. */
  description: string;
  /** Filename within lib/74xx/, e.g. "7400.dig". */
  file: string;
  /** Functional category for palette sub-grouping. */
  category: string;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

export const LIBRARY_74XX: Library74xxEntry[] = [
  // basic
  { name: "7400", description: "quad 2-input NAND gate", file: "7400.dig", category: "basic" },
  { name: "7401", description: "quad 2-input NAND gate with open-collector outputs", file: "7401.dig", category: "basic" },
  { name: "7402", description: "quad 2-input NOR gate", file: "7402.dig", category: "basic" },
  { name: "7403", description: "quad 2-input NAND gate with open-collector outputs, different pinout than 7401", file: "7403.dig", category: "basic" },
  { name: "7404", description: "hex inverter", file: "7404.dig", category: "basic" },
  { name: "7405", description: "hex inverter, open-collector output", file: "7405.dig", category: "basic" },
  { name: "7408", description: "quad 2-input AND gate", file: "7408.dig", category: "basic" },
  { name: "7409", description: "quad 2-input AND gate with open-collector outputs", file: "7409.dig", category: "basic" },
  { name: "7410", description: "triple 3-input NAND gate", file: "7410.dig", category: "basic" },
  { name: "7411", description: "triple 3-input AND gate", file: "7411.dig", category: "basic" },
  { name: "7412", description: "triple 3-input NAND gate with open-collector outputs", file: "7412.dig", category: "basic" },
  { name: "7413", description: "dual 4-input NAND gate, Schmitt trigger", file: "7413.dig", category: "basic" },
  { name: "7414", description: "hex inverter, Schmitt trigger", file: "7414.dig", category: "basic" },
  { name: "7415", description: "triple 3-input AND gate with open-collector outputs", file: "7415.dig", category: "basic" },
  { name: "7420", description: "dual 4-input NAND gate", file: "7420.dig", category: "basic" },
  { name: "7421", description: "dual 4-input AND gate", file: "7421.dig", category: "basic" },
  { name: "7425", description: "dual 4-input NOR gate with strobe", file: "7425.dig", category: "basic" },
  { name: "7427", description: "triple 3-input NOR gate", file: "7427.dig", category: "basic" },
  { name: "7428", description: "quad 2-input NOR buffer", file: "7428.dig", category: "basic" },
  { name: "7430", description: "8-input NAND gate", file: "7430.dig", category: "basic" },
  { name: "7432", description: "quad 2-input OR gate", file: "7432.dig", category: "basic" },
  { name: "7434", description: "hex buffer", file: "7434.dig", category: "basic" },
  { name: "7440", description: "dual 4-input NAND buffer", file: "7440.dig", category: "basic" },
  { name: "7451", description: "2-input/3-input AND-NOR gate", file: "7451.dig", category: "basic" },
  { name: "7454", description: "2-3-2-3-line AND NOR gate", file: "7454.dig", category: "basic" },
  { name: "7455", description: "2 wide 4-input AND-NOR gate", file: "7455.dig", category: "basic" },
  { name: "7458", description: "dual AND OR gate", file: "7458.dig", category: "basic" },
  { name: "7486", description: "quad 2-input XOR gate", file: "7486.dig", category: "basic" },
  { name: "74133", description: "13-input NAND gate", file: "74133.dig", category: "basic" },
  { name: "74260", description: "dual 5-input NOR gate", file: "74260.dig", category: "basic" },
  { name: "74266", description: "quad 2-input XNOR gate with open collector outputs", file: "74266.dig", category: "basic" },
  { name: "744002", description: "dual 4-input NOR gate", file: "744002.dig", category: "basic" },
  { name: "744075", description: "triple 3-input OR gate", file: "744075.dig", category: "basic" },
  { name: "747266", description: "quad 2-input XNOR gate", file: "747266.dig", category: "basic" },
  { name: "74804", description: "hex 2-input NAND gate", file: "74804.dig", category: "basic" },
  { name: "74805", description: "hex 2-input NOR gate", file: "74805.dig", category: "basic" },
  { name: "74808", description: "hex 2-input AND gate", file: "74808.dig", category: "basic" },
  { name: "74832", description: "hex 2-input OR gate", file: "74832.dig", category: "basic" },
  // arithmetic
  { name: "7480", description: "Gated Full Adder with Complementary Inputs", file: "7480.dig", category: "arithmetic" },
  { name: "7482", description: "2-bit binary full adder", file: "7482.dig", category: "arithmetic" },
  { name: "7483", description: "4-bit binary full adder", file: "7483.dig", category: "arithmetic" },
  { name: "7483Real", description: "4-bit binary full adder, real gates", file: "7483Real.dig", category: "arithmetic" },
  { name: "7485", description: "4-bit comparator", file: "7485.dig", category: "arithmetic" },
  { name: "74147", description: "10-line to 4-line priority encoder", file: "74147.dig", category: "arithmetic" },
  { name: "74148", description: "8-line to 3-Line priority encoder", file: "74148.dig", category: "arithmetic" },
  { name: "74181", description: "4-bit arithmetic logic unit", file: "74181.dig", category: "arithmetic" },
  { name: "74182", description: "look-ahead carry generator", file: "74182.dig", category: "arithmetic" },
  { name: "74198", description: "8-bit shift register", file: "74198.dig", category: "arithmetic" },
  { name: "74280", description: "9 bit Odd-Even Parity Generator-Checker", file: "74280.dig", category: "arithmetic" },
  { name: "74283", description: "4-bit binary full adder, alternative pinning", file: "74283.dig", category: "arithmetic" },
  { name: "74381", description: "4-Bit Arithmetic Logic Unit with high-speed expansion", file: "74381.dig", category: "arithmetic" },
  { name: "74382", description: "4-Bit Arithmetic Logic Unit with ripple carry output", file: "74382.dig", category: "arithmetic" },
  { name: "74682", description: "8-bit digital comparator", file: "74682.dig", category: "arithmetic" },
  { name: "74688", description: "8-bit identity comparator", file: "74688.dig", category: "arithmetic" },
  // counter
  { name: "7490", description: "asynchronous two-five-decimal addition counter", file: "7490.dig", category: "counter" },
  { name: "7493", description: "4-bit Binary Counter", file: "7493.dig", category: "counter" },
  { name: "74160", description: "decimal synchronous counter, async clear", file: "74160.dig", category: "counter" },
  { name: "74161", description: "hex synchronous counter, async clear", file: "74161.dig", category: "counter" },
  { name: "74162", description: "decimal synchronous counter", file: "74162.dig", category: "counter" },
  { name: "74162Real", description: "decimal synchronous counter, real gates", file: "74162Real.dig", category: "counter" },
  { name: "74163", description: "hex synchronous counter", file: "74163.dig", category: "counter" },
  { name: "74190", description: "Presettable synchronous 4-bit BCD up/down counter", file: "74190.dig", category: "counter" },
  { name: "74191", description: "Presettable synchronous 4-bit binary up/down counter", file: "74191.dig", category: "counter" },
  { name: "74193", description: "Synchronous 4-Bit Up/Down Binary Counter with Dual Clock", file: "74193.dig", category: "counter" },
  { name: "744017", description: "Johnson decade counter with 10 decoded outputs", file: "744017.dig", category: "counter" },
  { name: "74590", description: "8-bit binary counter with tri-state output registers", file: "74590.dig", category: "counter" },
  { name: "74779", description: "8-Bit Bidirectional Binary Counter with 3-STATE Outputs", file: "74779.dig", category: "counter" },
  { name: "74779-inc", description: "flip flop part of 74779", file: "74779-inc.dig", category: "counter" },
  // display
  { name: "7447", description: "BCD to 7-segment decoder, active low", file: "7447.dig", category: "display" },
  { name: "7448", description: "BCD to 7-segment decoder, active high", file: "7448.dig", category: "display" },
  { name: "74247", description: "BCD to 7-segment decoder, active low, tails on 6 and 9", file: "74247.dig", category: "display" },
  { name: "74248", description: "BCD to 7-segment decoder, active high, tails on 6 and 9", file: "74248.dig", category: "display" },
  // driver
  { name: "7406", description: "hex inverter buffer, open-collector output", file: "7406.dig", category: "driver" },
  { name: "7407", description: "hex buffer, open-collector output", file: "7407.dig", category: "driver" },
  { name: "7416", description: "hex inverter buffer, open-collector output, same as 7406", file: "7416.dig", category: "driver" },
  { name: "7417", description: "hex buffer, open-collector output, same as 7407", file: "7417.dig", category: "driver" },
  { name: "74125", description: "Quadruple bus buffer gates with 3-state outputs (active low output enable)", file: "74125.dig", category: "driver" },
  { name: "74126", description: "Quadruple bus buffer gates with 3-state outputs (active high output enable)", file: "74126.dig", category: "driver" },
  { name: "74244", description: "octal 3-state buffer/line driver/line receiver", file: "74244.dig", category: "driver" },
  { name: "74245", description: "octal bus transceivers with 3-state outputs", file: "74245.dig", category: "driver" },
  { name: "74540", description: "octal buffer/line driver, inverted", file: "74540.dig", category: "driver" },
  { name: "74541", description: "octal buffer/line driver", file: "74541.dig", category: "driver" },
  // flipflops
  { name: "7474", description: "dual D-flip-flop", file: "7474.dig", category: "flipflops" },
  { name: "7476", description: "dual J-K flip-flops with preset and clear", file: "7476.dig", category: "flipflops" },
  { name: "74107", description: "dual J-K flip-flops with clear", file: "74107.dig", category: "flipflops" },
  { name: "74109", description: "Dual J-NOT-K flip-flop with set and reset; positive-edge-trigger", file: "74109.dig", category: "flipflops" },
  { name: "74112", description: "Dual J-K negative-edge-triggered flip-flop, clear and preset", file: "74112.dig", category: "flipflops" },
  { name: "74116", description: "dual 4-bit D-type latches", file: "74116.dig", category: "flipflops" },
  { name: "74173", description: "quad 3-state D flip-flop with common clock and reset", file: "74173.dig", category: "flipflops" },
  { name: "74174", description: "hex D-flip-flop", file: "74174.dig", category: "flipflops" },
  { name: "74175", description: "quad D-flip-flop", file: "74175.dig", category: "flipflops" },
  { name: "74273", description: "octal D-type flip-flop with clear", file: "74273.dig", category: "flipflops" },
  { name: "74373", description: "octal transparent latches", file: "74373.dig", category: "flipflops" },
  { name: "74373-D-inc", description: "transparent d latch", file: "74373-D-inc.dig", category: "flipflops" },
  { name: "74374", description: "octal positive-edge-triggered flip-flops", file: "74374.dig", category: "flipflops" },
  { name: "74377", description: "Octal D Flip-Flop with enable", file: "74377.dig", category: "flipflops" },
  { name: "74573", description: "octal transparent latches, different pinout compared to 74373", file: "74573.dig", category: "flipflops" },
  { name: "74574", description: "octal positive-edge-triggered flip-flops, different pinout compared to 74374", file: "74574.dig", category: "flipflops" },
  // memory
  { name: "7489", description: "64-bit RAM", file: "7489.dig", category: "memory" },
  { name: "74189", description: "64-Bit Random Access Memory with 3-STATE Outputs", file: "74189.dig", category: "memory" },
  { name: "7440105", description: "4-Bit x 16-Word FIFO Register", file: "7440105.dig", category: "memory" },
  { name: "74670", description: "3-state 4-by-4 Register File", file: "74670.dig", category: "memory" },
  { name: "74670-D-inc", description: "unclocked 4 bit D-latch", file: "74670-D-inc.dig", category: "memory" },
  // plexers
  { name: "7442", description: "4-line BCD to 10-line decimal decoder", file: "7442.dig", category: "plexers" },
  { name: "74138", description: "3-line to 8-line decoder/demultiplexer, inverted out", file: "74138.dig", category: "plexers" },
  { name: "74139", description: "dual 2-line to 4-line decoder/demultiplexer", file: "74139.dig", category: "plexers" },
  { name: "74150", description: "4-line to 16-line data selectors/multiplexers", file: "74150.dig", category: "plexers" },
  { name: "74151", description: "3-line to 8-line data selectors/multiplexers", file: "74151.dig", category: "plexers" },
  { name: "74153", description: "dual 4-line to 1-line data selectors/multiplexers", file: "74153.dig", category: "plexers" },
  { name: "74154", description: "4-line to 16-line decoders/demultiplexers", file: "74154.dig", category: "plexers" },
  { name: "74157", description: "quad 2-line to 1-line data selectors/multiplexers", file: "74157.dig", category: "plexers" },
  { name: "74238", description: "3-line to 8-line decoder/demultiplexer", file: "74238.dig", category: "plexers" },
  { name: "74253", description: "dual tri state 4-line to 1-line data selectors/multiplexers", file: "74253.dig", category: "plexers" },
  { name: "74257", description: "quad 2-line to 1-line data selectors/multiplexers (3-state output)", file: "74257.dig", category: "plexers" },
  // shift register
  { name: "74164", description: "8-bit parallel-out serial shift register, asynchronous clear", file: "74164.dig", category: "shift register" },
  { name: "74165", description: "parallel-load 8-bit shift register", file: "74165.dig", category: "shift register" },
  { name: "74166", description: "8-Bit Parallel-In/Serial-Out Shift Register", file: "74166.dig", category: "shift register" },
  { name: "74194", description: "4-Bit Bidirectional Universal Shift Register", file: "74194.dig", category: "shift register" },
  { name: "74194real", description: "4-Bit Bidirectional Universal Shift Register, Databook implementation", file: "74194real.dig", category: "shift register" },
  { name: "74299", description: "8-Input Universal Shift/Storage Register", file: "74299.dig", category: "shift register" },
  { name: "74595", description: "8-Bit Shift Registers with 3-State Output Registers", file: "74595.dig", category: "shift register" },
];

// ---------------------------------------------------------------------------
// Palette registration
// ---------------------------------------------------------------------------

/**
 * Register all 74xx ICs from the manifest into the component registry
 * under the SEVENTY_FOUR_XX palette category.
 *
 * Each IC is registered as a stub entry. The actual SubcircuitDefinition is
 * loaded on demand (lazy) when the user places the component — the file path
 * stored in the manifest drives the loader.
 *
 * If `pinMap` is provided, the stub's `pinLayout` is populated from the
 * pre-scanned pin declarations. This allows `circuit_describe` and other
 * introspection to return real pin metadata without loading the full
 * subcircuit. Use `scanDigPins()` from `io/dig-pin-scanner.ts` to build
 * the map.
 *
 * @param registry - The component registry to register into.
 * @param pinMap   - Optional map of IC name → pre-scanned PinDeclaration[].
 */
export function register74xxLibrary(
  registry: ComponentRegistry,
  pinMap?: ReadonlyMap<string, PinDeclaration[]>,
): void {
  for (const entry of LIBRARY_74XX) {
    const componentDef = {
      name: entry.name,
      typeId: -1 as const,
      factory: Object.assign(
        (_props: PropertyBag): SubcircuitElement => {
          throw new Error(
            `74xx component "${entry.name}" must be loaded from "${entry.file}" before placement.`,
          );
        },
        { __74xxStub: true },
      ),
      pinLayout: pinMap?.get(entry.name) ?? [],
      propertyDefs: [
        {
          key: "label",
          type: PropertyType.STRING,
          label: "Label",
          defaultValue: "",
          description: "Optional label override for this instance",
        },
      ],
      attributeMap: [
        {
          xmlName: "Label",
          propertyKey: "label",
          convert: (v: string) => v,
        },
      ],
      category: ComponentCategory.SEVENTY_FOUR_XX,
      helpText: `${entry.name}: ${entry.description}`,
      models: { digital: { executeFn: executeSubcircuit } },
    };

    registry.register(componentDef);
  }
}

/**
 * Register a fully loaded 74xx subcircuit into the registry.
 *
 * Called after the .dig file is parsed and the SubcircuitDefinition is
 * available. Replaces the stub entry with a fully functional definition.
 *
 * @param registry   - The component registry to register into.
 * @param name       - The IC name matching a manifest entry (e.g. "7400").
 * @param definition - The loaded subcircuit definition.
 */
export function register74xxSubcircuit(
  registry: ComponentRegistry,
  name: string,
  definition: SubcircuitDefinition,
): void {
  const entry = LIBRARY_74XX.find((e) => e.name === name);
  const description = entry ? entry.description : name;

  const propertyDefs = [
    {
      key: "label",
      type: PropertyType.STRING,
      label: "Label",
      defaultValue: "",
      description: "Optional label override for this instance",
    },
  ];

  const attributeMap = [
    {
      xmlName: "Label",
      propertyKey: "label",
      convert: (v: string) => v,
    },
  ];

  const componentDef = {
    name,
    typeId: -1 as const,
    factory: (props: PropertyBag) =>
      new SubcircuitElement(
        name,
        crypto.randomUUID(),
        { x: 0, y: 0 },
        0,
        false,
        props,
        definition,
      ),
    pinLayout: definition.pinLayout,
    propertyDefs,
    attributeMap,
    category: ComponentCategory.SEVENTY_FOUR_XX,
    helpText: `${name}: ${description}`,
    models: { digital: { executeFn: executeSubcircuit } },
  };

  registry.registerOrUpdate(componentDef);
}

/**
 * Load a 74xx IC from its .dig file and register it into the registry,
 * replacing the stub entry with a fully functional definition.
 *
 * @param registry  The component registry (must already contain the stub).
 * @param name      The IC name matching a manifest entry (e.g. "7400").
 * @param basePath  Base URL path to the 74xx library files (default "lib/74xx/").
 * @returns         The updated ComponentDefinition with real factory and pins.
 */
export async function load74xxComponent(
  registry: ComponentRegistry,
  name: string,
  basePath: string = "lib/74xx/",
): Promise<ComponentDefinition> {
  const entry = LIBRARY_74XX.find((e) => e.name === name);
  if (!entry) {
    throw new Error(`74xx component "${name}" not found in manifest.`);
  }

  // Dynamic imports keep this module lightweight — loader and resolver are
  // only pulled in when a 74xx component is actually placed.
  const [{ loadWithSubcircuits }, { HttpResolver }, { createLiveDefinition }] = await Promise.all([
    import('../io/subcircuit-loader.js'),
    import('../io/file-resolver.js'),
    import('./subcircuit/subcircuit.js'),
  ]);

  const resolver = new HttpResolver(basePath);
  const url = `${basePath}${entry.file}`;
  const response = await globalThis.fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch 74xx file "${entry.file}": HTTP ${response.status}`);
  }
  const xml = await response.text();

  const circuit = await loadWithSubcircuits(xml, resolver, registry);
  const definition = createLiveDefinition(circuit, "DEFAULT", name);

  register74xxSubcircuit(registry, name, definition);

  const updated = registry.get(name);
  if (!updated) {
    throw new Error(`Failed to register 74xx component "${name}".`);
  }
  return updated;
}

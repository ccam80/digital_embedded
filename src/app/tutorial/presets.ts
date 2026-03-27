/**
 * Palette presets — named component sets for common tutorial scenarios.
 *
 * Each preset is a curated list of component type names. Presets can be
 * used directly in TutorialStep.palette or modified with add/remove.
 *
 * Preset names are lowercase-kebab-case. They should be stable — don't
 * rename or remove presets once tutorials reference them.
 */

// ---------------------------------------------------------------------------
// Preset definitions
// ---------------------------------------------------------------------------

/**
 * All available palette presets.
 *
 * Usage in a tutorial step:
 *   palette: "basic-gates"                          — use preset as-is
 *   palette: { preset: "basic-gates", add: ["Mux"] } — preset + extras
 */
export const PALETTE_PRESETS: ReadonlyMap<string, readonly string[]> = new Map([

  // --- Combinational logic ---

  ['basic-gates', [
    'And', 'Or', 'Not', 'In', 'Out',
  ]],

  ['gates-and-io', [
    'And', 'Or', 'Not', 'NAnd', 'NOr', 'XOr', 'XNOr',
    'In', 'Out', 'Const', 'Led', 'Probe',
  ]],

  ['all-gates', [
    'And', 'Or', 'Not', 'NAnd', 'NOr', 'XOr', 'XNOr',
  ]],

  ['nand-only', [
    'NAnd', 'In', 'Out',
  ]],

  ['nor-only', [
    'NOr', 'In', 'Out',
  ]],

  // --- Sequential logic ---

  ['sequential-intro', [
    'NAnd', 'NOr', 'And', 'Or', 'Not',
    'In', 'Out', 'Clock', 'Led', 'Probe',
  ]],

  ['flip-flops', [
    'FlipflopD', 'FlipflopJK', 'FlipflopRS', 'FlipflopT',
    'FlipflopD_async', 'FlipflopJK_async', 'FlipflopRS_async',
    'In', 'Out', 'Clock', 'Led', 'Probe',
  ]],

  ['counters-and-registers', [
    'FlipflopD', 'FlipflopJK', 'FlipflopT',
    'Counter', 'CounterPreset', 'Register',
    'And', 'Or', 'Not', 'XOr',
    'In', 'Out', 'Clock', 'Led', 'Probe', 'Const',
    'SevenSegHex',
  ]],

  // --- Memory ---

  ['memory', [
    'FlipflopD', 'Register', 'RegisterFile',
    'ROM', 'RAMSinglePort', 'Counter',
    'And', 'Or', 'Not', 'Mux', 'Demux', 'Decoder',
    'In', 'Out', 'Clock', 'Const', 'Led', 'Probe',
    'Splitter', 'SevenSegHex',
  ]],

  // --- Arithmetic ---

  ['arithmetic', [
    'Add', 'Sub', 'Mul', 'Comparator', 'Neg', 'BitExtender',
    'And', 'Or', 'Not', 'XOr',
    'In', 'Out', 'Const', 'Led', 'Probe',
    'Splitter', 'Mux',
  ]],

  // --- Wiring and multiplexing ---

  ['mux-and-wiring', [
    'Mux', 'Demux', 'Decoder', 'BitSelector', 'PriorityEncoder',
    'Splitter', 'Driver',
    'And', 'Or', 'Not',
    'In', 'Out', 'Const', 'Led', 'Probe',
  ]],

  // --- Switching (transistor-level) ---

  ['switching', [
    'NFET', 'PFET', 'TransGate',
    'Relay', 'Switch',
    'In', 'Out', 'Ground', 'VDD', 'Led', 'LightBulb',
    'PullUp', 'PullDown',
  ]],

  // --- Display and I/O ---

  ['io-rich', [
    'And', 'Or', 'Not', 'NAnd', 'NOr', 'XOr',
    'In', 'Out', 'Clock', 'Const',
    'Led', 'RGBLed', 'LightBulb', 'PolarityLed',
    'Button', 'DipSwitch',
    'SevenSeg', 'SevenSegHex', 'SixteenSeg',
    'Probe', 'Scope',
  ]],

  // --- Full palette (no restriction) ---

  ['full', [
    // This is a sentinel — resolved by the palette system to mean "no filter".
    // Listed here so the preset name validates, but resolves to null allowlist.
  ]],
]);

// ---------------------------------------------------------------------------
// Preset resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a PaletteSpec to a flat list of component type names,
 * or null to mean "show everything" (no filter).
 */
export function resolvePaletteSpec(
  spec: import('./types.js').PaletteSpec | null | undefined,
): string[] | null {
  if (spec === null || spec === undefined) return null;

  if (typeof spec === 'string') {
    // Named preset
    if (spec === 'full') return null;
    const preset = PALETTE_PRESETS.get(spec);
    return preset ? [...preset] : null;
  }

  if (Array.isArray(spec)) {
    // Explicit list
    return spec.length > 0 ? spec : null;
  }

  // Preset with modifications
  const base = spec.preset === 'full' ? null : PALETTE_PRESETS.get(spec.preset);
  if (base === null) return null; // "full" preset
  if (base === undefined) return null; // Unknown preset — fall through to no filter

  const result = new Set(base);
  for (const name of spec.add ?? []) result.add(name);
  for (const name of spec.remove ?? []) result.delete(name);
  return result.size > 0 ? Array.from(result) : null;
}

/**
 * List all available preset names and their component counts.
 * Useful for agent discovery.
 */
export function listPresets(): Array<{ name: string; count: number; components: readonly string[] }> {
  const result: Array<{ name: string; count: number; components: readonly string[] }> = [];
  for (const [name, components] of PALETTE_PRESETS) {
    result.push({ name, count: components.length, components });
  }
  return result;
}

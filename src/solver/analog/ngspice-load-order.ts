import type { ComponentRegistry } from "../../core/registry.js";

/**
 * NGSPICE_LOAD_ORDER- device-type ordinals for cktLoad order parity (A1).
 *
 * Per-type cktLoad ordinals matching `ref/ngspice/src/spicelib/devices/dev.c`
 * `DEVices[]` registration order. Lower ordinal = loaded first.
 *
 * Each `make*` analog factory must set its returned `AnalogElement.ngspiceLoadOrder`
 * to one of these constants. The compiler sorts `analogElements` by this field
 * before handing it to the engine so that the per-iteration `cktLoad` walks
 * devices in the same per-type bucket order ngspice does (every R, every C,
 * ..., every V, ...). This is a structural prerequisite for our internal
 * sparse-matrix indices to match ngspice bit-exact, since ngspice's `Translate`
 * (spbuild.c:436-504) lazily assigns internal indices on first sight of each
 * external row/col during the first NR iteration's load loop.
 *
 * Extend this enum when a new device type is added under parity testing-
 * the existing entries reflect the subset of ngspice device types we have
 * fixtures for plus a few neighbours.
 *
 * Sort target: URC -> ... -> VSRC -> BEHAVIORAL.
 *
 * Composite-internal MNA node IDs are pre-allocated at compile time inside
 * `buildAnalogNodeMapFromPartition`'s deck-order walk (compiler.ts), at the
 * point each parent composite is visited — interleaved with external node
 * allocation in ngspice INPpas2 flattened-deck first-encounter order. The
 * resulting IDs are seeded into the engine's `_nodeTable` via
 * `preAllocatedNodes` before `_setup()` runs. `expandCompositeInstance`
 * reads those IDs by `${parentLabel}#${suffix}` key when it builds the
 * leaves; declared-but-unreferenced internal nets fall to a per-instance
 * straggler allocator whose IDs land past the deck-walk range. There are
 * no compiler pseudo-leaves any more; every element in the engine's walk
 * is a real ngspice-shaped device.
 */
export const NGSPICE_LOAD_ORDER = {
  URC:  0,   // dev.c:141- MUST precede both resistors and capacitors
  ASRC: 1,   // dev.c:153 get_asrc_info — immediately after URC, before BJT
  BJT:  2,
  CAP:  17,
  CCCS: 18,
  CCVS: 19,
  CPL:  20,  // dev.c: get_cpl_info (index 20)
  CSW:  21,  // dev.c: get_csw_info (index 21) — current-controlled switch (W element)
  DIO:  22,
  IND:  27,
  MUT:  28,
  ISRC: 29,
  JFET: 30,
  JFET2: 31,  // dev.c:185 get_jfet2_info — immediately after JFET (184)
  MES:  32,   // dev.c:187 get_mes_info — after jfet2 (185), before mos1 (189)
  MOS:  35,
  RES:  40,
  SW:   42,
  TRA:  43,
  TXL:  44,  // dev.c: get_txl_info (index 44)
  VCCS: 46,
  VCVS: 47,
  VSRC: 48,

  BEHAVIORAL: 49, // new- ngspice B-source position; every internalOnly
                  // behavioural driver leaf added by this phase uses
                  // this ordinal.

  // XSPICE 'A'-device code models (hyst, dac_bridge, adc_bridge, ...). ngspice
  // loads the static built-ins first (dev.c:280-283 over static_devices[]) and
  // appends codemodel-loaded devices after them, so an 'A' device loads after
  // every primitive- the same post-VSRC position the behavioural leaves take.
  XSPICE: 49,
} as const;

/**
 * DeviceFamily- bucket key for per-type device orchestration.
 *
 * Values mirror the ngspice DEVices[] indices in dev.c / cktload.c / ckttemp.c.
 * Used by family-dispatch.ts to iterate buckets in NGSPICE_LOAD_ORDER order
 * and dispatch to the registered FamilyHandler (or the default per-instance
 * walker). CPL, TXL, URC are reserved- their family keys exist so the registry
 * shape can accommodate them; no loaders ship today.
 *
 * Spec ref: spec/refactor-per-type-orchestration.md §4.1
 */
export type DeviceFamily =
  | "IND"
  | "MUT"
  | "VSRC"
  | "ISRC"
  | "ASRC"
  | "VCVS"
  | "VCCS"
  | "CCVS"
  | "CCCS"
  | "RES"
  | "CAP"
  | "SW"
  | "CSW"
  | "TRA"
  | "DIO"
  | "BJT"
  | "JFET"
  | "MES"
  | "JFET2"
  | "MOS"
  | "BEHAVIORAL"
  | "CPL"
  | "TXL"
  | "URC"
  | "XSPICE";

/**
 * Per-`typeId` ngspice load-order lookup, mirroring `DEVices[]` indexing.
 *
 * In ngspice, load order is a property of the device TYPE (its position in the
 * global `DEVices[]` array- see dev.c). It is not a per-instance or per-model
 * field. To match ngspice's parser-time node-numbering walk order without
 * instantiating element factories, the analog compiler queries this table
 * before constructing `AnalogElement`s.
 *
 * Composite components (Optocoupler, ADC, DAC, opamp, timer-555, etc.) decompose
 * into multiple sub-element stamps at runtime, but to ngspice they look like
 * one or more independent device lines on the deck. The value here is the
 * load-order bucket the composite's outer wrapper occupies (matching the
 * `readonly ngspiceLoadOrder` field on its AnalogElement subclass). Circuits
 * that mix composites with primitives in a single bucket are not currently
 * parity-tested against ngspice; primitives in fixtures (R, C, L, V, I, Q, M,
 * D, J) all have unambiguous entries here.
 */
/**
 * Netlist-device metadata for one typeId, derived at registration from the
 * emitting model entry's `spice` block. `family` is the ngspice DEVices[]
 * bucket; load order is `NGSPICE_LOAD_ORDER[family]`. `deckNodeTokens` is the
 * pin order whose node IDs the device line mints (absent for a multi-line
 * composite such as a Transformer, whose sub-element lines supply the order).
 */
export interface NetlistDeviceInfo {
  family: DeviceFamily;
  deckNodeTokens?: readonly string[];
}

/**
 * typeId → NetlistDeviceInfo, rebuilt from the registry whenever components are
 * registered (`buildNetlistDeviceIndex`). The single source of truth is each
 * model entry's `spice.device` / `spice.deckNodeTokens`; this index replaces the
 * former hand-kept per-typeId load-order / device-family / deck-pin tables.
 */
const NETLIST_DEVICE_BY_TYPE = new Map<string, NetlistDeviceInfo>();

/**
 * Populate the typeId → NetlistDeviceInfo index from every registered
 * definition's model entries. Called once after registration
 * (registerAllComponents). A typeId is recorded from the first model entry that
 * declares `spice.device`; a device's models share one family and node-token
 * order, so one entry suffices for these typeId-level lookups (per-model
 * precision, where it matters, reads the resolved model entry directly).
 */
export function buildNetlistDeviceIndex(registry: ComponentRegistry): void {
  NETLIST_DEVICE_BY_TYPE.clear();
  for (const def of registry.getAll()) {
    if (!def.modelRegistry) continue;
    for (const entry of Object.values(def.modelRegistry)) {
      const device = entry.spice?.device;
      if (device === undefined) continue;
      NETLIST_DEVICE_BY_TYPE.set(def.name, {
        family: device,
        ...(entry.spice?.deckNodeTokens !== undefined
          ? { deckNodeTokens: entry.spice.deckNodeTokens }
          : {}),
      });
      break;
    }
  }
}

/**
 * Look up ngspice load order by typeId, as `NGSPICE_LOAD_ORDER[family]` from the
 * registration-built index. Returns a high sentinel (1000) for unknown /
 * composite / behavioural-only typeIds so they sort to the end of the deck walk
 * used for node numbering.
 */
export function getNgspiceLoadOrderByTypeId(typeId: string): number {
  const info = NETLIST_DEVICE_BY_TYPE.get(typeId);
  if (info === undefined) return 1000;
  return (NGSPICE_LOAD_ORDER as Record<string, number>)[info.family] ?? 1000;
}

/**
 * Look up DeviceFamily by typeId from the registration-built index. Returns
 * "BEHAVIORAL" for unknown / composite / behavioural-only typeIds so they sort
 * to the BEHAVIORAL bucket.
 */
export function getDeviceFamilyByTypeId(typeId: string): DeviceFamily {
  return NETLIST_DEVICE_BY_TYPE.get(typeId)?.family ?? "BEHAVIORAL";
}

/**
 * DeviceFamilies whose leaves emit a primitive device that is matched against
 * ngspice (one deck line per leaf). A leaf in one of these families must declare
 * its node-token order in its model entry's `spice.deckNodeTokens` so the
 * compiler's node-allocation walk numbers its nodes in ngspice's INPpas2
 * first-encounter order. Behavioural-only leaves (family `BEHAVIORAL`) have no
 * ngspice counterpart and are never harness-compared, so they carry no tokens.
 * Single source of truth, shared by the registry audit and the compiler enumerator.
 */
export const DECK_EMITTING_FAMILIES: ReadonlySet<DeviceFamily> = new Set<DeviceFamily>([
  "RES", "CAP", "IND", "VSRC", "ISRC", "DIO", "BJT", "MOS", "JFET", "MES",
  "JFET2", "TRA", "CCCS", "CCVS", "VCCS", "VCVS", "ASRC", "CSW", "MUT", "XSPICE",
]);

/**
 * Canonical DeviceFamily -> SPICE card-letter map- the single source of truth for
 * the prefix ngspice's parser keys each device line on. The SPICE prefix is a
 * property of the device FAMILY (every MOS variant is `M`, every diode `D`,
 * ASRC `B`), so it lives here next to the family ordinals rather than being
 * duplicated per typeId. The harness label canonicalizer and the topology-diff
 * element matcher derive from this; the emitter's per-typeId ELEMENT_SPECS
 * additionally carries model-type/level plus a few typeId aliases (e.g. LDR->R)
 * that are not family-derivable. Behavioural-only families have no card, no entry.
 */
export const SPICE_PREFIX_BY_FAMILY: Partial<Record<DeviceFamily, string>> = {
  RES: "R", CAP: "C", IND: "L", MUT: "K",
  VSRC: "V", ISRC: "I", ASRC: "B",
  DIO: "D", BJT: "Q", MOS: "M", JFET: "J", JFET2: "J", MES: "Z",
  VCVS: "E", VCCS: "G", CCVS: "H", CCCS: "F",
  SW: "S", CSW: "W", TRA: "T", URC: "U",
  XSPICE: "A", // XSPICE code-model 'A' device (e.g. hyst): `a<name> … <model>`.
};

/**
 * Look up a typeId's SPICE deck node-token order — the pin labels whose node
 * IDs the device line mints, in deck order (ngspice's INP2* first-encounter
 * sequence) — from the registration-built index. Returns undefined for a typeId
 * with no emitting model (behavioural-only / composite) or a multi-line
 * composite that declares a family but no single node-token line. The data
 * lives on each model entry's `spice.deckNodeTokens`.
 */
export function getDeckNodeTokensByTypeId(typeId: string): readonly string[] | undefined {
  return NETLIST_DEVICE_BY_TYPE.get(typeId)?.deckNodeTokens;
}

/**
 * Deck-line ordering producer- single source of truth for the order ngspice's
 * pass-2 parser walks device lines, shared by the MNA node-map walk and the
 * harness deck emitter.
 *
 * inppas2.c:76 numbers MNA nodes by walking the parsed card list top-to-bottom
 * (`for (current = data; current != NULL; current = current->nextcard)`),
 * dispatching each leading character to its `INP2*` parser via the pass-2
 * `switch` (inppas2.c:94-263). Within an NGSPICE_LOAD_ORDER bucket (a device
 * type's position in dev.c's `DEVices[]`), the emitted line order is the order
 * this function returns- forward within bucket (`originalIndex` ascending).
 * cktcrte.c:62-64's LIFO instance prepend reverses only the per-iteration load
 * walk (CKTsetup head→tail over `GENinstances`), never the parse-time numbering,
 * so node numbering is strictly the forward deck order produced here.
 *
 * The MNA node-map walk (`buildAnalogNodeMapFromPartition`) and the harness deck
 * emitter (`__tests__/harness/netlist-generator.ts`) MUST iterate device lines
 * in this identical order, or parse-time node integers desync from the emitted
 * deck. The dependency direction is strictly harness → production: production
 * imports `deckOrder` from here; this module never imports the harness.
 */
export function deckOrder<T extends { typeId: string }>(
  components: readonly T[],
): { item: T; originalIndex: number }[] {
  return components
    .map((item, originalIndex) => ({ item, originalIndex }))
    .sort((a, b) => {
      const lhs = getNgspiceLoadOrderByTypeId(a.item.typeId);
      const rhs = getNgspiceLoadOrderByTypeId(b.item.typeId);
      if (lhs !== rhs) return lhs - rhs;
      return a.originalIndex - b.originalIndex; // forward-within-bucket
    });
}


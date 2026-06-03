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
  MES:  31,  // dev.c:184-189- get_mes_info, between jfet/jfet2 and mos1
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
  | "MOS"
  | "BEHAVIORAL"
  | "CPL"
  | "TXL"
  | "URC";

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
export const TYPE_ID_TO_NGSPICE_LOAD_ORDER: Readonly<Record<string, number>> = {
  // Primitives
  Resistor:        NGSPICE_LOAD_ORDER.RES,
  Capacitor:       NGSPICE_LOAD_ORDER.CAP,
  PolarizedCap:    NGSPICE_LOAD_ORDER.CAP,
  Inductor:        NGSPICE_LOAD_ORDER.IND,
  MutualInductor:  NGSPICE_LOAD_ORDER.MUT,
  Transformer:     NGSPICE_LOAD_ORDER.IND,
  TappedTransformer: NGSPICE_LOAD_ORDER.IND,
  TransmissionLine: NGSPICE_LOAD_ORDER.TRA,
  DcVoltageSource: NGSPICE_LOAD_ORDER.VSRC,
  AcVoltageSource: NGSPICE_LOAD_ORDER.VSRC,
  DcCurrentSource: NGSPICE_LOAD_ORDER.ISRC,
  AcCurrentSource: NGSPICE_LOAD_ORDER.ISRC,
  Diode:           NGSPICE_LOAD_ORDER.DIO,
  ZenerDiode:      NGSPICE_LOAD_ORDER.DIO,
  VaractorDiode:   NGSPICE_LOAD_ORDER.DIO,
  SchottkyDiode:NGSPICE_LOAD_ORDER.DIO,
  NpnBJT:          NGSPICE_LOAD_ORDER.BJT,
  PnpBJT:          NGSPICE_LOAD_ORDER.BJT,
  NMOS:            NGSPICE_LOAD_ORDER.MOS,
  PMOS:            NGSPICE_LOAD_ORDER.MOS,
  NJFET:           NGSPICE_LOAD_ORDER.JFET,
  PJFET:           NGSPICE_LOAD_ORDER.JFET,
  NMESFET:         NGSPICE_LOAD_ORDER.MES,
  PMESFET:         NGSPICE_LOAD_ORDER.MES,
  // Switches
  CurrentControlledSwitch: NGSPICE_LOAD_ORDER.CSW,
  // Behavioral / controlled sources
  VCCS:            NGSPICE_LOAD_ORDER.VCCS,
  VCVS:            NGSPICE_LOAD_ORDER.VCVS,
  CCCS:            NGSPICE_LOAD_ORDER.CCCS,
  CCVS:            NGSPICE_LOAD_ORDER.CCVS,
};

/**
 * Look up ngspice load order by typeId. Returns a high sentinel for
 * unknown / composite typeIds so they sort to the end of the deck walk used
 * for node numbering. Composite components in fixtures share that sentinel
 * bucket; ngspice-parity for composites is not established.
 */
export function getNgspiceLoadOrderByTypeId(typeId: string): number {
  return TYPE_ID_TO_NGSPICE_LOAD_ORDER[typeId] ?? 1000;
}

/**
 * Per-`typeId` DeviceFamily lookup, derived from the same DEVices[] position
 * mapping as TYPE_ID_TO_NGSPICE_LOAD_ORDER.
 */
export const TYPE_ID_TO_DEVICE_FAMILY: Readonly<Record<string, DeviceFamily>> = {
  // Primitives
  Resistor:        "RES",
  Capacitor:       "CAP",
  PolarizedCap:    "CAP",
  Inductor:        "IND",
  MutualInductor:  "MUT",
  Transformer:     "IND",
  TappedTransformer: "IND",
  TransmissionLine: "TRA",
  DcVoltageSource: "VSRC",
  AcVoltageSource: "VSRC",
  DcCurrentSource: "ISRC",
  AcCurrentSource: "ISRC",
  Diode:           "DIO",
  ZenerDiode:      "DIO",
  VaractorDiode:   "DIO",
  SchottkyDiode:   "DIO",
  NpnBJT:          "BJT",
  PnpBJT:          "BJT",
  NMOS:            "MOS",
  PMOS:            "MOS",
  NJFET:           "JFET",
  PJFET:           "JFET",
  NMESFET:         "MES",
  PMESFET:         "MES",
  // Switches
  CurrentControlledSwitch: "CSW",
  // Behavioral / controlled sources
  VCCS:            "VCCS",
  VCVS:            "VCVS",
  CCCS:            "CCCS",
  CCVS:            "CCVS",
};

/**
 * Look up DeviceFamily by typeId. Returns "BEHAVIORAL" for unknown / composite
 * typeIds so they sort to the BEHAVIORAL bucket.
 */
export function getDeviceFamilyByTypeId(typeId: string): DeviceFamily {
  return TYPE_ID_TO_DEVICE_FAMILY[typeId] ?? "BEHAVIORAL";
}

/**
 * Per-`typeId` SPICE deck pin-emission order.
 *
 * Each entry lists the digiTS pin labels in the order their corresponding
 * node IDs appear on the element's SPICE deck line- i.e. the order ngspice's
 * parser visits each node name. This MUST match exactly what
 * `__tests__/harness/netlist-generator.ts` emits, because ngspice numbers MNA
 * nodes during deck PARSE (cktnewn.c via INPtermInsert from the per-type
 * `INP2*` parsers). Pin labels not listed here, or pin labels that the deck
 * line repeats (e.g. NMOS body pin tied to source), do not contribute new
 * node IDs and are omitted from the entry.
 *
 * Identity entries are listed explicitly rather than omitted so a
 * registry-startup audit can assert every analog typeId in `pinLayout` is
 * accounted for here.
 */
export const TYPE_ID_TO_DECK_PIN_LABEL_ORDER: Readonly<Record<string, readonly string[]>> = {
  // Two-terminal passives (deck: name n+ n- value)- pinLayout matches
  Resistor:        ["pos", "neg"],
  Capacitor:       ["pos", "neg"],
  PolarizedCap:    ["pos", "neg"],
  Inductor:        ["pos", "neg"],
  // Vname pos neg <spec>
  DcVoltageSource: ["pos", "neg"],
  AcVoltageSource: ["pos", "neg"],
  // Iname pos neg <spec>
  DcCurrentSource: ["pos", "neg"],
  AcCurrentSource: ["pos", "neg"],
  // D name A K model
  Diode:           ["A", "K"],
  ZenerDiode:      ["A", "K"],
  VaractorDiode:   ["A", "K"],
  SchottkyDiode:["A", "K"],
  // Q name C B E model
  NpnBJT:          ["C", "B", "E"],
  PnpBJT:          ["C", "B", "E"],
  // M name D G S B model- body tied to source by netlist-generator, so
  // numbering only sees three distinct nodes
  NMOS:            ["D", "G", "S"],
  PMOS:            ["D", "G", "S"],
  // J name D G S model
  NJFET:           ["D", "G", "S"],
  PJFET:           ["D", "G", "S"],
  // Z name D G S model (mes.c:66-70 MESnames = Drain/Gate/Source)
  NMESFET:         ["D", "G", "S"],
  PMESFET:         ["D", "G", "S"],
  // T name pos1 neg1 pos2 neg2 Z0=... TD=...
  // ngspice TRAnames (tra.c:32-37): ["P1+","P1-","P2+","P2-"] → digiTS [P1b,P1a,P2b,P2a].
  TransmissionLine: ["P1b", "P1a", "P2b", "P2a"],
  // F/H sense-via-label: only out pins appear on the deck card; the sense
  // V-source is referenced by device name. Deck: `F/Hname out+ out- VSENSE gain`.
  CCCS:            ["out+", "out-"],
  CCVS:            ["out+", "out-"],
  // E/G ctrl-as-nodes: ctrl pins follow out pins on the deck card.
  // Deck: `E/Gname out+ out- ctrl+ ctrl- gain`.
  VCCS:            ["out+", "out-", "ctrl+", "ctrl-"],
  VCVS:            ["out+", "out-", "ctrl+", "ctrl-"],
  // Transformer / TappedTransformer are MULTI-LINE composites (see
  // MULTI_LINE_COMPOSITES below): they decompose into per-winding `L` cards plus a
  // `K` coupling, so there is NO single deck card with a fixed node-token order.
  // Node numbering comes from the winding sub-element lines (each an Inductor
  // ["pos","neg"]) via the composite node-alloc walk- they carry no row here.
  // K-card mutual coupling (`Kname Lname1 Lname2 k`, inp2k.c) references the two
  // inductors by device name and reads NO node tokens, so it mints no node IDs.
  MutualInductor:    [],
  // W-card current-controlled switch (`Wname out+ out- VSENSE model`, inp2w.c):
  // the sense element is referenced by device name, so only the two output
  // node tokens appear on the card.
  CurrentControlledSwitch: ["out+", "out-"],
};

/**
 * Multi-line composite typeIds: devices that decompose into MULTIPLE deck cards
 * (a Transformer -> per-winding `L` lines + a `K`), so they have no single
 * deck-pin-order row- their node numbering comes from their sub-element lines via
 * the composite node-alloc walk. Both the registry self-check
 * (ngspice-load-order-audit.ts) and `auditDeckPinOrderCoverage` below exempt these
 * from the "must have a deck-pin row" rule. Single source of truth for the set.
 */
export const MULTI_LINE_COMPOSITES: ReadonlySet<string> = new Set<string>([
  "Transformer",
  "TappedTransformer",
]);

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

/**
 * Startup audit asserting every analog typeId the deck generator can emit has a
 * `TYPE_ID_TO_DECK_PIN_LABEL_ORDER` row.
 *
 * inppas2.c:94-263- every device class ngspice's pass-2 switch dispatches has a
 * fixed node-token order in its `INP2*` parser. The MNA node-map walk reproduces
 * that order from this table; a missing row would silently fall back to pinLayout
 * order, which is the deck order only by coincidence. Auditing at startup makes a
 * gap a loud error rather than a parity drift discovered three layers down.
 *
 * Only typeIds that carry a SPICE card (an `NGSPICE_LOAD_ORDER` / family entry)
 * are checked; genuinely card-less composite outer typeIds legitimately have no
 * row- their sub-element lines drive node numbering, so the pinLayout order
 * applies to them and is correct.
 */
export function auditDeckPinOrderCoverage(analogTypeIds: readonly string[]): void {
  for (const typeId of analogTypeIds) {
    if (!(typeId in TYPE_ID_TO_NGSPICE_LOAD_ORDER)) continue; // card-less composite
    if (MULTI_LINE_COMPOSITES.has(typeId)) continue; // sub-element cards supply node order
    if (!(typeId in TYPE_ID_TO_DECK_PIN_LABEL_ORDER)) {
      // Warn, never throw: a missing row is a developer-facing coverage gap, not a
      // reason to break every compile (and take the MCP/simulator down with it). The
      // node-walk falls back to pinLayout order; if that differs from deck order it
      // surfaces as a harness parity divergence on that device's own gate- the right
      // place to catch it, not a hard crash three layers up.
      console.warn(
        `[ngspice-load-order] TYPE_ID_TO_DECK_PIN_LABEL_ORDER missing "${typeId}"; ` +
          `node numbering falls back to pinLayout order (inppas2.c:94-263).`,
      );
    }
  }
}

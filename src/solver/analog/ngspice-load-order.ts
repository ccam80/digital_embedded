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
 * Composite-internal MNA node IDs are pre-allocated at compile time by
 * `expandCompositeInstance` (compiler.ts) and seeded into the engine's
 * `_nodeTable` before `_setup()` runs. There are no compiler pseudo-leaves
 * any more; every element in the engine's walk is a real ngspice-shaped
 * device.
 */
export const NGSPICE_LOAD_ORDER = {
  URC:  0,   // dev.c:141- MUST precede both resistors and capacitors
  BJT:  2,
  CAP:  17,
  CCCS: 18,
  CCVS: 19,
  CPL:  20,  // dev.c: get_cpl_info (index 20)
  DIO:  22,
  IND:  27,
  MUT:  28,
  ISRC: 29,
  JFET: 30,
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
  | "VSRC"
  | "ISRC"
  | "VCVS"
  | "VCCS"
  | "CCVS"
  | "CCCS"
  | "RES"
  | "CAP"
  | "SW"
  | "TRA"
  | "DIO"
  | "BJT"
  | "JFET"
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
  CurrentSource:   NGSPICE_LOAD_ORDER.ISRC,
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
  MutualInductor:  "IND",
  Transformer:     "IND",
  TappedTransformer: "IND",
  TransmissionLine: "TRA",
  DcVoltageSource: "VSRC",
  AcVoltageSource: "VSRC",
  CurrentSource:   "ISRC",
  Diode:           "DIO",
  ZenerDiode:      "DIO",
  VaractorDiode:   "DIO",
  SchottkyDiode:"DIO",
  NpnBJT:          "BJT",
  PnpBJT:          "BJT",
  NMOS:            "MOS",
  PMOS:            "MOS",
  NJFET:           "JFET",
  PJFET:           "JFET",
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
  CurrentSource:   ["pos", "neg"],
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
};

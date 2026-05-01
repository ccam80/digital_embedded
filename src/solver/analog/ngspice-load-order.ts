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
 * Pseudo-leaves (negative ordinals) are compiler-internal elements that the
 * engine's _setup and _load walks handle before any real ngspice device:
 *   INTERNAL_NET_ALLOC (-2): makeInternalNetAllocator- calls ctx.makeVolt for
 *     each internal net declared in the subcircuit netlist.
 *   INTERNAL_NET_PATCH (-1): patcher- writes resolved node IDs into _pinNodes
 *     of every leaf element after internal net allocation completes.
 * Sort target: ALLOC -> PATCH -> URC -> ... -> VSRC -> BEHAVIORAL.
 */
export const NGSPICE_LOAD_ORDER = {
  // Compiler pseudo-leaves (negative- precede every real device,
  // including URC). Sort target: ALLOC -> PATCH -> URC -> ... -> VSRC -> BEHAVIORAL.
  INTERNAL_NET_ALLOC: -2, // makeInternalNetAllocator: ctx.makeVolt per internal net
  INTERNAL_NET_PATCH: -1, // patcher: writes resolved node IDs into _pinNodes

  URC:  0,   // dev.c:141- MUST precede both resistors and capacitors
  BJT:  2,
  CAP:  17,
  CCCS: 18,
  CCVS: 19,
  DIO:  22,
  IND:  27,
  MUT:  28,
  ISRC: 29,
  JFET: 30,
  MOS:  35,
  RES:  40,
  SW:   42,
  TRA:  43,
  VCCS: 46,
  VCVS: 47,
  VSRC: 48,

  BEHAVIORAL: 49, // new- ngspice B-source position; every internalOnly
                  // behavioural driver leaf added by this phase uses
                  // this ordinal.
} as const;

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
  Transformer:     NGSPICE_LOAD_ORDER.IND,
  TappedTransformer: NGSPICE_LOAD_ORDER.IND,
  TransmissionLine: NGSPICE_LOAD_ORDER.TRA,
  DcVoltageSource: NGSPICE_LOAD_ORDER.VSRC,
  AcVoltageSource: NGSPICE_LOAD_ORDER.VSRC,
  CurrentSource:   NGSPICE_LOAD_ORDER.ISRC,
  Diode:           NGSPICE_LOAD_ORDER.DIO,
  ZenerDiode:      NGSPICE_LOAD_ORDER.DIO,
  VaractorDiode:   NGSPICE_LOAD_ORDER.DIO,
  Schottky:        NGSPICE_LOAD_ORDER.DIO,
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
 * Look up ngspice load order by typeId. Falls back to a high sentinel for
 * unknown / composite typeIds so they sort to the end of the deck walk used
 * for node numbering. Composite components in fixtures mix into their own
 * bucket via this fallback; ngspice-parity for composites is not currently
 * established.
 */
export function getNgspiceLoadOrderByTypeId(typeId: string): number {
  return TYPE_ID_TO_NGSPICE_LOAD_ORDER[typeId] ?? 1000;
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
  Schottky:        ["A", "K"],
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

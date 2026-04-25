/**
 * Device name correspondence between our state-pool slot names and
 * ngspice CKTstate0 offsets.
 *
 * This file contains ONLY direct-offset correspondences — i.e. the same
 * physical quantity (junction voltage, junction charge, etc.) recorded on
 * both sides under different names. If a slot does not have a direct
 * correspondence here, it is not comparable — that is a BLOCKER, to be
 * resolved in `architectural-alignment.md`.
 *
 * Sources:
 *   Capacitor: ngspice src/spicelib/devices/cap/capdefs.h
 *   Inductor:  ngspice src/spicelib/devices/ind/inddefs.h
 *   Diode:     ngspice src/spicelib/devices/dio/diodefs.h
 *   BJT:       ngspice src/spicelib/devices/bjt/bjtdefs.h
 *   MOSFET:    ngspice src/spicelib/devices/mos1/mos1defs.h (Level 1)
 *   JFET:      ngspice src/spicelib/devices/jfet/jfetdefs.h
 */

import type { DeviceMapping } from "./types.js";

// ---------------------------------------------------------------------------
// Capacitor
// ---------------------------------------------------------------------------
// ngspice cap state offsets (capdefs.h:66-67): CAPqcap=0, CAPccap=1.

export const CAPACITOR_MAPPING: DeviceMapping = {
  deviceType: "capacitor",
  slotToNgspice: {
    Q: 0,
    CCAP: 1,
  },
  ngspiceToSlot: {
    0: "Q",
    1: "CCAP",
  },
};

// ---------------------------------------------------------------------------
// Inductor
// ---------------------------------------------------------------------------
// ngspice ind state offsets (inddefs.h:68-69):
//   INDflux = INDstate+0   — flux Φ = L·i (the qcap fed to NIintegrate)
//   INDvolt = INDstate+1   — NIintegrate companion current. Despite the
//                            "INDvolt" name, niinteg.c:15
//                            (`#define ccap qcap+1`) makes this slot the
//                            ccap recursion buffer, not a node voltage.
//
// digiTS schema (inductor.ts INDUCTOR_SCHEMA): PHI=0, CCAP=1 — same offsets,
// same semantics, ngspice-exact 1:1.

export const INDUCTOR_MAPPING: DeviceMapping = {
  deviceType: "inductor",
  slotToNgspice: {
    PHI:  0,
    CCAP: 1,
  },
  ngspiceToSlot: {
    0: "PHI",
    1: "CCAP",
  },
};

// ---------------------------------------------------------------------------
// Diode
// ---------------------------------------------------------------------------
// ngspice dio state offsets (diodefs.h:154-158):
//   DIOvoltage=0, DIOcurrent=1, DIOconduct=2,
//   DIOcapCharge=3, DIOcapCurrent=4, DIOinitCond=5 (not compared)
//
// Post-D-2a rename: digiTS slot for DIOcapCurrent is `CAP_CURRENT` (dual
// semantics per dioload.c:363: iqcap in MODETRAN, capd in MODEINITSMSIG).
// The digiTS schema `CCAP` slot is a niIntegrate companion-current output
// with no ngspice CKTstate correspondence — not mapped.

export const DIODE_MAPPING: DeviceMapping = {
  deviceType: "diode",
  slotToNgspice: {
    VD: 0,
    ID: 1,
    GEQ: 2,
    Q: 3,
    CAP_CURRENT: 4,
  },
  ngspiceToSlot: {
    0: "VD",
    1: "ID",
    2: "GEQ",
    3: "Q",
    4: "CAP_CURRENT",
  },
};

// ---------------------------------------------------------------------------
// BJT (SPICE L1 — Gummel-Poon)
// ---------------------------------------------------------------------------
// ngspice bjt state offsets (bjtdefs.h:289-313):
//   BJTvbe=0, BJTvbc=1, BJTcc=2, BJTcb=3, BJTgpi=4, BJTgmu=5,
//   BJTgm=6, BJTgo=7, BJTqbe=8, BJTcqbe=9, BJTqbc=10, BJTcqbc=11,
//   BJTqsub=12, BJTcqsub=13, BJTqbx=14, BJTcqbx=15, BJTgx=16,
//   BJTcexbc=17, BJTgeqcb=18, BJTgcsub=19, BJTgeqbx=20,
//   BJTvsub=21, BJTcdsub=22, BJTgdsub=23
//
// Post-W1.2 rename: digiTS schema matches ngspice slot names for the
// resistive/cap-storage portion. Post-W1.9 close-out rename: QSUB/CQSUB
// now match ngspice bjtdefs.h BJTqsub=12 / BJTcqsub=13 exactly.
//
// Note on augmentation: our GPI/GMU/CC/CB (slots 4,5,2,3) are cap-augmented
// during transient — bjtload.c:725-734 lumps cap companion geq/ieq into
// these slots. The mappings below therefore compare our cap-augmented
// values against ngspice's CKTstate0 offsets, which are likewise augmented.

export const BJT_MAPPING: DeviceMapping = {
  deviceType: "bjt",
  slotToNgspice: {
    VBE: 0,
    VBC: 1,
    CC: 2,
    CB: 3,
    GPI: 4,
    GMU: 5,
    GM: 6,
    GO: 7,
    QBE: 8,
    CQBE: 9,
    QBC: 10,
    CQBC: 11,
    QSUB: 12,
    CQSUB: 13,
    QBX: 14,
    CQBX: 15,
    GX: 16,
    CEXBC: 17,
    GEQCB: 18,
    GCSUB: 19,
    GEQBX: 20,
  },
  ngspiceToSlot: {
    0: "VBE",
    1: "VBC",
    2: "CC",
    3: "CB",
    4: "GPI",
    5: "GMU",
    6: "GM",
    7: "GO",
    8: "QBE",
    9: "CQBE",
    10: "QBC",
    11: "CQBC",
    12: "QSUB",
    13: "CQSUB",
    14: "QBX",
    15: "CQBX",
    16: "GX",
    17: "CEXBC",
    18: "GEQCB",
    19: "GCSUB",
    20: "GEQBX",
  },
};

// ---------------------------------------------------------------------------
// MOSFET Level 1
// ---------------------------------------------------------------------------
// ngspice mos1 state offsets (mos1defs.h:269-292, MOS1numStates=17):
//   MOS1vbd=0,  MOS1vbs=1,  MOS1vgs=2,  MOS1vds=3,
//   MOS1capgs=4,  MOS1qgs=5,  MOS1cqgs=6,
//   MOS1capgd=7,  MOS1qgd=8,  MOS1cqgd=9,
//   MOS1capgb=10, MOS1qgb=11, MOS1cqgb=12,
//   MOS1qbd=13,   MOS1cqbd=14,
//   MOS1qbs=15,   MOS1cqbs=16
//
// Post-W1.3 rename: digiTS schema matches ngspice names exactly for
// slots 0-16. Schema slots 17-27 (CD, CBD, CBS, GBD, GBS, GM, GDS, GMBS,
// MODE, VON, VDSAT) correspond to MOS1instance struct fields, NOT to
// CKTstate offsets — they are not comparable via the state-pool path.

export const MOSFET_MAPPING: DeviceMapping = {
  deviceType: "mosfet",
  slotToNgspice: {
    VBD: 0,
    VBS: 1,
    VGS: 2,
    VDS: 3,
    CAPGS: 4,
    QGS: 5,
    CQGS: 6,
    CAPGD: 7,
    QGD: 8,
    CQGD: 9,
    CAPGB: 10,
    QGB: 11,
    CQGB: 12,
    QBD: 13,
    CQBD: 14,
    QBS: 15,
    CQBS: 16,
  },
  ngspiceToSlot: {
    0: "VBD",
    1: "VBS",
    2: "VGS",
    3: "VDS",
    4: "CAPGS",
    5: "QGS",
    6: "CQGS",
    7: "CAPGD",
    8: "QGD",
    9: "CQGD",
    10: "CAPGB",
    11: "QGB",
    12: "CQGB",
    13: "QBD",
    14: "CQBD",
    15: "QBS",
    16: "CQBS",
  },
};

// ---------------------------------------------------------------------------
// JFET (N-channel / P-channel)
// ---------------------------------------------------------------------------
// ngspice jfet state offsets (jfetdefs.h:154-166):
//   JFETvgs=0, JFETvgd=1, JFETcg=2, JFETcd=3, JFETcgd=4,
//   JFETgm=5, JFETgds=6, JFETggs=7, JFETggd=8,
//   JFETqgs=9, JFETcqgs=10, JFETqgd=11, JFETcqgd=12
//
// Post-W1.4 rename: digiTS schema matches ngspice names exactly. The
// prior fet-base invented slots (IDS, ID_JUNCTION, GD_JUNCTION, MEYER_GS,
// CCAP_GS/GD, etc.) are A1-excised.

export const JFET_MAPPING: DeviceMapping = {
  deviceType: "jfet",
  slotToNgspice: {
    VGS: 0,
    VGD: 1,
    CG: 2,
    CD: 3,
    CGD: 4,
    GM: 5,
    GDS: 6,
    GGS: 7,
    GGD: 8,
    QGS: 9,
    CQGS: 10,
    QGD: 11,
    CQGD: 12,
  },
  ngspiceToSlot: {
    0: "VGS",
    1: "VGD",
    2: "CG",
    3: "CD",
    4: "CGD",
    5: "GM",
    6: "GDS",
    7: "GGS",
    8: "GGD",
    9: "QGS",
    10: "CQGS",
    11: "QGD",
    12: "CQGD",
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
//
// Tunnel-diode and varactor intentionally omitted. ngspice has no dedicated
// tunnel-diode model (it's a digiTS-only device; comparison is nonsense), and
// the varactor was reusing the diode model with an invented cap-state layout
// that had no ngspice counterpart. Both are architectural BLOCKERs, not
// mapping gaps — routed to Track A (architectural-alignment.md) for a
// user decision.

/** All device mappings keyed by device type. */
export const DEVICE_MAPPINGS: Record<string, DeviceMapping> = {
  capacitor: CAPACITOR_MAPPING,
  inductor: INDUCTOR_MAPPING,
  diode: DIODE_MAPPING,
  bjt: BJT_MAPPING,
  mosfet: MOSFET_MAPPING,
  jfet: JFET_MAPPING,
};

// ---------------------------------------------------------------------------
// Type normalization
// ---------------------------------------------------------------------------

const TYPE_ID_TO_CANONICAL: Record<string, string> = {
  NpnBJT: "bjt",
  PnpBJT: "bjt",
  NMOS: "mosfet",
  PMOS: "mosfet",
  NJFET: "jfet",
  PJFET: "jfet",
  Diode: "diode",
  Zener: "diode",
  Varactor: "varactor",
  TunnelDiode: "tunnel-diode",
  Capacitor: "capacitor",
  Inductor: "inductor",
  Resistor: "resistor",
  DcVoltageSource: "vsource",
  AcVoltageSource: "vsource",
  DcCurrentSource: "isource",
  AcCurrentSource: "isource",
  SCR: "scr",
  Triac: "triac",
};

/**
 * Normalize a circuit element typeId to a canonical device type string
 * matching the keys in DEVICE_MAPPINGS.
 *
 * @param typeId - The typeId from CircuitElement (e.g. "NpnBJT", "NMOS")
 * @returns Canonical lowercase device type ("bjt", "mosfet", "diode", etc.)
 *          or "unknown" if unrecognized.
 */
export function normalizeDeviceType(typeId: string): string {
  return TYPE_ID_TO_CANONICAL[typeId] ?? "unknown";
}

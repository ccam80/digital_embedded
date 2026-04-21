/**
 * Device name correspondence between our state-pool slot names and
 * ngspice CKTstate0 offsets.
 *
 * This file contains ONLY direct-offset correspondences — i.e. the same
 * physical quantity (junction voltage, junction charge, etc.) recorded on
 * both sides under different names. Anything that required a formula, a
 * sign flip, a mapping table, or a tolerance to declare "equivalent" was
 * architectural papering and has been removed. If a slot does not have a
 * direct correspondence here, it is not comparable — that is a BLOCKER, to
 * be resolved in `architectural-alignment.md` (Track A) or by collapsing
 * `_updateOp`/`_stampCompanion` (Track B). It is never resolved by adding
 * an entry here.
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
// ngspice cap state offsets (capdefs.h): qcap=0, ccap=1.

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
// ngspice ind state offsets (inddefs.h): flux=0, ccap=1.

export const INDUCTOR_MAPPING: DeviceMapping = {
  deviceType: "inductor",
  slotToNgspice: {
    PHI: 0,
  },
  ngspiceToSlot: {
    0: "PHI",
    1: "NG_VOLT",
  },
};

// ---------------------------------------------------------------------------
// Diode
// ---------------------------------------------------------------------------
// ngspice dio state offsets (diodefs.h):
//   DIOvoltage=0, DIOcurrent=1, DIOconduct=2,
//   DIOcapCharge=3, DIOcapCurrent=4, DIOinitCond=5 (not compared)

export const DIODE_MAPPING: DeviceMapping = {
  deviceType: "diode",
  slotToNgspice: {
    VD: 0,
    GEQ: 2,
    ID: 1,
    Q: 3,
    CCAP: 4,
  },
  ngspiceToSlot: {
    0: "VD",
    1: "ID",
    2: "GEQ",
    3: "Q",
    4: "CCAP",
  },
};

// ---------------------------------------------------------------------------
// BJT (SPICE L1 — Gummel-Poon)
// ---------------------------------------------------------------------------
// ngspice bjt state offsets (bjtdefs.h):
//   BJTvbe=0, BJTvbc=1, BJTcc=2, BJTcb=3, BJTgpi=4, BJTgmu=5,
//   BJTgm=6, BJTgo=7, BJTqbe=8, BJTcqbe=9, BJTqbc=10, BJTcqbc=11,
//   BJTqcs=12, BJTcqcs=13, BJTqbx=14, BJTcqbx=15, BJTgx=16,
//   BJTcexbc=17, BJTgeqcb=18, BJTgccs=19, BJTgeqbx=20
//
// Note on augmentation: our GPI/GMU/IC/IB (slots 2,3,6,7) are cap-augmented
// during transient — stampCompanion lumps cap companion geq/ieq into these
// slots to match ngspice bjtload.c:725-734. The slot-to-offset mappings below
// therefore compare our cap-augmented values against ngspice's CKTstate0
// offsets, which are likewise cap-augmented.

export const BJT_MAPPING: DeviceMapping = {
  deviceType: "bjt",
  slotToNgspice: {
    VBE: 0,
    VBC: 1,
    GPI: 4,
    GMU: 5,
    GM: 6,
    GO: 7,
    IC: 2,
    IB: 3,
    GEQCB: 18,
    Q_BE: 8,
    Q_BC: 10,
    Q_CS: 12,
    CCAP_BE: 9,
    CCAP_BC: 11,
    CCAP_CS: 13,
    CEXBC_NOW: 17,
  },
  ngspiceToSlot: {
    0: "VBE",
    1: "VBC",
    2: "IC",
    3: "IB",
    4: "GPI",
    5: "GMU",
    6: "GM",
    7: "GO",
    8: "Q_BE",
    9: "CCAP_BE",
    10: "Q_BC",
    11: "CCAP_BC",
    12: "Q_CS",
    13: "CCAP_CS",
    // Offsets 14-20 have no direct slot in our schema; exposed under
    // ngspice-native names so raw values are still visible in ngspice-side
    // reports. No ours-side comparison is possible for these — the absence
    // of a comparable slot is a BLOCKER, not a mapping deficiency.
    14: "NG_QBX",
    15: "NG_CQBX",
    16: "NG_GX",
    17: "CEXBC_NOW",
    18: "GEQCB",
    19: "NG_GCCS",
    20: "NG_GEQBX",
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

export const MOSFET_MAPPING: DeviceMapping = {
  deviceType: "mosfet",
  slotToNgspice: {
    VGS: 2,
    VDS: 3,
    MEYER_GS: 4,
    Q_GS: 5,
    CCAP_GS: 6,
    MEYER_GD: 7,
    Q_GD: 8,
    CCAP_GD: 9,
    MEYER_GB: 10,
    Q_GB: 11,
    CCAP_GB: 12,
    Q_DB: 13,
    CCAP_DB: 14,
    Q_SB: 15,
    CCAP_SB: 16,
  },
  ngspiceToSlot: {
    0: "NG_VBD",
    1: "NG_VBS",
    2: "VGS",
    3: "VDS",
    4: "MEYER_GS",
    5: "Q_GS",
    6: "CCAP_GS",
    7: "MEYER_GD",
    8: "Q_GD",
    9: "CCAP_GD",
    10: "MEYER_GB",
    11: "Q_GB",
    12: "CCAP_GB",
    13: "Q_DB",
    14: "CCAP_DB",
    15: "Q_SB",
    16: "CCAP_SB",
  },
};

// ---------------------------------------------------------------------------
// JFET (N-channel / P-channel)
// ---------------------------------------------------------------------------
// ngspice jfet state offsets (jfetdefs.h):
//   JFETvgs=0, JFETvgd=1, JFETcg=2, JFETcd=3, JFETcgd=4,
//   JFETgm=5, JFETgds=6, JFETggs=7, JFETggd=8,
//   JFETqgs=9, JFETcqgs=10, JFETqgd=11, JFETcqgd=12

export const JFET_MAPPING: DeviceMapping = {
  deviceType: "jfet",
  slotToNgspice: {
    VGS: 0,
    GM: 5,
    GDS: 6,
    IDS: 3,
    Q_GS: 9,
    Q_GD: 11,
    CCAP_GS: 10,
    CCAP_GD: 12,
    GD_JUNCTION: 7,
    ID_JUNCTION: 2,
  },
  ngspiceToSlot: {
    0: "VGS",
    1: "NG_VGD",
    2: "ID_JUNCTION",
    3: "IDS",
    4: "NG_CGD",
    5: "GM",
    6: "GDS",
    7: "GD_JUNCTION",
    8: "NG_GGD",
    9: "Q_GS",
    10: "CCAP_GS",
    11: "Q_GD",
    12: "CCAP_GD",
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

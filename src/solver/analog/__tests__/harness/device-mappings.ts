/**
 * Device name correspondence between our state-pool slot names and
 * ngspice CKTstate0 offsets.
 *
 * This file contains ONLY direct-offset correspondences- i.e. the same
 * physical quantity (junction voltage, junction charge, etc.) recorded on
 * both sides under different names. If a slot does not have a direct
 * correspondence here, it is not comparable- that is a BLOCKER, to be
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

// Capacitor pin currents: CCAP at converged step-end is the displacement
// current (capload.c stamps it as the companion-current source). Passive
// sign convention- pos pin sees +CCAP into the device, neg pin sees -CCAP.
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
  pinCurrents: {
    pos: [{ slot: "CCAP", sign: 1 }],
    neg: [{ slot: "CCAP", sign: -1 }],
  },
};

// ---------------------------------------------------------------------------
// Inductor
// ---------------------------------------------------------------------------
// ngspice ind state offsets (inddefs.h:68-69):
//   INDflux = INDstate+0  - flux Φ = L·i (the qcap fed to NIintegrate)
//   INDvolt = INDstate+1  - NIintegrate companion current. Despite the
//                            "INDvolt" name, niinteg.c:15
//                            (`#define ccap qcap+1`) makes this slot the
//                            ccap recursion buffer, not a node voltage.
//
// digiTS schema (inductor.ts INDUCTOR_SCHEMA): PHI=0, CCAP=1- same offsets,
// same semantics, ngspice-exact 1:1.
//
// Inductor pin currents: NOT projectable from CKTstate. The actual
// through-current is the MNA branch variable for the inductor (captured
// in the `branches` channel). INDvolt at slot 1 is the niinteg companion
// for VOLTAGE (phi_dot), not current- mapping it to a pin would mislabel
// the quantity. `pinCurrents` is therefore omitted.

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
// with no ngspice CKTstate correspondence- not mapped.

// Diode pin currents: ID at slot 1 is the diode through-current (anode→cathode
// passive sign). Anode A sees +ID into the device, cathode K sees -ID.
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
  pinCurrents: {
    A: [{ slot: "ID", sign: 1 }],
    K: [{ slot: "ID", sign: -1 }],
  },
};

// ---------------------------------------------------------------------------
// BJT (SPICE L1- Gummel-Poon)
// ---------------------------------------------------------------------------
// ngspice BJT state offsets (bjtdefs.h:316-341, BJTnumStates=33):
//   BJTvbe=0, BJTvbc=1, BJTvbcx=2, BJTvrci=3, BJTcc=4, BJTcb=5,
//   BJTgpi=6, BJTgmu=7, BJTgm=8, BJTgo=9, BJTqbe=10, BJTcqbe=11,
//   BJTqbc=12, BJTcqbc=13, BJTqsub=14, BJTcqsub=15, BJTqbx=16,
//   BJTcqbx=17, BJTgx=18, BJTcexbc=19, BJTgeqcb=20, BJTgcsub=21,
//   BJTgeqbx=22, BJTvsub=23, BJTcdsub=24, BJTgdsub=25, then the
//   quasi-saturation slots BJTirci=26 .. BJTgbcx=32 (bjtdefs.h:342-348).
//
// BJTvbcx (2) and BJTvrci (3) are the quasi-saturation epitaxial-collector
// junction voltages; BJTirci..BJTgbcx (26-32) are the Kull epi-current, its
// three derivatives, and the base-collCX charge/cap/conductance. The digiTS L1
// Gummel-Poon schema carries all nine (BJT_L1_SCHEMA, bjt.ts), so they map to
// their ngspice offsets by name below. With rco unset (classic Gummel-Poon)
// both sides hold them at 0 (vbcx tracks vbc), so they compare cleanly on a
// classic-GP control; with rco given they exercise the epitaxial region.
// Every digiTS slot below maps to its ngspice offset by name.
//
// GPI/GMU/CC/CB (ngspice offsets 6,7,4,5) are cap-augmented during transient-
// bjtload.c lumps the cap companion geq/ieq into these slots on both sides, so
// the comparison is augmented-against-augmented.

// BJT pin currents: CC=BJTcc (collector terminal current, offset 4) and
// CB=BJTcb (base terminal current, offset 5) are the directly-stored
// terminal currents. Emitter is not in CKTstate- ngspice derives it by
// KCL: Ie = -(Ic + Ib). bjtdefs.h has no BJTce.
export const BJT_MAPPING: DeviceMapping = {
  deviceType: "bjt",
  slotToNgspice: {
    VBE: 0,
    VBC: 1,
    VBCX: 2,
    VRCI: 3,
    CC: 4,
    CB: 5,
    GPI: 6,
    GMU: 7,
    GM: 8,
    GO: 9,
    QBE: 10,
    CQBE: 11,
    QBC: 12,
    CQBC: 13,
    QSUB: 14,
    CQSUB: 15,
    QBX: 16,
    CQBX: 17,
    GX: 18,
    CEXBC: 19,
    GEQCB: 20,
    GCSUB: 21,
    GEQBX: 22,
    VSUB: 23,
    CDSUB: 24,
    GDSUB: 25,
    IRCI: 26,
    IRCI_VRCI: 27,
    IRCI_VBCI: 28,
    IRCI_VBCX: 29,
    QBCX: 30,
    CQBCX: 31,
    GBCX: 32,
  },
  pinCurrents: {
    C: [{ slot: "CC", sign: 1 }],
    B: [{ slot: "CB", sign: 1 }],
    E: [{ slot: "CC", sign: -1 }, { slot: "CB", sign: -1 }],
  },
  ngspiceToSlot: {
    0: "VBE",
    1: "VBC",
    2: "VBCX",
    3: "VRCI",
    4: "CC",
    5: "CB",
    6: "GPI",
    7: "GMU",
    8: "GM",
    9: "GO",
    10: "QBE",
    11: "CQBE",
    12: "QBC",
    13: "CQBC",
    14: "QSUB",
    15: "CQSUB",
    16: "QBX",
    17: "CQBX",
    18: "GX",
    19: "CEXBC",
    20: "GEQCB",
    21: "GCSUB",
    22: "GEQBX",
    23: "VSUB",
    24: "CDSUB",
    25: "GDSUB",
    26: "IRCI",
    27: "IRCI_VRCI",
    28: "IRCI_VBCI",
    29: "IRCI_VBCX",
    30: "QBCX",
    31: "CQBCX",
    32: "GBCX",
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
// CKTstate offsets- they are not comparable via the state-pool path.
//
// MOSFET pin currents: NOT projectable from CKTstate. CD/CBS/CBD live on
// MOS1instance and would require a parallel instance-field bridge through
// the harness. Until that work lands, `pinCurrents` is omitted; consumers
// see an empty record for MOSFET entries.

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

// JFET pin currents: CG=JFETcg (gate, slot 2) and CD=JFETcd (drain,
// slot 3) are directly stored. Source is derived by KCL: Is = -(Ig + Id).
// jfetdefs.h:154-166 has no JFETcs.
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
  pinCurrents: {
    G: [{ slot: "CG", sign: 1 }],
    D: [{ slot: "CD", sign: 1 }],
    S: [{ slot: "CG", sign: -1 }, { slot: "CD", sign: -1 }],
  },
};

// ---------------------------------------------------------------------------
// MES (GaAs MESFET, ngspice MES — Statz model). 13-state layout
// (mesdefs.h:150-162) name-for-name identical to JFET1; distinct device type.
// cg/cd are the gate/drain branch currents; source by KCL = -(cg+cd).
// ---------------------------------------------------------------------------
export const MES_MAPPING: DeviceMapping = {
  deviceType: "mes",
  slotToNgspice: {
    VGS: 0, VGD: 1, CG: 2, CD: 3, CGD: 4, GM: 5, GDS: 6,
    GGS: 7, GGD: 8, QGS: 9, CQGS: 10, QGD: 11, CQGD: 12,
  },
  ngspiceToSlot: {
    0: "VGS", 1: "VGD", 2: "CG", 3: "CD", 4: "CGD", 5: "GM", 6: "GDS",
    7: "GGS", 8: "GGD", 9: "QGS", 10: "CQGS", 11: "QGD", 12: "CQGD",
  },
  pinCurrents: {
    G: [{ slot: "CG", sign: 1 }],
    D: [{ slot: "CD", sign: 1 }],
    S: [{ slot: "CG", sign: -1 }, { slot: "CD", sign: -1 }],
  },
};

// ---------------------------------------------------------------------------
// JFET2 (Parker-Skellern, ngspice JFET2). 19-state layout (jfet2defs.h:164-182):
// states 0-12 match JFET1, plus the PS dynamic states qds/cqds/pave/vtrap/
// vgstrap (13-17). Slot 18 (JFET2unknown) is unused and omitted.
// ---------------------------------------------------------------------------
export const JFET2_MAPPING: DeviceMapping = {
  deviceType: "jfet2",
  slotToNgspice: {
    VGS: 0, VGD: 1, CG: 2, CD: 3, CGD: 4, GM: 5, GDS: 6,
    GGS: 7, GGD: 8, QGS: 9, CQGS: 10, QGD: 11, CQGD: 12,
    QDS: 13, CQDS: 14, PAVE: 15, VTRAP: 16, VGSTRAP: 17,
  },
  ngspiceToSlot: {
    0: "VGS", 1: "VGD", 2: "CG", 3: "CD", 4: "CGD", 5: "GM", 6: "GDS",
    7: "GGS", 8: "GGD", 9: "QGS", 10: "CQGS", 11: "QGD", 12: "CQGD",
    13: "QDS", 14: "CQDS", 15: "PAVE", 16: "VTRAP", 17: "VGSTRAP",
  },
  pinCurrents: {
    G: [{ slot: "CG", sign: 1 }],
    D: [{ slot: "CD", sign: 1 }],
    S: [{ slot: "CG", sign: -1 }, { slot: "CD", sign: -1 }],
  },
};

// ---------------------------------------------------------------------------
// VDMOS (LTspice-compatible vertical DMOS power MOSFET, ngspice VDMOS)
// ---------------------------------------------------------------------------
// ngspice vdmos state offsets (vdmosdefs.h:251-274, VDMOSnumStates=18):
//   VDMOSvgs=0, VDMOSvds=1, VDMOSdelTemp=2,
//   VDMOScapgs=3, VDMOSqgs=4, VDMOScqgs=5,
//   VDMOScapgd=6, VDMOSqgd=7, VDMOScqgd=8,
//   VDIOvoltage=9, VDIOcurrent=10, VDIOconduct=11,
//   VDIOcapCharge=12, VDIOcapCurrent=13,
//   VDMOScapth=14, VDMOSqth=15, VDMOScqth=16,
//   VDIOdIdio_dT=17
//
// digiTS schema (vdmos.ts VDMOS_SCHEMA): VGS=0, VDS=1, DELTEMP=2, CAPGS=3,
// QGS=4, CQGS=5, CAPGD=6, QGD=7, CQGD=8, VDIO_V=9, VDIO_I=10, VDIO_G=11,
// VDIO_QCAP=12, VDIO_CCAP=13, CAPTH=14, QTH=15, CQTH=16, VDIO_DIDT=17 —
// same offsets, ngspice-exact 1:1 index map.
//
// VDMOS pin currents: NOT projectable from CKTstate. Like MOSFET, the
// terminal currents live on the per-instance struct (VDMOSid etc.), not in
// CKTstate — the 18 state slots are gate-cap charges/currents, body-diode
// voltage/current/conductance, and self-heating thermal terms, none of which
// is a clean drain/gate/source terminal current. `pinCurrents` is omitted.
export const VDMOS_MAPPING: DeviceMapping = {
  deviceType: "vdmos",
  slotToNgspice: {
    VGS:       0,
    VDS:       1,
    DELTEMP:   2,
    CAPGS:     3,
    QGS:       4,
    CQGS:      5,
    CAPGD:     6,
    QGD:       7,
    CQGD:      8,
    VDIO_V:    9,
    VDIO_I:    10,
    VDIO_G:    11,
    VDIO_QCAP: 12,
    VDIO_CCAP: 13,
    CAPTH:     14,
    QTH:       15,
    CQTH:      16,
    VDIO_DIDT: 17,
  },
  ngspiceToSlot: {
    0:  "VGS",
    1:  "VDS",
    2:  "DELTEMP",
    3:  "CAPGS",
    4:  "QGS",
    5:  "CQGS",
    6:  "CAPGD",
    7:  "QGD",
    8:  "CQGD",
    9:  "VDIO_V",
    10: "VDIO_I",
    11: "VDIO_G",
    12: "VDIO_QCAP",
    13: "VDIO_CCAP",
    14: "CAPTH",
    15: "QTH",
    16: "CQTH",
    17: "VDIO_DIDT",
  },
};

// ---------------------------------------------------------------------------
// Voltage-controlled switch (ngspice SW / VSWITCH)
// ---------------------------------------------------------------------------
// ngspice sw state offsets (swdefs.h:56, swload.c:140-141):
//   SW_NUM_STATES=2
//   states[0]+0: current_state  (REALLY_OFF=0, REALLY_ON=1, HYST_OFF=2, HYST_ON=3)
//   states[0]+1: v_ctrl         (saved control voltage)
//
// digiTS schema (analog-switch.ts SW_SCHEMA): CURRENT_STATE=0, V_CTRL=1 — ngspice-exact 1:1.
//
// ngspice device name: "Switch" (swinit.c:13). Lowercased in _canonicalizeDeviceType: "switch".
// Used for both SwitchSPST (1 SW instance) and each sub-instance of SwitchSPDT (2 SW instances).
export const VSWITCH_MAPPING: DeviceMapping = {
  deviceType: "vswitch",
  slotToNgspice: {
    CURRENT_STATE: 0,
    V_CTRL:        1,
  },
  ngspiceToSlot: {
    0: "CURRENT_STATE",
    1: "V_CTRL",
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------


/** All device mappings keyed by device type. */
export const DEVICE_MAPPINGS: Record<string, DeviceMapping> = {
  capacitor: CAPACITOR_MAPPING,
  inductor: INDUCTOR_MAPPING,
  diode: DIODE_MAPPING,
  bjt: BJT_MAPPING,
  mosfet: MOSFET_MAPPING,
  jfet: JFET_MAPPING,
  jfet2: JFET2_MAPPING,
  mes: MES_MAPPING,
  vdmos: VDMOS_MAPPING,
  vswitch: VSWITCH_MAPPING,
};

// ---------------------------------------------------------------------------
// Type normalization
// ---------------------------------------------------------------------------

const TYPE_ID_TO_CANONICAL: Record<string, string> = {
  NpnBJT: "bjt",
  PnpBJT: "bjt",
  NMOS: "mosfet",
  PMOS: "mosfet",
  NMOS3: "mosfet",
  PMOS3: "mosfet",
  VDMOSN: "vdmos",
  VDMOSP: "vdmos",
  NJFET: "jfet",
  PJFET: "jfet",
  JFET2N: "jfet2",
  JFET2P: "jfet2",
  NMESFET: "mes",
  PMESFET: "mes",
  Diode: "diode",
  Zener: "diode",
  Varactor: "varactor",
  Capacitor: "capacitor",
  Inductor: "inductor",
  Resistor: "resistor",
  DcVoltageSource: "vsource",
  AcVoltageSource: "vsource",
  DcCurrentSource: "isource",
  AcCurrentSource: "isource",
  SCR: "scr",
  Triac: "triac",
  SwitchSPST: "vswitch",
  SwitchSPDT: "vswitch",
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

/**
 * Apply a `DeviceMapping.pinCurrents` projection to a slot value map,
 * producing the per-pin terminal currents for one element. Returns an
 * empty record when the mapping has no projection (MOSFET, inductor) or
 * any required slot is missing from `slots`.
 *
 * Used by both engines' element-state captures so both sides emit
 * identically labelled `ElementStateSnapshot.pinCurrents` from the same
 * underlying slot data.
 */
export function projectPinCurrents(
  mapping: DeviceMapping | undefined,
  slots: Record<string, number>,
): Record<string, number> {
  const proj = mapping?.pinCurrents;
  if (!proj) return {};
  const out: Record<string, number> = {};
  for (const [pin, terms] of Object.entries(proj)) {
    let sum = 0;
    let ok = true;
    for (const term of terms) {
      const v = slots[term.slot];
      if (v === undefined) { ok = false; break; }
      sum += term.sign * v;
    }
    if (ok) out[pin] = sum;
  }
  return out;
}

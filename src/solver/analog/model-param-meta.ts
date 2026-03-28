/**
 * Metadata registry for SPICE model parameters.
 * Used by the property panel to render labels, units, and tooltips
 * for each device type's parameters.
 */

export interface SpiceParamMeta {
  key: string;
  label: string;
  unit: string;
  description: string;
}

const DIODE_META: SpiceParamMeta[] = [
  { key: "IS",  label: "Saturation Current",                      unit: "A",       description: "Saturation current" },
  { key: "N",   label: "Emission Coefficient",                    unit: "",        description: "Emission coefficient" },
  { key: "RS",  label: "Ohmic Resistance",                        unit: "Ω",       description: "Ohmic resistance" },
  { key: "BV",  label: "Reverse Breakdown Voltage",               unit: "V",       description: "Reverse breakdown voltage (infinite = no breakdown)" },
  { key: "IBV", label: "Current at Reverse Breakdown",            unit: "A",       description: "Current at reverse breakdown" },
  { key: "CJO", label: "Zero-Bias Junction Capacitance",          unit: "F",       description: "Zero-bias junction capacitance" },
  { key: "VJ",  label: "Junction Potential",                      unit: "V",       description: "Junction potential" },
  { key: "M",   label: "Grading Coefficient",                     unit: "",        description: "Grading coefficient" },
  { key: "TT",  label: "Transit Time",                            unit: "s",       description: "Transit time" },
  { key: "EG",  label: "Activation Energy",                       unit: "eV",      description: "Activation energy (1.11 for silicon)" },
  { key: "XTI", label: "Saturation Current Temp Exponent",        unit: "",        description: "Saturation current temperature exponent" },
  { key: "KF",  label: "Flicker Noise Coefficient",               unit: "",        description: "Flicker noise coefficient" },
  { key: "AF",  label: "Flicker Noise Exponent",                  unit: "",        description: "Flicker noise exponent" },
  { key: "FC",  label: "Forward-Bias Capacitance Coefficient",    unit: "",        description: "Forward-bias depletion capacitance coefficient" },
];

const BJT_NPN_META: SpiceParamMeta[] = [
  { key: "IS",  label: "Transport Saturation Current",            unit: "A",       description: "Transport saturation current" },
  { key: "BF",  label: "Ideal Max Forward Beta",                  unit: "",        description: "Ideal maximum forward beta" },
  { key: "NF",  label: "Forward Emission Coefficient",            unit: "",        description: "Forward current emission coefficient" },
  { key: "BR",  label: "Ideal Max Reverse Beta",                  unit: "",        description: "Ideal maximum reverse beta" },
  { key: "NR",  label: "Reverse Emission Coefficient",            unit: "",        description: "Reverse current emission coefficient" },
  { key: "ISE", label: "B-E Leakage Saturation Current",          unit: "A",       description: "B-E leakage saturation current" },
  { key: "ISC", label: "B-C Leakage Saturation Current",          unit: "A",       description: "B-C leakage saturation current" },
  { key: "VAF", label: "Forward Early Voltage",                   unit: "V",       description: "Forward Early voltage (infinite = no Early effect)" },
  { key: "VAR", label: "Reverse Early Voltage",                   unit: "V",       description: "Reverse Early voltage" },
  { key: "IKF", label: "Forward Beta Roll-Off Corner",            unit: "A",       description: "Corner for forward beta high-current roll-off" },
  { key: "IKR", label: "Reverse Beta Roll-Off Corner",            unit: "A",       description: "Corner for reverse beta high-current roll-off" },
  { key: "RB",  label: "Base Resistance",                         unit: "Ω",       description: "Zero-bias base resistance" },
  { key: "RC",  label: "Collector Resistance",                    unit: "Ω",       description: "Collector resistance" },
  { key: "RE",  label: "Emitter Resistance",                      unit: "Ω",       description: "Emitter resistance" },
  { key: "CJE", label: "B-E Depletion Capacitance",               unit: "F",       description: "B-E zero-bias depletion capacitance" },
  { key: "VJE", label: "B-E Built-In Potential",                  unit: "V",       description: "B-E built-in potential" },
  { key: "MJE", label: "B-E Grading Coefficient",                 unit: "",        description: "B-E junction grading coefficient" },
  { key: "CJC", label: "B-C Depletion Capacitance",               unit: "F",       description: "B-C zero-bias depletion capacitance" },
  { key: "VJC", label: "B-C Built-In Potential",                  unit: "V",       description: "B-C built-in potential" },
  { key: "MJC", label: "B-C Grading Coefficient",                 unit: "",        description: "B-C junction grading coefficient" },
  { key: "TF",  label: "Forward Transit Time",                    unit: "s",       description: "Ideal forward transit time" },
  { key: "TR",  label: "Reverse Transit Time",                    unit: "s",       description: "Ideal reverse transit time" },
  { key: "EG",  label: "Bandgap Energy",                          unit: "eV",      description: "Bandgap energy" },
  { key: "XTI", label: "Saturation Current Temp Exponent",        unit: "",        description: "Saturation current temperature exponent" },
  { key: "XTB", label: "Beta Temp Exponent",                      unit: "",        description: "Forward and reverse beta temperature exponent" },
  { key: "KF",  label: "Flicker Noise Coefficient",               unit: "",        description: "Flicker noise coefficient" },
];

const BJT_PNP_META: SpiceParamMeta[] = [
  { key: "IS",  label: "Transport Saturation Current",            unit: "A",       description: "Transport saturation current" },
  { key: "BF",  label: "Ideal Max Forward Beta",                  unit: "",        description: "Ideal maximum forward beta" },
  { key: "NF",  label: "Forward Emission Coefficient",            unit: "",        description: "Forward current emission coefficient" },
  { key: "BR",  label: "Ideal Max Reverse Beta",                  unit: "",        description: "Ideal maximum reverse beta" },
  { key: "NR",  label: "Reverse Emission Coefficient",            unit: "",        description: "Reverse current emission coefficient" },
  { key: "ISE", label: "B-E Leakage Saturation Current",          unit: "A",       description: "B-E leakage saturation current" },
  { key: "ISC", label: "B-C Leakage Saturation Current",          unit: "A",       description: "B-C leakage saturation current" },
  { key: "VAF", label: "Forward Early Voltage",                   unit: "V",       description: "Forward Early voltage" },
  { key: "VAR", label: "Reverse Early Voltage",                   unit: "V",       description: "Reverse Early voltage" },
  { key: "IKF", label: "Forward Beta Roll-Off Corner",            unit: "A",       description: "Corner for forward beta high-current roll-off" },
  { key: "IKR", label: "Reverse Beta Roll-Off Corner",            unit: "A",       description: "Corner for reverse beta high-current roll-off" },
  { key: "RB",  label: "Base Resistance",                         unit: "Ω",       description: "Zero-bias base resistance" },
  { key: "RC",  label: "Collector Resistance",                    unit: "Ω",       description: "Collector resistance" },
  { key: "RE",  label: "Emitter Resistance",                      unit: "Ω",       description: "Emitter resistance" },
  { key: "CJE", label: "B-E Depletion Capacitance",               unit: "F",       description: "B-E zero-bias depletion capacitance" },
  { key: "VJE", label: "B-E Built-In Potential",                  unit: "V",       description: "B-E built-in potential" },
  { key: "MJE", label: "B-E Grading Coefficient",                 unit: "",        description: "B-E junction grading coefficient" },
  { key: "CJC", label: "B-C Depletion Capacitance",               unit: "F",       description: "B-C zero-bias depletion capacitance" },
  { key: "VJC", label: "B-C Built-In Potential",                  unit: "V",       description: "B-C built-in potential" },
  { key: "MJC", label: "B-C Grading Coefficient",                 unit: "",        description: "B-C junction grading coefficient" },
  { key: "TF",  label: "Forward Transit Time",                    unit: "s",       description: "Ideal forward transit time" },
  { key: "TR",  label: "Reverse Transit Time",                    unit: "s",       description: "Ideal reverse transit time" },
  { key: "EG",  label: "Bandgap Energy",                          unit: "eV",      description: "Bandgap energy" },
  { key: "XTI", label: "Saturation Current Temp Exponent",        unit: "",        description: "Saturation current temperature exponent" },
  { key: "XTB", label: "Beta Temp Exponent",                      unit: "",        description: "Forward and reverse beta temperature exponent" },
  { key: "KF",  label: "Flicker Noise Coefficient",               unit: "",        description: "Flicker noise coefficient" },
];

const MOSFET_NMOS_META: SpiceParamMeta[] = [
  { key: "VTO",   label: "Threshold Voltage",                       unit: "V",       description: "Zero-bias threshold voltage" },
  { key: "KP",    label: "Transconductance Parameter",              unit: "A/V²",    description: "Transconductance parameter" },
  { key: "LAMBDA",label: "Channel-Length Modulation",               unit: "1/V",     description: "Channel-length modulation parameter" },
  { key: "PHI",   label: "Surface Potential",                       unit: "V",       description: "Surface potential" },
  { key: "GAMMA", label: "Body-Effect Parameter",                   unit: "V^0.5",   description: "Body-effect parameter" },
  { key: "CBD",   label: "Bulk-Drain Capacitance",                  unit: "F",       description: "Zero-bias bulk-drain junction capacitance" },
  { key: "CBS",   label: "Bulk-Source Capacitance",                 unit: "F",       description: "Zero-bias bulk-source junction capacitance" },
  { key: "CGDO",  label: "Gate-Drain Overlap Capacitance",          unit: "F/m",     description: "Gate-drain overlap capacitance per channel width" },
  { key: "CGSO",  label: "Gate-Source Overlap Capacitance",         unit: "F/m",     description: "Gate-source overlap capacitance per channel width" },
  { key: "W",     label: "Channel Width",                           unit: "m",       description: "Channel width" },
  { key: "L",     label: "Channel Length",                          unit: "m",       description: "Channel length" },
  { key: "TOX",   label: "Gate Oxide Thickness",                    unit: "m",       description: "Gate oxide thickness" },
  { key: "RD",    label: "Drain Resistance",                        unit: "Ω",       description: "Drain ohmic resistance" },
  { key: "RS",    label: "Source Resistance",                       unit: "Ω",       description: "Source ohmic resistance" },
  { key: "RG",    label: "Gate Resistance",                         unit: "Ω",       description: "Gate ohmic resistance" },
  { key: "RB",    label: "Bulk Resistance",                         unit: "Ω",       description: "Bulk ohmic resistance" },
  { key: "IS",    label: "Bulk Junction Saturation Current",        unit: "A",       description: "Bulk junction saturation current" },
  { key: "JS",    label: "Bulk Junction Saturation Current Density",unit: "A/m²",    description: "Bulk junction saturation current density" },
  { key: "PB",    label: "Bulk Junction Potential",                 unit: "V",       description: "Bulk junction potential" },
  { key: "MJ",    label: "Bulk Junction Grading Coefficient",       unit: "",        description: "Bulk junction grading coefficient" },
  { key: "MJSW",  label: "Sidewall Grading Coefficient",            unit: "",        description: "Sidewall junction grading coefficient" },
  { key: "CGBO",  label: "Gate-Bulk Overlap Capacitance",           unit: "F/m",     description: "Gate-bulk overlap capacitance per channel length" },
  { key: "CJ",    label: "Bulk Junction Capacitance per Area",      unit: "F/m²",    description: "Zero-bias bulk junction capacitance per area" },
  { key: "CJSW",  label: "Sidewall Junction Capacitance per Perim", unit: "F/m",     description: "Zero-bias sidewall junction capacitance per perimeter" },
  { key: "NFS",   label: "Fast Surface State Density",              unit: "1/cm²·V", description: "Fast surface state density" },
];

const MOSFET_PMOS_META: SpiceParamMeta[] = [
  { key: "VTO",   label: "Threshold Voltage",                       unit: "V",       description: "Zero-bias threshold voltage (negative for PMOS)" },
  { key: "KP",    label: "Transconductance Parameter",              unit: "A/V²",    description: "Transconductance parameter (lower mobility for PMOS)" },
  { key: "LAMBDA",label: "Channel-Length Modulation",               unit: "1/V",     description: "Channel-length modulation parameter" },
  { key: "PHI",   label: "Surface Potential",                       unit: "V",       description: "Surface potential" },
  { key: "GAMMA", label: "Body-Effect Parameter",                   unit: "V^0.5",   description: "Body-effect parameter" },
  { key: "CBD",   label: "Bulk-Drain Capacitance",                  unit: "F",       description: "Zero-bias bulk-drain junction capacitance" },
  { key: "CBS",   label: "Bulk-Source Capacitance",                 unit: "F",       description: "Zero-bias bulk-source junction capacitance" },
  { key: "CGDO",  label: "Gate-Drain Overlap Capacitance",          unit: "F/m",     description: "Gate-drain overlap capacitance per channel width" },
  { key: "CGSO",  label: "Gate-Source Overlap Capacitance",         unit: "F/m",     description: "Gate-source overlap capacitance per channel width" },
  { key: "W",     label: "Channel Width",                           unit: "m",       description: "Channel width" },
  { key: "L",     label: "Channel Length",                          unit: "m",       description: "Channel length" },
  { key: "TOX",   label: "Gate Oxide Thickness",                    unit: "m",       description: "Gate oxide thickness" },
  { key: "RD",    label: "Drain Resistance",                        unit: "Ω",       description: "Drain ohmic resistance" },
  { key: "RS",    label: "Source Resistance",                       unit: "Ω",       description: "Source ohmic resistance" },
  { key: "RG",    label: "Gate Resistance",                         unit: "Ω",       description: "Gate ohmic resistance" },
  { key: "RB",    label: "Bulk Resistance",                         unit: "Ω",       description: "Bulk ohmic resistance" },
  { key: "IS",    label: "Bulk Junction Saturation Current",        unit: "A",       description: "Bulk junction saturation current" },
  { key: "JS",    label: "Bulk Junction Saturation Current Density",unit: "A/m²",    description: "Bulk junction saturation current density" },
  { key: "PB",    label: "Bulk Junction Potential",                 unit: "V",       description: "Bulk junction potential" },
  { key: "MJ",    label: "Bulk Junction Grading Coefficient",       unit: "",        description: "Bulk junction grading coefficient" },
  { key: "MJSW",  label: "Sidewall Grading Coefficient",            unit: "",        description: "Sidewall junction grading coefficient" },
  { key: "CGBO",  label: "Gate-Bulk Overlap Capacitance",           unit: "F/m",     description: "Gate-bulk overlap capacitance per channel length" },
  { key: "CJ",    label: "Bulk Junction Capacitance per Area",      unit: "F/m²",    description: "Zero-bias bulk junction capacitance per area" },
  { key: "CJSW",  label: "Sidewall Junction Capacitance per Perim", unit: "F/m",     description: "Zero-bias sidewall junction capacitance per perimeter" },
  { key: "NFS",   label: "Fast Surface State Density",              unit: "1/cm²·V", description: "Fast surface state density" },
];

const JFET_N_META: SpiceParamMeta[] = [
  { key: "VTO",    label: "Pinch-Off Voltage",                      unit: "V",       description: "Pinch-off voltage (negative for N-channel)" },
  { key: "BETA",   label: "Transconductance Parameter",             unit: "A/V²",    description: "Transconductance parameter" },
  { key: "LAMBDA", label: "Channel-Length Modulation",              unit: "1/V",     description: "Channel-length modulation parameter" },
  { key: "RD",     label: "Drain Resistance",                       unit: "Ω",       description: "Drain ohmic resistance" },
  { key: "RS",     label: "Source Resistance",                      unit: "Ω",       description: "Source ohmic resistance" },
  { key: "CGS",    label: "Gate-Source Capacitance",                unit: "F",       description: "Zero-bias gate-source junction capacitance" },
  { key: "CGD",    label: "Gate-Drain Capacitance",                 unit: "F",       description: "Zero-bias gate-drain junction capacitance" },
  { key: "PB",     label: "Gate Junction Potential",                unit: "V",       description: "Gate junction potential" },
  { key: "IS",     label: "Gate Junction Saturation Current",       unit: "A",       description: "Gate junction saturation current" },
  { key: "KF",     label: "Flicker Noise Coefficient",              unit: "",        description: "Flicker noise coefficient" },
  { key: "AF",     label: "Flicker Noise Exponent",                 unit: "",        description: "Flicker noise exponent" },
  { key: "FC",     label: "Forward-Bias Capacitance Coefficient",   unit: "",        description: "Forward-bias depletion capacitance coefficient" },
];

const JFET_P_META: SpiceParamMeta[] = [
  { key: "VTO",    label: "Pinch-Off Voltage",                      unit: "V",       description: "Pinch-off voltage (positive for P-channel)" },
  { key: "BETA",   label: "Transconductance Parameter",             unit: "A/V²",    description: "Transconductance parameter" },
  { key: "LAMBDA", label: "Channel-Length Modulation",              unit: "1/V",     description: "Channel-length modulation parameter" },
  { key: "RD",     label: "Drain Resistance",                       unit: "Ω",       description: "Drain ohmic resistance" },
  { key: "RS",     label: "Source Resistance",                      unit: "Ω",       description: "Source ohmic resistance" },
  { key: "CGS",    label: "Gate-Source Capacitance",                unit: "F",       description: "Zero-bias gate-source junction capacitance" },
  { key: "CGD",    label: "Gate-Drain Capacitance",                 unit: "F",       description: "Zero-bias gate-drain junction capacitance" },
  { key: "PB",     label: "Gate Junction Potential",                unit: "V",       description: "Gate junction potential" },
  { key: "IS",     label: "Gate Junction Saturation Current",       unit: "A",       description: "Gate junction saturation current" },
  { key: "KF",     label: "Flicker Noise Coefficient",              unit: "",        description: "Flicker noise coefficient" },
  { key: "AF",     label: "Flicker Noise Exponent",                 unit: "",        description: "Flicker noise exponent" },
  { key: "FC",     label: "Forward-Bias Capacitance Coefficient",   unit: "",        description: "Forward-bias depletion capacitance coefficient" },
];

const TUNNEL_DIODE_META: SpiceParamMeta[] = [
  { key: "IP", label: "Peak Tunnel Current",        unit: "A", description: "Peak tunnel current" },
  { key: "VP", label: "Peak Voltage",               unit: "V", description: "Peak voltage" },
  { key: "IV", label: "Valley Current",             unit: "A", description: "Valley current" },
  { key: "VV", label: "Valley Voltage",             unit: "V", description: "Valley voltage" },
  { key: "IS", label: "Thermal Saturation Current", unit: "A", description: "Thermal saturation current" },
  { key: "N",  label: "Emission Coefficient",       unit: "",  description: "Emission coefficient" },
];

const REGISTRY: Record<string, SpiceParamMeta[]> = {
  D:      DIODE_META,
  NPN:    BJT_NPN_META,
  PNP:    BJT_PNP_META,
  NMOS:   MOSFET_NMOS_META,
  PMOS:   MOSFET_PMOS_META,
  NJFET:  JFET_N_META,
  PJFET:  JFET_P_META,
  TUNNEL: TUNNEL_DIODE_META,
};

export function getParamMeta(deviceType: string): SpiceParamMeta[] {
  const entries = REGISTRY[deviceType];
  if (entries === undefined) return [];
  return entries.slice();
}

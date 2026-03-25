/**
 * Java Digital reference pin positions for each component type.
 *
 * Extracted from ref/Digital/src/main/java/.../shapes/*.java getPins().
 * Positions are LOCAL (before rotation/mirror/translate), in grid units (SIZE=1).
 *
 * Shared between shape-render-audit (default-props single-instance checks)
 * and shape-audit (fixture-based rotation/mirror coverage).
 */

export interface JavaPinRef {
  label: string;
  x: number;
  y: number;
}

/**
 * Count ports in a Splitter split definition string.
 * Handles "bits", "bits*count", and "from-to" notation.
 */
function countSplitPorts(definition: string): number {
  if (!definition || definition.length === 0) return 1;
  let count = 0;
  for (const token of definition
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)) {
    const starIdx = token.indexOf("*");
    if (starIdx >= 0) {
      count += parseInt(token.substring(starIdx + 1).trim(), 10) || 1;
    } else {
      count++;
    }
  }
  return count || 1;
}

/**
 * Compute Java GenericShape pin positions for gate-like components.
 *
 * Java GenericShape.createPins() formula (all values in grid units, SIZE=1):
 *   symmetric = (outputCount == 1)
 *   offs = symmetric ? floor(inputCount/2) : 0
 *   Input i: (dx, i + correct)
 *     correct = 1 if symmetric && even input count && i >= inputCount/2
 *     dx = -1 if input label is in inverterConfig, else 0
 *   Output i: (width + (invert?1:0), i + offs)
 */
function buildGenericShapePins(
  inputCount: number,
  outputCount: number,
  width: number,
  invert: boolean,
  invertedLabels: ReadonlySet<string>,
  inputLabels?: readonly string[],
): JavaPinRef[] {
  const symmetric = outputCount === 1;
  const even = inputCount > 0 && (inputCount & 1) === 0;
  const offs = symmetric ? Math.floor(inputCount / 2) : 0;

  const pins: JavaPinRef[] = [];

  for (let i = 0; i < inputCount; i++) {
    const correct = symmetric && even && i >= inputCount / 2 ? 1 : 0;
    const label = inputLabels?.[i] ?? `In_${i + 1}`;
    const dx = invertedLabels.has(label) ? -1 : 0;
    pins.push({ label, x: dx, y: i + correct });
  }

  const outX = invert ? width + 1 : width;
  for (let i = 0; i < outputCount; i++) {
    pins.push({ label: "out", x: outX, y: i + offs });
  }

  return pins;
}

/**
 * Returns the Java-reference local pin positions for a given element type
 * and its attributes. Returns null if the type is unknown (subcircuit, etc.).
 */
export function getJavaPinPositions(
  typeId: string,
  props: Record<string, unknown>,
): JavaPinRef[] | null {
  const inputCount = (props["inputCount"] as number) ?? 2;
  const flip = !!(props["flipSelPos"] ?? false);
  const wide = !!(props["wideShape"] ?? false);

  // Parse inverter config labels
  const invertedLabels = new Set<string>();
  const invCfg = props["_inverterLabels"] as string | undefined;
  if (invCfg && invCfg.length > 0) {
    for (const s of invCfg.split(",")) invertedLabels.add(s.trim());
  }

  switch (typeId) {
    // --- Simple I/O: single pin at origin ---
    case "Probe":
    case "Tunnel":
    case "Clock":
    case "Button":
    case "Const":
    case "Ground":
    case "VDD":
    case "PullUp":
    case "PullDown":
    case "Reset":
    case "Break":
    case "DipSwitch":
    case "LED":
    case "In":
    case "Out":
    case "NotConnected":
      return [{ label: "pin", x: 0, y: 0 }];

    // --- Driver (tri-state buffer) ---
    case "Driver":
    case "DriverInvSel": {
      const invertOut = !!(props["invertDriverOutput"] ?? false);
      return [
        { label: "in", x: -1, y: 0 },
        { label: "sel", x: 0, y: flip ? 1 : -1 },
        { label: "out", x: invertOut ? 2 : 1, y: 0 },
      ];
    }

    // --- Splitter ---
    case "Splitter": {
      const spreading = (props["spreading"] as number) ?? 1;
      const inputSplit = (props["input splitting"] as string) ?? "4,4";
      const outputSplit = (props["output splitting"] as string) ?? "8";
      const inCount = countSplitPorts(inputSplit);
      const outCount = countSplitPorts(outputSplit);
      const pins: JavaPinRef[] = [];
      for (let i = 0; i < inCount; i++) {
        pins.push({ label: `in_${i}`, x: 0, y: i * spreading });
      }
      for (let i = 0; i < outCount; i++) {
        pins.push({ label: `out_${i}`, x: 1, y: i * spreading });
      }
      return pins;
    }

    // --- Delay ---
    case "Delay":
      return [
        { label: "in", x: 0, y: 0 },
        { label: "out", x: 2, y: 0 },
      ];

    // --- BitSelector ---
    case "BitSel":
    case "BitSelector":
      return [
        { label: "in", x: 0, y: 0 },
        { label: "sel", x: 1, y: flip ? -1 : 1 },
        { label: "out", x: 2, y: 0 },
      ];

    // --- Multiplexer ---
    case "Multiplexer": {
      const selBits = (props["selectorBits"] as number) ?? 1;
      const muxInputCount = 1 << selBits;
      const pins: JavaPinRef[] = [];
      pins.push({ label: "sel", x: 1, y: flip ? 0 : muxInputCount });
      if (muxInputCount === 2) {
        pins.push({ label: "in_0", x: 0, y: 0 });
        pins.push({ label: "in_1", x: 0, y: 2 });
      } else {
        for (let i = 0; i < muxInputCount; i++) {
          pins.push({ label: `in_${i}`, x: 0, y: i });
        }
      }
      pins.push({
        label: "out",
        x: 2,
        y: Math.floor(muxInputCount / 2),
      });
      return pins;
    }

    // --- Demultiplexer ---
    case "Demultiplexer": {
      const selBits = (props["selectorBits"] as number) ?? 1;
      const outCount = 1 << selBits;
      const height = outCount;
      const pins: JavaPinRef[] = [];
      pins.push({ label: "sel", x: 1, y: flip ? 0 : height });
      if (outCount === 2) {
        pins.push({ label: "out_0", x: 2, y: 0 });
        pins.push({ label: "out_1", x: 2, y: 2 });
      } else {
        for (let i = 0; i < outCount; i++) {
          pins.push({ label: `out_${i}`, x: 2, y: i });
        }
      }
      pins.push({ label: "in", x: 0, y: Math.floor(outCount / 2) });
      return pins;
    }

    // --- Diodes ---
    case "Diode":
      // Analog diode: anode (A) on left, cathode (K) on right (horizontal)
      return [
        { label: "A", x: 0, y: 0 },
        { label: "K", x: 4, y: 0 },
      ];
    case "DiodeBackward":
      return [
        { label: "in", x: 0, y: 0 },
        { label: "out", x: 0, y: -1 },
      ];
    case "DiodeForeward":
    case "DiodeForward":
      return [
        { label: "in", x: 0, y: 0 },
        { label: "out", x: 0, y: 1 },
      ];

    // --- FETs ---
    case "NFET":
    case "FGNFET":
      return [
        { label: "Gate", x: 0, y: 2 },
        { label: "Drain", x: 1, y: 0 },
        { label: "Source", x: 1, y: 2 },
      ];
    case "PFET":
    case "FGPFET":
      return [
        { label: "G", x: 0, y: 0 },
        { label: "S", x: 1, y: 0 },
        { label: "D", x: 1, y: 2 },
      ];

    // --- TransGate ---
    case "TransGate":
      return [
        { label: "p1", x: 1, y: -1 },
        { label: "p2", x: 1, y: 1 },
        { label: "out1", x: 0, y: 0 },
        { label: "out2", x: 2, y: 0 },
      ];

    // --- Rotary encoder ---
    case "RotEncoder":
      return [
        { label: "A", x: 0, y: 0 },
        { label: "B", x: 0, y: 1 },
      ];

    // --- ButtonLED ---
    case "ButtonLED":
      return [
        { label: "out", x: 0, y: 0 },
        { label: "in", x: 0, y: 1 },
      ];

    // --- LightBulb ---
    case "LightBulb":
      return [
        { label: "A", x: 0, y: 0 },
        { label: "B", x: 0, y: 2 },
      ];

    // --- PolarityAwareLED ---
    case "PolarityAwareLED":
      return [
        { label: "A", x: 0, y: 0 },
        { label: "K", x: 0, y: 4 },
      ];

    // --- RGB LED ---
    case "RGBLED":
      return [
        { label: "R", x: 0, y: -1 },
        { label: "G", x: 0, y: 0 },
        { label: "B", x: 0, y: 1 },
      ];

    // --- Fuse ---
    case "Fuse":
      return [
        { label: "out1", x: 0, y: 0 },
        { label: "out2", x: 1, y: 0 },
      ];

    // --- Scope ---
    case "Scope":
      return [{ label: "clk", x: 0, y: 0 }];

    // --- GenericShape gates (non-inverted output) ---
    case "And":
    case "Or":
    case "XOr": {
      const n = inputCount;
      const w = (n === 1 && !wide ? 1 : 3) + (wide ? 1 : 0);
      return buildGenericShapePins(n, 1, w, false, invertedLabels);
    }

    // --- GenericShape gates (inverted output) ---
    case "NAnd":
    case "NOr":
    case "XNOr": {
      const n = inputCount;
      const w = (n === 1 && !wide ? 1 : 3) + (wide ? 1 : 0);
      return buildGenericShapePins(n, 1, w, true, invertedLabels);
    }

    // --- NOT ---
    case "Not": {
      const w = 1 + (wide ? 1 : 0);
      return buildGenericShapePins(1, 1, w, true, invertedLabels);
    }

    // --- Neg ---
    case "Neg":
      return buildGenericShapePins(1, 1, 3, false, invertedLabels);

    // --- Flip-flops ---
    case "D_FF":
      return buildGenericShapePins(2, 2, 3, false, invertedLabels, [
        "D",
        "C",
      ]);
    case "JK_FF":
      return buildGenericShapePins(3, 2, 3, false, invertedLabels, [
        "J",
        "C",
        "K",
      ]);
    case "RS_FF":
      return buildGenericShapePins(3, 2, 3, false, invertedLabels, [
        "S",
        "C",
        "R",
      ]);
    case "T_FF": {
      const withEnable = !!(props["withEnable"] ?? true);
      return buildGenericShapePins(
        withEnable ? 2 : 1,
        2,
        3,
        false,
        invertedLabels,
        withEnable ? ["T", "C"] : ["C"],
      );
    }
    case "D_FF_AS":
      return buildGenericShapePins(4, 2, 3, false, invertedLabels, [
        "Set",
        "D",
        "C",
        "Clr",
      ]);
    case "JK_FF_AS":
      return buildGenericShapePins(5, 2, 3, false, invertedLabels, [
        "Set",
        "J",
        "C",
        "K",
        "Clr",
      ]);
    case "RS_FF_AS":
      return buildGenericShapePins(2, 2, 3, false, invertedLabels, [
        "S",
        "R",
      ]);
    case "Monoflop":
      return buildGenericShapePins(2, 2, 3, false, invertedLabels, [
        "C",
        "~Q",
      ]);

    // --- Arithmetic ---
    case "Add":
    case "Sub":
      return buildGenericShapePins(3, 2, 3, false, invertedLabels, [
        "a",
        "b",
        "c_i",
      ]);
    case "Comparator":
      return buildGenericShapePins(2, 3, 3, false, invertedLabels, [
        "a",
        "b",
      ]);
    case "Mul":
      return buildGenericShapePins(2, 1, 3, false, invertedLabels, [
        "a",
        "b",
      ]);

    // --- Memory ---
    case "Register":
      return buildGenericShapePins(3, 1, 3, false, invertedLabels, [
        "D",
        "C",
        "en",
      ]);
    case "Counter":
      return buildGenericShapePins(3, 2, 3, false, invertedLabels, [
        "en",
        "C",
        "clr",
      ]);
    case "CounterPreset":
      return buildGenericShapePins(6, 2, 3, false, invertedLabels, [
        "en",
        "C",
        "dir",
        "in",
        "ld",
        "clr",
      ]);
    case "ROM":
      return buildGenericShapePins(2, 1, 3, false, invertedLabels, [
        "A",
        "sel",
      ]);
    case "RAMSinglePort":
      return buildGenericShapePins(4, 1, 3, false, invertedLabels, [
        "A",
        "str",
        "C",
        "ld",
      ]);
    case "RAMDualPort":
      return buildGenericShapePins(5, 1, 3, false, invertedLabels, [
        "A",
        "Din",
        "str",
        "C",
        "ld",
      ]);
    case "EEPROM":
      return buildGenericShapePins(5, 1, 3, false, invertedLabels, [
        "A",
        "CS",
        "WE",
        "OE",
        "D_in",
      ]);
    case "EEPROMDualPort":
      return buildGenericShapePins(5, 1, 3, false, invertedLabels, [
        "A",
        "Din",
        "str",
        "C",
        "ld",
      ]);

    // --- Wiring ---
    case "Decoder": {
      const selBits = (props["selectorBits"] as number) ?? 1;
      const outCount = 1 << selBits;
      const height = outCount;
      const pins: JavaPinRef[] = [];
      pins.push({ label: "sel", x: 1, y: flip ? 0 : height });
      if (outCount === 2) {
        pins.push({ label: "out_0", x: 2, y: 0 });
        pins.push({ label: "out_1", x: 2, y: 2 });
      } else {
        for (let i = 0; i < outCount; i++) {
          pins.push({ label: `out_${i}`, x: 2, y: i });
        }
      }
      return pins;
    }

    // --- Additional Arithmetic ---
    case "BarrelShifter":
      return buildGenericShapePins(2, 1, 3, false, invertedLabels, [
        "in",
        "shift",
      ]);
    case "BitCount":
      return buildGenericShapePins(1, 1, 3, false, invertedLabels, ["in"]);
    case "BitExtender":
      return buildGenericShapePins(1, 1, 3, false, invertedLabels, ["in"]);
    case "Div":
      return buildGenericShapePins(2, 2, 3, false, invertedLabels, [
        "a",
        "b",
      ]);
    case "PriorityEncoder": {
      const selBits = (props["selectorBits"] as number) ?? 1;
      const inCount = 1 << selBits;
      const inLabels: string[] = [];
      for (let i = 0; i < inCount; i++) inLabels.push(`in${i}`);
      return buildGenericShapePins(
        inCount,
        2,
        3.9,
        false,
        invertedLabels,
        inLabels,
      );
    }
    case "PRNG":
      return buildGenericShapePins(4, 1, 3, false, invertedLabels, [
        "S",
        "se",
        "ne",
        "C",
      ]);

    // --- Additional Memory ---
    case "BlockRAMDualPort":
      return buildGenericShapePins(4, 1, 3, false, invertedLabels, [
        "A",
        "Din",
        "str",
        "C",
      ]);
    case "RAMAsync":
      return buildGenericShapePins(3, 1, 3, false, invertedLabels, [
        "A",
        "D",
        "we",
      ]);
    case "RAMDualAccess":
      return buildGenericShapePins(6, 2, 3, false, invertedLabels, [
        "str",
        "C",
        "ld",
        "1A",
        "1Din",
        "2A",
      ]);
    case "RAMSinglePortSel":
      return buildGenericShapePins(4, 1, 3, false, invertedLabels, [
        "A",
        "CS",
        "WE",
        "OE",
      ]);
    case "ROMDualPort":
      return buildGenericShapePins(4, 2, 3, false, invertedLabels, [
        "A1",
        "s1",
        "A2",
        "s2",
      ]);
    case "RegisterFile":
      return buildGenericShapePins(6, 2, 4, false, invertedLabels, [
        "Din",
        "we",
        "Rw",
        "C",
        "Ra",
        "Rb",
      ]);
    case "LookUpTable": {
      const lutInputCount = (props["inputCount"] as number) ?? 2;
      const lutLabels: string[] = [];
      for (let i = 0; i < lutInputCount; i++) lutLabels.push(String(i));
      return buildGenericShapePins(
        lutInputCount,
        1,
        3,
        false,
        invertedLabels,
        lutLabels,
      );
    }

    // --- IO (GenericShape) ---
    case "Keyboard":
      return buildGenericShapePins(2, 2, 3, false, invertedLabels, [
        "C",
        "en",
      ]);
    case "Terminal":
      return buildGenericShapePins(3, 0, 3, false, invertedLabels, [
        "D",
        "C",
        "en",
      ]);
    case "GraphicCard":
      return buildGenericShapePins(5, 1, 3, false, invertedLabels, [
        "A",
        "str",
        "C",
        "ld",
        "B",
      ]);
    case "VGA":
      return buildGenericShapePins(6, 0, 3, false, invertedLabels, [
        "R",
        "G",
        "B",
        "H",
        "V",
        "C",
      ]);
    case "MIDI": {
      const progChange = !!(props["progChange"] ?? false);
      if (progChange) {
        return buildGenericShapePins(6, 0, 3, false, invertedLabels, [
          "N",
          "V",
          "OnOff",
          "PC",
          "en",
          "C",
        ]);
      } else {
        return buildGenericShapePins(5, 0, 3, false, invertedLabels, [
          "N",
          "V",
          "OnOff",
          "en",
          "C",
        ]);
      }
    }
    case "LedMatrix":
      return buildGenericShapePins(2, 0, 3, false, invertedLabels, [
        "r-data",
        "c-addr",
      ]);
    case "Stop":
      return buildGenericShapePins(1, 0, 3, false, invertedLabels, [
        "stop",
      ]);
    case "PowerSupply":
      return buildGenericShapePins(2, 0, 3, false, invertedLabels, [
        "VDD",
        "GND",
      ]);

    // --- Seven-segment displays ---
    case "Seven-Seg":
    case "SevenSeg": {
      const commonConn = !!(props["commonConnection"] ?? false);
      const pins: JavaPinRef[] = [
        { label: "a", x: 0, y: 0 },
        { label: "b", x: 1, y: 0 },
        { label: "c", x: 2, y: 0 },
        { label: "d", x: 3, y: 0 },
        { label: "e", x: 0, y: 7 },
        { label: "f", x: 1, y: 7 },
        { label: "g", x: 2, y: 7 },
        { label: "dp", x: 3, y: 7 },
      ];
      if (commonConn) {
        pins.push({ label: "cc", x: 4, y: 7 });
      }
      return pins;
    }
    case "Seven-Seg-Hex":
    case "SevenSegHex":
      return [
        { label: "d", x: 2, y: 7 },
        { label: "dp", x: 3, y: 7 },
      ];
    case "SixteenSeg":
      return [
        { label: "led", x: 2, y: 7 },
        { label: "dp", x: 3, y: 7 },
      ];

    // --- Stepper motors ---
    case "StepperMotorBipolar":
      return [
        { label: "A+", x: -2, y: -1 },
        { label: "A-", x: -2, y: 0 },
        { label: "B+", x: -2, y: 1 },
        { label: "B-", x: -2, y: 2 },
        { label: "S0", x: 3, y: -1 },
        { label: "S1", x: 3, y: 3 },
      ];
    case "StepperMotorUnipolar":
      return [
        { label: "P0", x: -2, y: -1 },
        { label: "P1", x: -2, y: 0 },
        { label: "P2", x: -2, y: 1 },
        { label: "P3", x: -2, y: 2 },
        { label: "com", x: -2, y: 3 },
        { label: "S0", x: 3, y: -1 },
        { label: "S1", x: 3, y: 3 },
      ];

    // --- ScopeTrigger ---
    case "ScopeTrigger":
      return [{ label: "T", x: 0, y: 0 }];

    // --- BusSplitter ---
    case "BusSplitter": {
      const busBits = (props["bitWidth"] as number) ?? (props["bits"] as number) ?? 1;
      const busSpreading = (props["spreading"] as number) ?? 1;
      const pins: JavaPinRef[] = [];
      pins.push({ label: "D", x: 0, y: 0 });
      pins.push({ label: "OE", x: 0, y: 1 });
      for (let i = 0; i < busBits; i++) {
        pins.push({ label: `D${i}`, x: 1, y: i * busSpreading });
      }
      return pins;
    }

    // --- Switches ---
    case "Switch":
    case "PlainSwitch": {
      const switchPoles = (props["poles"] as number) ?? 1;
      const pins: JavaPinRef[] = [];
      for (let p = 0; p < switchPoles; p++) {
        pins.push({ label: `A${p + 1}`, x: 0, y: 2 * p });
        pins.push({ label: `B${p + 1}`, x: 2, y: 2 * p });
      }
      return pins;
    }
    case "SwitchDT":
    case "PlainSwitchDT": {
      const dtPoles = (props["poles"] as number) ?? 1;
      const pins: JavaPinRef[] = [];
      for (let p = 0; p < dtPoles; p++) {
        pins.push({ label: `A${p + 1}`, x: 0, y: 2 * p });
        pins.push({ label: `B${p + 1}`, x: 2, y: 2 * p });
        pins.push({ label: `C${p + 1}`, x: 2, y: 1 + 2 * p });
      }
      return pins;
    }

    // --- Relays ---
    case "Relay": {
      const relayPoles = (props["poles"] as number) ?? 1;
      const pins: JavaPinRef[] = [];
      pins.push({ label: "in1", x: 0, y: -2 });
      pins.push({ label: "in2", x: 2, y: -2 });
      for (let p = 0; p < relayPoles; p++) {
        pins.push({ label: `A${p + 1}`, x: 0, y: 2 * p });
        pins.push({ label: `B${p + 1}`, x: 2, y: 2 * p });
      }
      return pins;
    }
    case "RelayDT": {
      const relayDTPoles = (props["poles"] as number) ?? 1;
      const pins: JavaPinRef[] = [];
      pins.push({ label: "in1", x: 0, y: -2 });
      pins.push({ label: "in2", x: 2, y: -2 });
      for (let p = 0; p < relayDTPoles; p++) {
        pins.push({ label: `A${p + 1}`, x: 0, y: 2 * p });
        pins.push({ label: `B${p + 1}`, x: 2, y: 2 * p });
        pins.push({ label: `C${p + 1}`, x: 2, y: 1 + 2 * p });
      }
      return pins;
    }

    // --- No pins ---
    case "AsyncSeq":
      return null;

    // --- Function (FanIn) ---
    case "Function": {
      const n = inputCount;
      const w = (n === 1 && !wide ? 1 : 3) + (wide ? 1 : 0);
      return buildGenericShapePins(n, 1, w, false, invertedLabels);
    }

    // --- TS-only / non-circuit ---
    case "ProgramCounter":
    case "ProgramMemory":
    case "Testcase":
    case "Rectangle":
    case "GenericInitCode":
    case "Text":
      return null;

    default:
      return null;
  }
}

/**
 * Pin transform: mirror (negate Y in local space) -> rotate -> translate.
 * Matches Java Digital's transform chain.
 */
export function javaWorldPosition(
  localX: number,
  localY: number,
  posX: number,
  posY: number,
  rotation: number,
  mirror: boolean,
): { x: number; y: number } {
  const mats: Record<number, { cos: number; sin: number }> = {
    0: { cos: 1, sin: 0 },
    1: { cos: 0, sin: 1 },
    2: { cos: -1, sin: 0 },
    3: { cos: 0, sin: -1 },
  };
  const { cos, sin } = mats[rotation] ?? mats[0];

  const my = mirror ? -localY : localY;

  return {
    x: localX * cos + my * sin + posX,
    y: -localX * sin + my * cos + posY,
  };
}

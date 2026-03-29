import os, re

root = "C:/local_working_projects/digital_in_browser"

files = [
  "src/app/subcircuit-dialog.ts",
  "src/compile/__tests__/compile-integration.test.ts",
  "src/compile/__tests__/compile.test.ts",
  "src/compile/__tests__/extract-connectivity.test.ts",
  "src/compile/__tests__/pin-loading-menu.test.ts",
  "src/compile/__tests__/pin-loading-overrides.test.ts",
  "src/compile/__tests__/stable-net-id.test.ts",
  "src/components/active/adc.ts",
  "src/components/active/analog-switch.ts",
  "src/components/active/cccs.ts",
  "src/components/active/ccvs.ts",
  "src/components/active/comparator.ts",
  "src/components/active/opamp.ts",
  "src/components/active/optocoupler.ts",
  "src/components/active/ota.ts",
  "src/components/active/real-opamp.ts",
  "src/components/active/schmitt-trigger.ts",
  "src/components/active/timer-555.ts",
  "src/components/active/vccs.ts",
  "src/components/active/vcvs.ts",
  "src/components/arithmetic/add.ts",
  "src/components/arithmetic/barrel-shifter.ts",
  "src/components/arithmetic/bit-count.ts",
  "src/components/arithmetic/bit-extender.ts",
  "src/components/arithmetic/comparator.ts",
  "src/components/arithmetic/div.ts",
  "src/components/arithmetic/mul.ts",
  "src/components/arithmetic/prng.ts",
  "src/components/arithmetic/sub.ts",
  "src/components/flipflops/d-async.ts",
  "src/components/flipflops/d.ts",
  "src/components/flipflops/jk-async.ts",
  "src/components/flipflops/jk.ts",
  "src/components/flipflops/monoflop.ts",
  "src/components/flipflops/rs-async.ts",
  "src/components/flipflops/rs.ts",
  "src/components/flipflops/t.ts",
  "src/components/graphics/graphic-card.ts",
  "src/components/graphics/led-matrix.ts",
  "src/components/graphics/vga.ts",
  "src/components/io/button-led.ts",
  "src/components/io/button.ts",
  "src/components/io/clock.ts",
  "src/components/io/const.ts",
  "src/components/io/dip-switch.ts",
  "src/components/io/ground.ts",
  "src/components/io/in.ts",
  "src/components/io/led.ts",
  "src/components/io/light-bulb.ts",
  "src/components/io/not-connected.ts",
  "src/components/io/out.ts",
  "src/components/io/polarity-led.ts",
  "src/components/io/port.ts",
  "src/components/io/power-supply.ts",
  "src/components/io/probe.ts",
  "src/components/io/rgb-led.ts",
  "src/components/io/rotary-encoder.ts",
  "src/components/io/scope-trigger.ts",
  "src/components/io/seven-seg-hex.ts",
  "src/components/io/sixteen-seg.ts",
  "src/components/io/stepper-motor.ts",
  "src/components/io/vdd.ts",
  "src/components/memory/counter-preset.ts",
  "src/components/memory/counter.ts",
  "src/components/memory/eeprom.ts",
  "src/components/memory/program-counter.ts",
  "src/components/memory/program-memory.ts",
  "src/components/memory/ram.ts",
  "src/components/memory/register-file.ts",
  "src/components/memory/register.ts",
  "src/components/memory/rom.ts",
  "src/components/passives/capacitor.ts",
  "src/components/passives/crystal.ts",
  "src/components/passives/inductor.ts",
  "src/components/passives/memristor.ts",
  "src/components/passives/polarized-cap.ts",
  "src/components/passives/potentiometer.ts",
  "src/components/passives/resistor.ts",
  "src/components/passives/tapped-transformer.ts",
  "src/components/passives/transformer.ts",
  "src/components/passives/transmission-line.ts",
  "src/components/pld/diode.ts",
  "src/components/pld/pull-down.ts",
  "src/components/pld/pull-up.ts",
  "src/components/semiconductors/bjt.ts",
  "src/components/semiconductors/diac.ts",
  "src/components/semiconductors/diode.ts",
  "src/components/semiconductors/mosfet.ts",
  "src/components/semiconductors/njfet.ts",
  "src/components/semiconductors/pjfet.ts",
  "src/components/semiconductors/schottky.ts",
  "src/components/semiconductors/scr.ts",
  "src/components/semiconductors/triac.ts",
  "src/components/semiconductors/triode.ts",
  "src/components/semiconductors/tunnel-diode.ts",
  "src/components/semiconductors/varactor.ts",
  "src/components/semiconductors/zener.ts",
  "src/components/sensors/ldr.ts",
  "src/components/sensors/ntc-thermistor.ts",
  "src/components/sensors/spark-gap.ts",
  "src/components/sources/ac-voltage-source.ts",
  "src/components/sources/current-source.ts",
  "src/components/sources/dc-voltage-source.ts",
  "src/components/sources/variable-rail.ts",
  "src/components/switching/fgnfet.ts",
  "src/components/switching/fgpfet.ts",
  "src/components/switching/fuse.ts",
  "src/components/switching/nfet.ts",
  "src/components/switching/pfet.ts",
  "src/components/switching/trans-gate.ts",
  "src/components/terminal/keyboard.ts",
  "src/components/terminal/terminal.ts",
  "src/components/wiring/bit-selector.ts",
  "src/components/wiring/break.ts",
  "src/components/wiring/bus-splitter.ts",
  "src/components/wiring/delay.ts",
  "src/components/wiring/driver-inv.ts",
  "src/components/wiring/driver.ts",
  "src/components/wiring/mux.ts",
  "src/components/wiring/priority-encoder.ts",
  "src/components/wiring/reset.ts",
  "src/components/wiring/stop.ts",
  "src/components/wiring/tunnel.ts",
  "src/core/__tests__/pin.test.ts",
  "src/core/pin.ts",
  "src/io/__tests__/save-load-pin-loading-compile.test.ts",
  "src/solver/analog/__tests__/analog-compiler.test.ts",
  "src/solver/analog/__tests__/compiler.test.ts",
  "src/solver/analog/__tests__/digital-bridge-path.test.ts",
  "src/solver/analog/__tests__/digital-pin-loading.test.ts",
  "src/solver/analog/transistor-models/darlington.ts",
  "src/solver/digital/__tests__/bus-resolution.test.ts",
  "src/solver/digital/__tests__/compiler.test.ts",
  "src/solver/digital/__tests__/state-slots.test.ts",
  "src/solver/digital/__tests__/switch-network.test.ts",
  "src/solver/digital/__tests__/two-phase.test.ts",
  "src/solver/digital/__tests__/wiring-table.test.ts",
]

total_changes = 0
files_changed = 0
clock_re = re.compile(r"^(\s*)isClockCapable:\s*(false|true),\s*$")

for f in files:
    full = os.path.join(root, f)
    if not os.path.exists(full):
        print("SKIP:", f)
        continue
    with open(full, "r", encoding="utf-8") as fh:
        content = fh.read()
    lines = content.split("\n")
    new_lines = []
    changes = 0
    i = 0
    while i < len(lines):
        new_lines.append(lines[i])
        m = clock_re.match(lines[i])
        if m:
            indent = m.group(1)
            j = i + 1
            while j < len(lines) and lines[j].strip() == "":
                j += 1
            if j < len(lines):
                next_stripped = lines[j].strip()
                if not next_stripped.startswith("kind:"):
                    new_lines.append(indent + "kind: \"signal\",")
                    changes += 1
            else:
                new_lines.append(indent + "kind: \"signal\",")
                changes += 1
        i += 1
    if changes > 0:
        with open(full, "w", encoding="utf-8") as fh:
            fh.write("\n".join(new_lines))
        print("FIXED (%d pins): %s" % (changes, f))
        total_changes += changes
        files_changed += 1

print("Total: %d additions across %d files" % (total_changes, files_changed))

import os, re

root = "C:/local_working_projects/digital_in_browser"

files = [
  "src/compile/__tests__/compile-integration.test.ts",
  "src/compile/__tests__/compile.test.ts",
  "src/compile/__tests__/pin-loading-menu.test.ts",
  "src/compile/__tests__/pin-loading-overrides.test.ts",
  "src/components/arithmetic/barrel-shifter.ts",
  "src/components/arithmetic/bit-count.ts",
  "src/components/arithmetic/bit-extender.ts",
  "src/components/arithmetic/comparator.ts",
  "src/components/arithmetic/prng.ts",
  "src/components/io/stepper-motor.ts",
  "src/components/memory/eeprom.ts",
  "src/components/memory/ram.ts",
  "src/components/memory/rom.ts",
  "src/solver/analog/__tests__/analog-compiler.test.ts",
  "src/solver/analog/__tests__/compiler.test.ts",
  "src/solver/analog/__tests__/digital-bridge-path.test.ts",
  "src/solver/analog/__tests__/digital-pin-loading.test.ts",
  "src/solver/digital/__tests__/bus-resolution.test.ts",
  "src/solver/digital/__tests__/compiler.test.ts",
  "src/solver/digital/__tests__/state-slots.test.ts",
  "src/solver/digital/__tests__/switch-network.test.ts",
  "src/solver/digital/__tests__/two-phase.test.ts",
  "src/solver/digital/__tests__/wiring-table.test.ts",
]

total_changes = 0
files_changed = 0

# Pattern: inline object ending with isClockCapable: (false|true) }
# e.g. { direction: ..., isClockCapable: false }
# or { direction: ..., isClockCapable: false },
# Need to insert kind: "signal" before the closing }
inline_re = re.compile(r"isClockCapable:\s*(false|true)\s*(\})")

def add_kind_inline(m):
    return "isClockCapable: " + m.group(1) + ", kind: \"signal\" " + m.group(2)

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
    for line in lines:
        # Check for inline pattern (all on one line, no kind: already)
        if "isClockCapable:" in line and "kind:" not in line:
            new_line, n = inline_re.subn(add_kind_inline, line)
            if n > 0:
                new_lines.append(new_line)
                changes += n
                continue
        new_lines.append(line)
    if changes > 0:
        with open(full, "w", encoding="utf-8") as fh:
            fh.write("\n".join(new_lines))
        print("FIXED (%d pins): %s" % (changes, f))
        total_changes += changes
        files_changed += 1

print("Total: %d additions across %d files" % (total_changes, files_changed))

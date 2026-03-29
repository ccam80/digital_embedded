import os, re

root = "C:/local_working_projects/digital_in_browser"

files = [
  "src/analysis/__tests__/cycle-detector.test.ts",
  "src/analysis/__tests__/model-analyser.test.ts",
  "src/analysis/__tests__/path-analysis.test.ts",
  "src/analysis/__tests__/statistics.test.ts",
  "src/analysis/__tests__/synthesis.test.ts",
  "src/compile/__tests__/compile-integration.test.ts",
  "src/compile/__tests__/coordinator.test.ts",
  "src/compile/__tests__/pin-loading-menu.test.ts",
  "src/core/__tests__/circuit.test.ts",
  "src/core/__tests__/element.test.ts",
  "src/editor/__tests__/element-help.test.ts",
  "src/editor/__tests__/element-renderer.test.ts",
  "src/editor/__tests__/hit-test.test.ts",
  "src/editor/__tests__/insert-subcircuit.test.ts",
  "src/fsm/__tests__/circuit-gen.test.ts",
  "src/headless/__tests__/builder.test.ts",
  "src/headless/__tests__/test-runner.test.ts",
  "src/solver/__tests__/coordinator-capability.test.ts",
  "src/solver/__tests__/coordinator-clock.test.ts",
  "src/solver/__tests__/coordinator-current-resolver.test.ts",
  "src/solver/__tests__/coordinator-speed-control.test.ts",
  "src/solver/analog/__tests__/analog-compiler.test.ts",
  "src/solver/analog/__tests__/bridge-compiler.test.ts",
  "src/solver/analog/__tests__/bridge-diagnostics.test.ts",
  "src/solver/analog/__tests__/compile-analog-partition.test.ts",
  "src/solver/analog/__tests__/digital-bridge-path.test.ts",
  "src/solver/analog/__tests__/digital-pin-loading.test.ts",
  "src/solver/digital/__tests__/flatten-bridge.test.ts",
  "src/solver/digital/__tests__/flatten-pipeline-reorder.test.ts",
  "src/solver/digital/__tests__/flatten-port.test.ts",
  "src/solver/digital/__tests__/flatten.test.ts",
]

total_changes = 0
files_changed = 0

# Inline pattern: isClock: (false|true) } -- add kind: "signal" before closing brace
inline_re = re.compile(r"isClock:\s*(false|true)\s*(\})")

# Multi-line pattern: isClock: false/true, at end of line with no kind: after
clock_re = re.compile(r"^(\s*)isClock:\s*(false|true),\s*$")

def add_kind_inline(m):
    return "isClock: " + m.group(1) + ", kind: \"signal\" " + m.group(2)

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
        line = lines[i]
        # Check for inline isClock pattern
        if "isClock:" in line and "kind:" not in line:
            new_line, n = inline_re.subn(add_kind_inline, line)
            if n > 0:
                new_lines.append(new_line)
                changes += n
                i += 1
                continue
        # Check for multi-line isClock pattern
        m = clock_re.match(line)
        if m:
            indent = m.group(1)
            new_lines.append(line)
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
            continue
        new_lines.append(line)
        i += 1
    if changes > 0:
        with open(full, "w", encoding="utf-8") as fh:
            fh.write("\n".join(new_lines))
        print("FIXED (%d): %s" % (changes, f))
        total_changes += changes
        files_changed += 1

print("Total: %d additions across %d files" % (total_changes, files_changed))

import os, re

root = "C:/local_working_projects/digital_in_browser"

files = [
  "src/compile/__tests__/partition.test.ts",
  "src/compile/__tests__/stable-net-id.test.ts",
  "src/solver/analog/__tests__/compile-analog-partition.test.ts",
]

total_changes = 0
files_changed = 0

# Inline pattern: domain: "..." } -- add kind: "signal" before closing brace
# These are ResolvedGroupPin objects that end with domain: "..."
inline_re = re.compile(r"(domain:\s*[\"]w+["])\s*(\})")

def add_kind_after_domain(m):
    s = m.group(1)
    b = m.group(2)
    return s + ", kind: \"signal\" " + b

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
        # Check for inline domain pattern (no kind: already)
        if "domain:" in line and "kind:" not in line:
            new_line, n = inline_re.subn(add_kind_after_domain, line)
            if n > 0:
                new_lines.append(new_line)
                changes += n
                i += 1
                continue
        # Multi-line: domain: "..." at end of line
        m = re.match(r"^(\s*)domain:\s*[\"]w+["],\s*$", line)
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

#!/usr/bin/env bash
# Verification tests for Phase 0: Dead Code Removal
# Each test function exits 0 on pass, 1 on fail.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PASS=0
FAIL=0

run_test() {
    local name="$1"
    local func="$2"
    if "$func"; then
        echo "PASS: ${name}"
        PASS=$((PASS + 1))
    else
        echo "FAIL: ${name}"
        FAIL=$((FAIL + 1))
    fi
}

deleted_files_gone() {
    local paths=(
        "Digital.jar"
        "digital.html"
        "bridge.html"
        "test-bridge.html"
        "xstream-shim.jar"
        "xstream-patch"
        "jdk-shim"
        "stack-question-template.txt"
        "PLANNING.md"
        "tutorial.html"
        "tutorial.json"
    )
    local failed=0
    for p in "${paths[@]}"; do
        if [ -e "${ROOT}/${p}" ]; then
            echo "  EXISTS (should be deleted): ${p}"
            failed=1
        fi
    done
    return $failed
}

no_cheerpj_references() {
    local strings=(
        "CheerpJ"
        "cheerpj"
        "cheerpOSAddStringFile"
        "cheerpjInit"
        "cheerpjRunMain"
        "cheerpjRunLibrary"
        "cheerpjCreateDisplay"
        "Digital.jar"
        "xstream-shim"
        "Launcher.java"
        "JVM.java"
        "jdk-shim"
    )
    local failed=0
    for s in "${strings[@]}"; do
        local matches
        matches=$(grep -r --include="*" -l "${s}" "${ROOT}" \
            --exclude-dir=".git" \
            --exclude-dir="spec" \
            --exclude-dir="ref" \
            2>/dev/null)
        if [ -n "$matches" ]; then
            echo "  Found '${s}' in:"
            echo "$matches" | sed 's/^/    /'
            failed=1
        fi
    done
    return $failed
}

kept_files_exist() {
    local paths=(
        "circuits/and-gate.dig"
        "circuits/half-adder.dig"
        "circuits/sr-latch.dig"
        "CLAUDE.md"
        "spec/plan.md"
        "spec/progress.md"
    )
    local failed=0
    for p in "${paths[@]}"; do
        if [ ! -e "${ROOT}/${p}" ]; then
            echo "  MISSING (should exist): ${p}"
            failed=1
        fi
    done
    return $failed
}

claude_md_no_stale_refs() {
    local strings=(
        "CheerpJ"
        "Digital.jar"
        "bridge.html"
        "digital.html"
        "xstream"
        "Launcher"
        "jdk-shim"
    )
    local failed=0
    for s in "${strings[@]}"; do
        if grep -q "${s}" "${ROOT}/CLAUDE.md" 2>/dev/null; then
            echo "  Found stale reference '${s}' in CLAUDE.md"
            failed=1
        fi
    done
    return $failed
}

claude_md_has_required_sections() {
    local strings=(
        "spec/plan.md"
        "postMessage"
        "hneemann/Digital"
        "python3 -m http.server"
    )
    local failed=0
    for s in "${strings[@]}"; do
        if ! grep -q "${s}" "${ROOT}/CLAUDE.md" 2>/dev/null; then
            echo "  Missing required content '${s}' in CLAUDE.md"
            failed=1
        fi
    done
    return $failed
}

run_test "deleted_files_gone" deleted_files_gone
run_test "no_cheerpj_references" no_cheerpj_references
run_test "kept_files_exist" kept_files_exist
run_test "claude_md_no_stale_refs" claude_md_no_stale_refs
run_test "claude_md_has_required_sections" claude_md_has_required_sections

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[ $FAIL -eq 0 ]

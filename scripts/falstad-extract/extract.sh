#!/bin/bash
# Build and run the Falstad/CircuitJS1 shape extractor.
# Compiles CircuitJS1 component sources with mock replacements,
# then runs ShapeExtractor to dump shapes + pin positions to JSON.
#
# Usage: bash scripts/falstad-extract/extract.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CJS_SRC="$PROJECT_DIR/ref/circuitjs1/src/com/lushprojects/circuitjs1/client"
BUILD_DIR="$SCRIPT_DIR/build"
OUTPUT="$PROJECT_DIR/fixtures/falstad-shapes.json"
PKG_DIR="$BUILD_DIR/src/com/lushprojects/circuitjs1/client"

echo "=== Falstad Shape Extractor ==="
echo "Output: $OUTPUT"

# Clean
rm -rf "$BUILD_DIR"
mkdir -p "$PKG_DIR"
mkdir -p "$BUILD_DIR/classes"

# --- Step 1: Copy ALL CircuitJS1 source files ---
echo "Copying CircuitJS1 sources..."
cp "$CJS_SRC/"*.java "$PKG_DIR/"

# --- Step 2: Remove files we can't/don't need to compile ---
# UI-heavy files with native methods or heavy GWT deps that aren't needed
for skip in circuitjs1.java CirSim.java Graphics.java \
            EditDialog.java EditInfo.java EditOptions.java \
            EditCompositeModelDialog.java EditDiodeModelDialog.java EditTransistorModelDialog.java \
            CheckboxMenuItem.java CheckboxAlignedMenuItem.java Checkbox.java Choice.java \
            Adjustable.java Scrollbar.java \
            AboutBox.java LoadFile.java \
            ExportAsImageDialog.java ExportAsLocalFileDialog.java \
            ExportAsTextDialog.java ExportAsUrlDialog.java \
            ImportFromDropbox.java ImportFromDropboxDialog.java ImportFromTextDialog.java \
            ScopePopupMenu.java ScopePropertiesDialog.java ScrollValuePopup.java \
            Scope.java ScopeElm.java \
            MyCommand.java QueryParameters.java; do
    rm -f "$PKG_DIR/$skip"
done

# --- Step 3: Generate GWT stubs ---
echo "Generating GWT stubs..."
bash "$SCRIPT_DIR/generate-gwt-stubs.sh" "$BUILD_DIR/src"

# Also keep our hand-written stubs (they have better Context2d/CanvasGradient/NumberFormat)
mkdir -p "$BUILD_DIR/src/com/google/gwt/canvas/dom/client"
mkdir -p "$BUILD_DIR/src/com/google/gwt/i18n/client"
cp "$SCRIPT_DIR/gwt-stubs/com/google/gwt/canvas/dom/client/"*.java \
   "$BUILD_DIR/src/com/google/gwt/canvas/dom/client/"
cp "$SCRIPT_DIR/gwt-stubs/com/google/gwt/i18n/client/"*.java \
   "$BUILD_DIR/src/com/google/gwt/i18n/client/"

# --- Step 4: Copy mock replacements (overwrite removed originals) ---
echo "Installing mocks..."
cp "$SCRIPT_DIR/mocks/"*.java "$PKG_DIR/"

# --- Step 5: Copy ShapeExtractor ---
cp "$SCRIPT_DIR/ShapeExtractor.java" "$PKG_DIR/"

# --- Step 6: Strip GWT native methods from any remaining files ---
echo "Stripping native methods..."
for jf in "$PKG_DIR/"*.java; do
    if grep -q '/\*-{' "$jf" 2>/dev/null; then
        python -c "
import re, sys
with open(sys.argv[1], 'r') as f:
    content = f.read()
content = re.sub(r'\bnative\s+', '', content)
content = re.sub(r'/\*-\{.*?\}-\*/', '{ }', content, flags=re.DOTALL)
with open(sys.argv[1], 'w') as f:
    f.write(content)
" "$jf" 2>/dev/null || true
    fi
done

# --- Step 7: Compile (with iterative error removal) ---
echo ""
echo "Compiling..."

compile_attempt() {
    local attempt="$1"
    # Use @file to avoid "argument list too long" — with paths relative to BUILD_DIR
    (cd "$BUILD_DIR" && find src -name "*.java" > sources.txt)
    (cd "$BUILD_DIR" && javac -d classes -sourcepath src @sources.txt 2>errors_${attempt}.txt)
}

MAX_ATTEMPTS=5
for attempt in $(seq 1 $MAX_ATTEMPTS); do
    if compile_attempt "$attempt"; then
        echo "Compilation succeeded (attempt $attempt)!"
        break
    else
        if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
            echo "FATAL: Compilation failed after $MAX_ATTEMPTS attempts."
            echo "Last errors:"
            tail -30 "$BUILD_DIR/errors_${attempt}.txt"
            exit 1
        fi

        # Extract filenames with errors, remove non-essential ones
        REMOVED=0
        while IFS= read -r ef; do
            [ -z "$ef" ] && continue
            base=$(basename "$ef")
            # Never remove core infrastructure
            case "$base" in
                CircuitElm.java|ShapeExtractor.java|Graphics.java|CirSim.java|\
                Point.java|Rectangle.java|Polygon.java|Color.java|Font.java|\
                StringTokenizer.java|CheckboxMenuItem.java|EditInfo.java|\
                EditDialog.java|Checkbox.java|Choice.java|Adjustable.java|\
                Scrollbar.java|CircuitNode.java|CircuitNodeLink.java|\
                Diode.java|DiodeModel.java|TransistorModel.java|\
                Scope.java|ScopeElm.java|CustomLogicModel.java|\
                VoltageElm.java|RailElm.java|SweepElm.java)
                    ;;
                *)
                    # Paths in error output are relative to BUILD_DIR
                    fullpath="$BUILD_DIR/$ef"
                    if [ -f "$fullpath" ]; then
                        echo "  [attempt $attempt] Removing: $base"
                        rm -f "$fullpath"
                        REMOVED=$((REMOVED + 1))
                    fi
                    ;;
            esac
        done < <(grep "\.java:.*error:" "$BUILD_DIR/errors_${attempt}.txt" | sed 's/:.*//g' | sort -u)

        if [ "$REMOVED" -eq 0 ]; then
            echo "No removable files found. Core errors:"
            cat "$BUILD_DIR/errors_${attempt}.txt"
            exit 1
        fi
        echo "  Removed $REMOVED files, retrying..."
    fi
done

# --- Step 8: Run extractor ---
echo ""
echo "Running ShapeExtractor..."
java -cp "$BUILD_DIR/classes" com.lushprojects.circuitjs1.client.ShapeExtractor "$OUTPUT"

echo ""
echo "Done! Output: $OUTPUT"

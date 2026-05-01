package com.lushprojects.circuitjs1.client;

import java.io.FileWriter;
import java.io.PrintWriter;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Extracts shape draw calls and pin positions from CircuitJS1 components.
 *
 * For each component:
 *   1. Instantiate at canonical position (0,0)→(64,0) or (0,0)→(0,64)
 *   2. Call setPoints() to compute geometry
 *   3. Call draw() with recording Graphics to capture all primitives
 *   4. Record getPost(n) for each post → pin positions
 *   5. Output as JSON
 */
public class ShapeExtractor {

    // Canonical element length in pixels (= 4 grid units at 16px/grid)
    static final int CANONICAL_LEN = 64;

    // Component classes to extract (class name → constructor style)
    // "2" = 2-terminal (xx,yy), "3pnp" = 3-terminal with boolean pnp flag, etc.
    static final String[][] COMPONENTS = {
        // Passives
        {"ResistorElm", "2"},
        {"CapacitorElm", "2"},
        {"InductorElm", "2"},
        {"PotElm", "2"},       // Potentiometer
        {"TransformerElm", "xfmr"},
        {"CrystalElm", "2"},
        {"MemristorElm", "2"},
        {"FuseElm", "2"},
        {"PolarCapacitorElm", "2"},
        {"TappedTransformerElm", "2"},
        {"TransLineElm", "2"},

        // Semiconductors
        {"DiodeElm", "2"},
        {"ZenerElm", "2"},
        {"LEDElm", "2"},
        {"TransistorElm", "3npn"},   // NPN
        {"TransistorElm", "3pnp"},   // PNP
        {"MosfetElm", "3npn"},       // NMOS
        {"MosfetElm", "3pnp"},       // PMOS
        {"JfetElm", "3npn"},         // NJFET
        {"JfetElm", "3pnp"},         // PJFET
        {"SCRElm", "2"},
        {"TriacElm", "2"},
        {"DiacElm", "2"},
        {"TunnelDiodeElm", "2"},
        {"VaractorElm", "2"},
        {"TriodeElm", "2"},

        // Sources
        {"DCVoltageElm", "2"},
        {"ACVoltageElm", "2"},
        {"CurrentElm", "2"},
        {"GroundElm", "2"},
        {"RailElm", "2"},
        {"DCVoltageElm", "2_as_Voltage"},

        // Active
        {"OpAmpElm", "2"},
        {"ComparatorElm", "2"},
        {"AnalogSwitchElm", "2"},
        {"AnalogSwitch2Elm", "2"},
        {"CCCSElm", "2"},
        {"CCVSElm", "2"},
        {"VCCSElm", "2"},
        {"VCVSElm", "2"},
        {"InvertingSchmittElm", "2"},
        {"SchmittElm", "2"},
        {"TimerElm", "2"},
        {"OTAElm", "2"},
        {"OptocouplerElm", "2"},
        {"OpAmpRealElm", "2"},

        // Sensors/misc
        {"LDRElm", "2"},
        {"LampElm", "2"},
        {"ThermistorNTCElm", "2"},
        {"SparkGapElm", "2"},
        {"SwitchElm", "2"},
        {"Switch2Elm", "2"},

        // Digital (gate shapes)
        {"InverterElm", "2"},
        {"LogicInputElm", "2"},
        {"LogicOutputElm", "2"},
    };

    public static void main(String[] args) throws Exception {
        String outputPath = args.length > 0 ? args[0] : "falstad-shapes.json";

        // Initialize CircuitElm statics
        CirSim sim = new CirSim();
        CircuitElm.initClass(sim);
        CircuitElm.setColorScale();
        // Set static colors that are normally initialized by CirSim UI setup
        CircuitElm.whiteColor = Color.white;
        CircuitElm.selectColor = Color.cyan;
        CircuitElm.lightGrayColor = Color.lightGray;

        Map<String, Object> results = new LinkedHashMap<>();

        for (String[] spec : COMPONENTS) {
            String className = spec[0];
            String style = spec[1];

            String key = className;
            if (style.equals("3pnp")) key = className.replace("Elm", "") + "_PNP";
            else if (style.equals("3npn")) key = className.replace("Elm", "") + "_NPN";
            else if (style.equals("2_as_Voltage")) key = "Voltage";
            else if (className.equals("SchmittElm")) key = "SchmittNonInverting";
            else if (className.equals("InvertingSchmittElm")) key = "SchmittInverting";
            else if (className.equals("PolarCapacitorElm")) key = "PolarCapacitor";
            else if (className.equals("ThermistorNTCElm")) key = "ThermistorNTC";
            else if (className.equals("TimerElm")) key = "Timer";
            else if (className.equals("OpAmpRealElm")) key = "OpAmpReal";
            else key = className.replace("Elm", "");

            try {
                CircuitElm elm = createComponent(className, style);
                if (elm == null) {
                    System.err.println("SKIP " + key + ": could not instantiate");
                    continue;
                }

                // Set canonical position
                setupCanonicalPosition(elm, style);

                // TransLineElm: width defaults to 0 in (int,int) constructor;
                // set it to 1 grid unit (16px) so the 4 terminals spread out
                if (className.equals("TransLineElm")) {
                    Field widthField = elm.getClass().getDeclaredField("width");
                    widthField.setAccessible(true);
                    widthField.setInt(elm, 16);
                }

                // Re-allocate nodes (some constructors set fields after super(),
                // so allocNodes() during super() used wrong postCount)
                elm.allocNodes();

                // Compute geometry
                elm.setPoints();

                // Record draw calls
                Graphics g = new Graphics();
                elm.draw(g);

                // Record pin positions
                List<Map<String, Object>> pins = new ArrayList<>();
                int postCount = elm.getPostCount();
                for (int i = 0; i < postCount; i++) {
                    try {
                        Point p = elm.getPost(i);
                        Map<String, Object> pin = new LinkedHashMap<>();
                        pin.put("index", i);
                        pin.put("x", p.x);
                        pin.put("y", p.y);
                        pins.add(pin);
                    } catch (Exception e) {
                        System.err.println("  pin " + i + " error: " + e.getMessage());
                    }
                }

                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("className", className);
                entry.put("style", style);
                entry.put("postCount", postCount);
                entry.put("x", elm.x);
                entry.put("y", elm.y);
                entry.put("x2", elm.x2);
                entry.put("y2", elm.y2);
                entry.put("pins", pins);
                entry.put("draws", g.recorded);

                results.put(key, entry);
                System.err.println("OK   " + key + ": " + g.recorded.size() + " draw calls, " + postCount + " pins");

            } catch (Exception e) {
                System.err.println("FAIL " + key + ": " + e.getClass().getSimpleName() + ": " + e.getMessage());
            }
        }

        // Write JSON output
        try (PrintWriter out = new PrintWriter(new FileWriter(outputPath))) {
            out.println(toJson(results));
        }
        System.err.println("\nWrote " + results.size() + " components to " + outputPath);
    }

    static CircuitElm createComponent(String className, String style) throws Exception {
        String fqn = "com.lushprojects.circuitjs1.client." + className;
        Class<?> cls = Class.forName(fqn);

        if (style.equals("3pnp")) {
            Constructor<?> ctor = cls.getDeclaredConstructor(int.class, int.class, boolean.class);
            ctor.setAccessible(true);
            return (CircuitElm) ctor.newInstance(0, 0, true);
        } else if (style.equals("3npn")) {
            Constructor<?> ctor = cls.getDeclaredConstructor(int.class, int.class, boolean.class);
            ctor.setAccessible(true);
            return (CircuitElm) ctor.newInstance(0, 0, false);
        } else {
            // Try (int, int) constructor first, then (int, int, boolean)
            try {
                Constructor<?> ctor = cls.getDeclaredConstructor(int.class, int.class);
                ctor.setAccessible(true);
                return (CircuitElm) ctor.newInstance(0, 0);
            } catch (NoSuchMethodException e) {
                try {
                    Constructor<?> ctor = cls.getDeclaredConstructor(int.class, int.class, boolean.class);
                    ctor.setAccessible(true);
                    return (CircuitElm) ctor.newInstance(0, 0, false);
                } catch (NoSuchMethodException e2) {
                    System.err.println("  No suitable constructor for " + className);
                    return null;
                }
            }
        }
    }

    static void setupCanonicalPosition(CircuitElm elm, String style) {
        elm.x = 0;
        elm.y = 0;

        if (style.equals("xfmr")) {
            // Transformer: horizontal with vertical width separation
            // point1=(0,0), point2=(64,32)- width comes from abs(y2-y)
            elm.x2 = CANONICAL_LEN;
            elm.y2 = 32;
        } else {
            // Default: horizontal, 64px long
            elm.x2 = CANONICAL_LEN;
            elm.y2 = 0;
        }
    }

    // ---- Simple JSON serializer (no external deps) ----

    @SuppressWarnings("unchecked")
    static String toJson(Object obj) {
        if (obj == null) return "null";
        if (obj instanceof String) return "\"" + escapeJson((String) obj) + "\"";
        if (obj instanceof Number) return obj.toString();
        if (obj instanceof Boolean) return obj.toString();
        if (obj instanceof Map) {
            Map<String, Object> map = (Map<String, Object>) obj;
            StringBuilder sb = new StringBuilder("{\n");
            int i = 0;
            for (Map.Entry<String, Object> e : map.entrySet()) {
                if (i > 0) sb.append(",\n");
                sb.append("  ").append(toJson(e.getKey())).append(": ").append(toJson(e.getValue()));
                i++;
            }
            sb.append("\n}");
            return sb.toString();
        }
        if (obj instanceof List) {
            List<?> list = (List<?>) obj;
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < list.size(); i++) {
                if (i > 0) sb.append(", ");
                Object item = list.get(i);
                // Draw records are pre-serialized JSON strings
                if (item instanceof String && ((String) item).startsWith("{")) {
                    sb.append(item);
                } else {
                    sb.append(toJson(item));
                }
            }
            sb.append("]");
            return sb.toString();
        }
        return toJson(obj.toString());
    }

    static String escapeJson(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
    }
}

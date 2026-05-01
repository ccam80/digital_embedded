package com.lushprojects.circuitjs1.client;

import java.util.Vector;

/**
 * Minimal mock of CirSim- provides fields/methods referenced by Elm draw()/setPoints().
 */
public class CirSim {
    // Mode constants
    public static final int MODE_DRAG_ROW = 1;
    public static final int MODE_DRAG_COLUMN = 2;

    // Simulation state
    public double t = 0;
    public double timeStep = 5e-6;
    public double maxTimeStep = 5e-6;
    public double minTimeStep = 5e-12;
    public int timeStepCount = 0;
    public boolean dcAnalysisFlag = false;
    public boolean converged = true;
    public boolean analyzeFlag = false;
    public int subIterations = 1;
    public int gridSize = 16;
    public int mouseMode = 0;
    public static String ohmString = "\u03A9";
    public java.util.Random random = new java.util.Random(42);
    public boolean showResistanceInVoltageSources = false;
    public CircuitElm plotXElm = null;
    public CheckboxMenuItem euroGatesCheckItem = new CheckboxMenuItem(false);
    public static Object diodeModelEditDialog = null;
    public static Object transistorModelEditDialog = null;

    public int getrand(int max) { return random.nextInt(max); }

    // Element references
    public CircuitElm dragElm = null;
    public CircuitElm plotYElm = null;
    public Vector<CircuitElm> elmList = new Vector<>();
    public Vector<CircuitNode> nodeList = new Vector<>();

    // Checkbox toggles- all false by default (no voltage coloring, no power, etc.)
    public CheckboxMenuItem voltsCheckItem = new CheckboxMenuItem(false);
    public CheckboxMenuItem powerCheckItem = new CheckboxMenuItem(false);
    public CheckboxMenuItem showValuesCheckItem = new CheckboxMenuItem(true);
    public CheckboxMenuItem dotsCheckItem = new CheckboxMenuItem(false);
    public CheckboxMenuItem euroResistorCheckItem = new CheckboxMenuItem(false);
    public CheckboxMenuItem smallGridCheckItem = new CheckboxMenuItem(false);
    public CheckboxMenuItem printableCheckItem = new CheckboxMenuItem(false);
    public CheckboxMenuItem conventionCheckItem = new CheckboxMenuItem(true);
    public CheckboxMenuItem stoppedCheck = new CheckboxMenuItem(false);
    public CheckboxMenuItem optionalWireCheckItem = new CheckboxMenuItem(false);

    // Methods referenced by CircuitElm and subclasses
    public boolean simIsRunning() { return false; }
    public int snapGrid(int x) { return x; }
    public CircuitElm getElm(int i) { return elmList.get(i); }
    public CircuitNode getCircuitNode(int n) {
        if (n < nodeList.size()) return nodeList.get(n);
        return new CircuitNode();
    }
    public int getNodeCount() { return nodeList.size(); }
    public static String LS(String s) { return s; }
    public void repaint() {}

    // Stamp methods- no-ops (never called during draw)
    public void stampResistor(int n1, int n2, double r) {}
    public void stampVoltageSource(int n1, int n2, int vs, double v) {}
    public void stampVoltageSource(int n1, int n2, int vs) {}
    public void stampCurrentSource(int n1, int n2, double i) {}
    public void stampMatrix(int r, int c, double v) {}
    public void stampRightSide(int r, double v) {}
    public void stampRightSide(int r) {}
    public void stampNonLinear(int r) {}
    public void stampConductance(int n1, int n2, double g) {}
    public void stampCCCS(int n1, int n2, int n3, int n4, double g) {}
    public void stampCCCS(int n1, int n2, int n3, double g) {}
    public void stampVCCurrentSource(int n1, int n2, int n3, int n4, double g) {}
    public void stampVCVS(int n1, int v1, double coef, int n2, int v2) {}
    public void stampVCVS(int n1, int n2, int n3, int n4) {}
    public int allocateNode() { return nodeList.size(); }
    public void updateVoltageSource(int n1, int n2, int vs, double v) {}
    public void deleteSliders(CircuitElm elm) {}
    public void stop(String msg, CircuitElm elm) {}
    public boolean needsHighlight() { return false; }
    public void addAdjustable(Adjustable a) {}
    public void removeAdjustable(CircuitElm elm) {}

    // Static fields
    public static String muString = "\u03bc";
    public static CirSim theSim;
    public static void console(String s) { System.err.println("[CirSim] " + s); }
    public void updateModels() {}
    public static CircuitElm constructElement(String type, int x, int y) {
        // Try to instantiate the real class for CompositeElm construction
        try {
            Class<?> cls = Class.forName("com.lushprojects.circuitjs1.client." + type);
            java.lang.reflect.Constructor<?> ctor = cls.getDeclaredConstructor(int.class, int.class);
            ctor.setAccessible(true);
            return (CircuitElm) ctor.newInstance(x, y);
        } catch (Exception e) {
            // Fallback: return a minimal stub
            return new CircuitElm(x, y) {
                int getDumpType() { return 0; }
                public void stamp() {}
                public void draw(Graphics g) {}
                public int getPostCount() { return 2; }
                public int getInternalNodeCount() { return 0; }
            };
        }
    }
    public static CircuitElm createCe(int type, int x1, int y1, int x2, int y2, int flags, StringTokenizer st) {
        return constructElement("", x1, y1);
    }
    public void addWidgetToVerticalPanel(com.google.gwt.user.client.ui.Label w) {}
    public void addWidgetToVerticalPanel(Scrollbar w) {}
    public void removeWidgetFromVerticalPanel(com.google.gwt.user.client.ui.Label w) {}
    public void removeWidgetFromVerticalPanel(Scrollbar w) {}
    public void setiFrameHeight() {}

    // Constructor
    public CirSim() { theSim = this; }
}

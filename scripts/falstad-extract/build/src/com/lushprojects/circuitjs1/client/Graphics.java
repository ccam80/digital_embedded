package com.lushprojects.circuitjs1.client;

import com.google.gwt.canvas.dom.client.Context2d;
import com.google.gwt.canvas.dom.client.CanvasGradient;
import java.util.ArrayList;
import java.util.List;

/**
 * Recording replacement for CircuitJS1's Graphics class.
 * Captures all draw calls as JSON-serializable records.
 */
public class Graphics {

    // Keep a real Context2d stub for code that accesses g.context directly
    public Context2d context = new RecordingContext2d(this);
    int currentFontSize;
    Font currentFont = null;
    Color lastColor;
    static boolean isFullScreen = false;

    // ---- Recording storage ----
    public List<String> recorded = new ArrayList<>();
    private double lineWidth = 1.0;

    public Graphics(Context2d ctx) {
        this.context = (ctx != null) ? ctx : new RecordingContext2d(this);
    }

    public Graphics() {
        this.context = new RecordingContext2d(this);
    }

    // ---- Intercept all draw calls ----

    public void setColor(Color color) { lastColor = color; }
    public void setColor(String color) { lastColor = null; }

    public void clipRect(int x, int y, int width, int height) {}
    public void restore() {}

    public void fillRect(int x, int y, int width, int height) {
        recorded.add("{\"type\":\"fillRect\",\"x\":" + x + ",\"y\":" + y +
                     ",\"w\":" + width + ",\"h\":" + height + "}");
    }

    public void drawRect(int x, int y, int width, int height) {
        recorded.add("{\"type\":\"rect\",\"x\":" + x + ",\"y\":" + y +
                     ",\"w\":" + width + ",\"h\":" + height + "}");
    }

    public void fillOval(int x, int y, int width, int height) {
        int cx = x + width / 2;
        int cy = y + height / 2;
        int r = width / 2;
        recorded.add("{\"type\":\"fillCircle\",\"cx\":" + cx + ",\"cy\":" + cy + ",\"r\":" + r + "}");
    }

    public void drawString(String s, int x, int y) {
        recorded.add("{\"type\":\"text\",\"text\":\"" + escapeJson(s) + "\",\"x\":" + x + ",\"y\":" + y + "}");
    }

    public double measureWidth(String s) { return s.length() * 7.0; }

    public void setLineWidth(double width) { lineWidth = width; }

    public void drawLine(int x1, int y1, int x2, int y2) {
        boolean thick = lineWidth >= 2.5;
        recorded.add("{\"type\":\"line\",\"x1\":" + x1 + ",\"y1\":" + y1 +
                     ",\"x2\":" + x2 + ",\"y2\":" + y2 +
                     ",\"thick\":" + thick + "}");
    }

    public void drawPolyline(int[] xpoints, int[] ypoints, int n) {
        StringBuilder sb = new StringBuilder("{\"type\":\"polyline\",\"points\":[");
        for (int i = 0; i < n; i++) {
            if (i > 0) sb.append(",");
            sb.append("[").append(xpoints[i]).append(",").append(ypoints[i]).append("]");
        }
        sb.append("]}");
        recorded.add(sb.toString());
    }

    public void fillPolygon(Polygon p) {
        StringBuilder sb = new StringBuilder("{\"type\":\"fillPolygon\",\"points\":[");
        for (int i = 0; i < p.npoints; i++) {
            if (i > 0) sb.append(",");
            sb.append("[").append(p.xpoints[i]).append(",").append(p.ypoints[i]).append("]");
        }
        sb.append("]}");
        recorded.add(sb.toString());
    }

    public void setFont(Font f) {
        if (f != null) {
            currentFontSize = f.size;
            currentFont = f;
        }
    }

    Font getFont() { return currentFont; }

    static int distanceSq(int x1, int y1, int x2, int y2) {
        x2 -= x1; y2 -= y1;
        return x2 * x2 + y2 * y2;
    }

    void setLineDash(int a, int b) {}

    private static String escapeJson(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
    }

    // ---- RecordingContext2d: captures g.context.* calls ----

    static class RecordingContext2d extends Context2d {
        private final Graphics owner;
        private List<double[]> pathPoints = new ArrayList<>();
        private boolean inPath = false;
        private double curX = 0, curY = 0;
        private double lw = 1.0;

        RecordingContext2d(Graphics owner) { this.owner = owner; }

        @Override public void beginPath() {
            pathPoints.clear();
            inPath = true;
        }
        @Override public void closePath() { inPath = false; }
        @Override public void moveTo(double x, double y) {
            curX = x; curY = y;
            pathPoints.add(new double[]{x, y});
        }
        @Override public void lineTo(double x, double y) {
            // Record as a line segment
            boolean thick = lw >= 2.5;
            owner.recorded.add("{\"type\":\"line\",\"x1\":" + curX + ",\"y1\":" + curY +
                               ",\"x2\":" + x + ",\"y2\":" + y +
                               ",\"thick\":" + thick + "}");
            curX = x; curY = y;
            pathPoints.add(new double[]{x, y});
        }
        @Override public void stroke() {
            // Path already recorded line-by-line in lineTo
        }
        @Override public void fill() {
            // Record as filled polygon
            if (pathPoints.size() >= 3) {
                StringBuilder sb = new StringBuilder("{\"type\":\"fillPolygon\",\"points\":[");
                for (int i = 0; i < pathPoints.size(); i++) {
                    if (i > 0) sb.append(",");
                    sb.append("[").append(pathPoints.get(i)[0]).append(",").append(pathPoints.get(i)[1]).append("]");
                }
                sb.append("]}");
                owner.recorded.add(sb.toString());
            }
        }
        @Override public void arc(double x, double y, double radius, double startAngle, double endAngle) {
            owner.recorded.add("{\"type\":\"arc\",\"cx\":" + x + ",\"cy\":" + y +
                               ",\"r\":" + radius +
                               ",\"start\":" + startAngle + ",\"end\":" + endAngle + "}");
        }
        @Override public void save() {}
        @Override public void restore() {}
        @Override public void setLineWidth(double w) { lw = w; owner.lineWidth = w; }
        @Override public void setStrokeStyle(String s) {}
        @Override public void setStrokeStyle(CanvasGradient g) {}
        @Override public void setFillStyle(String s) {}
        @Override public void transform(double a, double b, double c, double d, double e, double f) {}
        @Override public void strokeRect(double x, double y, double w, double h) {
            owner.recorded.add("{\"type\":\"rect\",\"x\":" + x + ",\"y\":" + y +
                               ",\"w\":" + w + ",\"h\":" + h + "}");
        }
        @Override public void fillRect(double x, double y, double w, double h) {
            owner.recorded.add("{\"type\":\"fillRect\",\"x\":" + x + ",\"y\":" + y +
                               ",\"w\":" + w + ",\"h\":" + h + "}");
        }
        @Override public void fillText(String text, double x, double y) {
            owner.recorded.add("{\"type\":\"text\",\"text\":\"" + escapeJson(text) +
                               "\",\"x\":" + x + ",\"y\":" + y + "}");
        }
        @Override public void setFont(String font) {}
        @Override public CanvasGradient createLinearGradient(double x0, double y0, double x1, double y1) {
            return new CanvasGradient();
        }
        @Override public TextMetrics measureText(String text) { return new TextMetrics(); }

        private static String escapeJson(String s) {
            return s.replace("\\", "\\\\").replace("\"", "\\\"");
        }
    }
}

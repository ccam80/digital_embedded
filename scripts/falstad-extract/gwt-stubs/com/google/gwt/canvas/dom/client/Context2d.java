package com.google.gwt.canvas.dom.client;

/**
 * Stub for GWT Context2d — used by CircuitJS1's Graphics class.
 * Our mock Graphics replaces Graphics.java and doesn't use this,
 * but CircuitElm.java imports Context2d.LineCap so we need this to compile.
 */
public class Context2d {
    public enum LineCap {
        BUTT, ROUND, SQUARE;
        public String getValue() { return name().toLowerCase(); }
    }

    // Canvas2D methods — no-ops for compilation only.
    // The actual recording happens in our mock Graphics.java.
    public void beginPath() {}
    public void closePath() {}
    public void moveTo(double x, double y) {}
    public void lineTo(double x, double y) {}
    public void stroke() {}
    public void fill() {}
    public void arc(double x, double y, double radius, double startAngle, double endAngle) {}
    public void save() {}
    public void restore() {}
    public void setLineWidth(double w) {}
    public void setLineCap(String cap) {}
    public void setLineCap(LineCap cap) {}
    public void setStrokeStyle(String s) {}
    public void setStrokeStyle(CanvasGradient g) {}
    public void setFillStyle(String s) {}
    public void transform(double a, double b, double c, double d, double e, double f) {}
    public void strokeRect(double x, double y, double w, double h) {}
    public void fillRect(double x, double y, double w, double h) {}
    public void fillText(String text, double x, double y) {}
    public void setFont(String font) {}
    public void setTextBaseline(String baseline) {}
    public void setTextAlign(String align) {}
    public void setTransform(double a, double b, double c, double d, double e, double f) {}
    public void rect(double x, double y, double w, double h) {}
    public void clip() {}
    public void scale(double x, double y) {}
    public void translate(double x, double y) {}
    public void rotate(double angle) {}
    public void quadraticCurveTo(double cpx, double cpy, double x, double y) {}
    public void bezierCurveTo(double cp1x, double cp1y, double cp2x, double cp2y, double x, double y) {}
    public CanvasGradient createLinearGradient(double x0, double y0, double x1, double y1) {
        return new CanvasGradient();
    }
    public TextMetrics measureText(String text) { return new TextMetrics(); }

    public static class TextMetrics {
        public double getWidth() { return 10.0; }
    }
}

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
        private double pathStartX = 0, pathStartY = 0;
        private double lw = 1.0;

        // Affine transform: x' = a*x + c*y + e,  y' = b*x + d*y + f
        private double ma = 1, mb = 0, mc = 0, md = 1, me = 0, mf = 0;
        private List<double[]> matrixStack = new ArrayList<>();

        RecordingContext2d(Graphics owner) { this.owner = owner; }

        // ---- Transform helpers ----
        private double tx(double x, double y) { return ma * x + mc * y + me; }
        private double ty(double x, double y) { return mb * x + md * y + mf; }
        private double tlen(double r) {
            double sx = Math.sqrt(ma * ma + mb * mb);
            double sy = Math.sqrt(mc * mc + md * md);
            return r * (sx + sy) * 0.5;
        }

        // ---- Matrix ops ----
        @Override public void save() {
            matrixStack.add(new double[]{ma, mb, mc, md, me, mf, lw});
        }
        @Override public void restore() {
            if (!matrixStack.isEmpty()) {
                double[] s = matrixStack.remove(matrixStack.size() - 1);
                ma=s[0]; mb=s[1]; mc=s[2]; md=s[3]; me=s[4]; mf=s[5]; lw=s[6];
            }
        }
        @Override public void transform(double A, double B, double C, double D,
                                         double E, double F) {
            double na = ma*A + mc*B, nb = mb*A + md*B;
            double nc = ma*C + mc*D, nd = mb*C + md*D;
            double ne = ma*E + mc*F + me, nf = mb*E + md*F + mf;
            ma=na; mb=nb; mc=nc; md=nd; me=ne; mf=nf;
        }
        @Override public void setTransform(double a, double b, double c,
                                            double d, double e, double f) {
            ma=a; mb=b; mc=c; md=d; me=e; mf=f;
        }
        @Override public void scale(double sx, double sy) {
            ma *= sx; mb *= sx; mc *= sy; md *= sy;
        }
        @Override public void translate(double tx, double ty) {
            me += ma*tx + mc*ty; mf += mb*tx + md*ty;
        }
        @Override public void rotate(double angle) {
            double cos = Math.cos(angle), sin = Math.sin(angle);
            double na = ma*cos + mc*sin, nb = mb*cos + md*sin;
            double nc = ma*(-sin) + mc*cos, nd = mb*(-sin) + md*cos;
            ma=na; mb=nb; mc=nc; md=nd;
        }

        // ---- Path ops (coords transformed before recording) ----
        @Override public void beginPath() { pathPoints.clear(); inPath = true; }
        @Override public void closePath() {
            if (inPath && pathPoints.size() >= 2) {
                double startX = pathPoints.get(0)[0], startY = pathPoints.get(0)[1];
                double endX = tx(curX, curY), endY = ty(curX, curY);
                if (Math.abs(endX - startX) > 0.001 || Math.abs(endY - startY) > 0.001) {
                    boolean thick = lw >= 2.5;
                    owner.recorded.add("{\"type\":\"line\",\"x1\":" + endX +
                        ",\"y1\":" + endY + ",\"x2\":" + startX +
                        ",\"y2\":" + startY + ",\"thick\":" + thick + "}");
                }
                curX = pathStartX; curY = pathStartY;
            }
            inPath = false;
        }
        @Override public void moveTo(double x, double y) {
            curX = x; curY = y; pathStartX = x; pathStartY = y;
            pathPoints.add(new double[]{tx(x,y), ty(x,y)});
        }
        @Override public void lineTo(double x, double y) {
            boolean thick = lw >= 2.5;
            owner.recorded.add("{\"type\":\"line\",\"x1\":" + tx(curX,curY) +
                ",\"y1\":" + ty(curX,curY) + ",\"x2\":" + tx(x,y) +
                ",\"y2\":" + ty(x,y) + ",\"thick\":" + thick + "}");
            curX = x; curY = y;
            pathPoints.add(new double[]{tx(x,y), ty(x,y)});
        }
        @Override public void stroke() {}
        @Override public void fill() {
            if (pathPoints.size() >= 3) {
                StringBuilder sb = new StringBuilder("{\"type\":\"fillPolygon\",\"points\":[");
                for (int i = 0; i < pathPoints.size(); i++) {
                    if (i > 0) sb.append(",");
                    sb.append("[").append(pathPoints.get(i)[0]).append(",")
                      .append(pathPoints.get(i)[1]).append("]");
                }
                sb.append("]}");
                owner.recorded.add(sb.toString());
            }
        }
        @Override public void arc(double x, double y, double radius,
                                   double startAngle, double endAngle) {
            double rotation = Math.atan2(mb, ma);
            owner.recorded.add("{\"type\":\"arc\",\"cx\":" + tx(x,y) +
                ",\"cy\":" + ty(x,y) + ",\"r\":" + tlen(radius) +
                ",\"start\":" + (startAngle + rotation) +
                ",\"end\":" + (endAngle + rotation) + "}");
        }
        @Override public void strokeRect(double x, double y, double w, double h) {
            double x1=tx(x,y), y1=ty(x,y);
            double x2=tx(x+w,y), y2=ty(x+w,y);
            double x3=tx(x+w,y+h), y3=ty(x+w,y+h);
            double x4=tx(x,y+h), y4=ty(x,y+h);
            boolean thick = lw >= 2.5;
            owner.recorded.add("{\"type\":\"line\",\"x1\":"+x1+",\"y1\":"+y1+
                ",\"x2\":"+x2+",\"y2\":"+y2+",\"thick\":"+thick+"}");
            owner.recorded.add("{\"type\":\"line\",\"x1\":"+x2+",\"y1\":"+y2+
                ",\"x2\":"+x3+",\"y2\":"+y3+",\"thick\":"+thick+"}");
            owner.recorded.add("{\"type\":\"line\",\"x1\":"+x3+",\"y1\":"+y3+
                ",\"x2\":"+x4+",\"y2\":"+y4+",\"thick\":"+thick+"}");
            owner.recorded.add("{\"type\":\"line\",\"x1\":"+x4+",\"y1\":"+y4+
                ",\"x2\":"+x1+",\"y2\":"+y1+",\"thick\":"+thick+"}");
        }
        @Override public void fillRect(double x, double y, double w, double h) {
            owner.recorded.add("{\"type\":\"fillPolygon\",\"points\":[[" +
                tx(x,y)+","+ty(x,y)+"],["+tx(x+w,y)+","+ty(x+w,y)+"],["+
                tx(x+w,y+h)+","+ty(x+w,y+h)+"],["+tx(x,y+h)+","+ty(x,y+h)+"]]}");
        }
        @Override public void fillText(String text, double x, double y) {
            owner.recorded.add("{\"type\":\"text\",\"text\":\"" + escapeJson(text) +
                "\",\"x\":" + tx(x,y) + ",\"y\":" + ty(x,y) + "}");
        }

        @Override public void setLineWidth(double w) { lw = w; owner.lineWidth = w; }
        @Override public void setStrokeStyle(String s) {}
        @Override public void setStrokeStyle(CanvasGradient g) {}
        @Override public void setFillStyle(String s) {}
        @Override public void setFont(String font) {}
        @Override public void setTextBaseline(String baseline) {}
        @Override public void setTextAlign(String align) {}
        @Override public void setLineCap(String cap) {}
        @Override public void setLineCap(LineCap cap) {}
        @Override public CanvasGradient createLinearGradient(double x0, double y0,
                                                             double x1, double y1) {
            return new CanvasGradient();
        }
        @Override public TextMetrics measureText(String text) { return new TextMetrics(); }

        private static String escapeJson(String s) {
            return s.replace("\\", "\\\\").replace("\"", "\\\"");
        }
    }
}

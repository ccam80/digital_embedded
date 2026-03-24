package com.lushprojects.circuitjs1.client;

import com.google.gwt.event.dom.client.MouseWheelEvent;

public class Scrollbar {
    public static final int HORIZONTAL = 0;
    public static final int VERTICAL = 1;
    public Scrollbar() {}
    public Scrollbar(int orientation, int value, int vis, int min, int max, Object... handlers) {}
    public int getValue() { return 0; }
    public void setValue(int v) {}
    public void draw() {}
    public void onMouseWheel(MouseWheelEvent e) {}
}

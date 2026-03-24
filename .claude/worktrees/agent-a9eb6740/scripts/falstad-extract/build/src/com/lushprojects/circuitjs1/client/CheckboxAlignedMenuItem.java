package com.lushprojects.circuitjs1.client;

/** Minimal mock. */
public class CheckboxAlignedMenuItem {
    private boolean on;
    public CheckboxAlignedMenuItem(String s) { on = false; }
    public CheckboxAlignedMenuItem(String s, boolean b) { on = b; }
    public boolean getState() { return on; }
    public void setState(boolean b) { on = b; }
}

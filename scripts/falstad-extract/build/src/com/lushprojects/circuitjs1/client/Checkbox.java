package com.lushprojects.circuitjs1.client;

/** Minimal mock. */
public class Checkbox {
    private boolean on;
    private String name;
    public Checkbox(String s) { name = s; on = false; }
    public Checkbox(String s, boolean b) { name = s; on = b; }
    public boolean getState() { return on; }
    public void setState(boolean b) { on = b; }
}

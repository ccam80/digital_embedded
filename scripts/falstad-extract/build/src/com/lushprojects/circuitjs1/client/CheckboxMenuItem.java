package com.lushprojects.circuitjs1.client;

/** Minimal mock- just a boolean toggle. */
public class CheckboxMenuItem {
    private boolean on;
    private String name;
    static String checkBoxHtml = "";

    public CheckboxMenuItem(boolean initialState) { on = initialState; name = ""; }
    public CheckboxMenuItem(String s) { on = false; name = s; }
    public CheckboxMenuItem(String s, String c) { on = false; name = s; }
    public CheckboxMenuItem(String s, boolean b) { on = b; name = s; }

    public boolean getState() { return on; }
    public void setState(boolean b) { on = b; }
    public String getName() { return name; }
    public String getShortcut() { return ""; }
    public void setShortcut(String s) {}
    public void setTitle(String s) { name = s; }
    public void setHTML(String s) {}
    public void execute() {}
}

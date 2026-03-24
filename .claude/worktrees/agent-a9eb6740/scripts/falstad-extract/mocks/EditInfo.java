package com.lushprojects.circuitjs1.client;

import com.google.gwt.user.client.ui.TextBox;
import com.google.gwt.user.client.ui.TextArea;
import com.google.gwt.user.client.ui.Button;
import com.google.gwt.user.client.ui.Anchor;
import com.google.gwt.user.client.ui.Widget;

/** Minimal mock of EditInfo using GWT stub types. */
class EditInfo {
    String name, text;
    double value;
    TextBox textf;
    Choice choice;
    Checkbox checkbox;
    Button button;
    TextArea textArea;
    Widget widget;
    boolean newDialog;
    boolean dimensionless;
    boolean noSliders;
    TextBox minBox, maxBox, labelBox;

    EditInfo(String n, double val, double mn, double mx) { name = n; value = val; }
    EditInfo(String n, double val) { name = n; value = val; }
    EditInfo(String n, String txt) { name = n; text = txt; }
    EditInfo setDimensionless() { dimensionless = true; return this; }
    EditInfo disallowSliders() { noSliders = true; return this; }

    int changeFlag(int flags, int bit) {
        if (checkbox != null && checkbox.getState()) return flags | bit;
        return flags & ~bit;
    }

    boolean canCreateAdjustable() {
        return choice == null && checkbox == null && button == null && textArea == null &&
               widget == null && !noSliders;
    }

    static String makeLink(String file, String text) { return text; }
}

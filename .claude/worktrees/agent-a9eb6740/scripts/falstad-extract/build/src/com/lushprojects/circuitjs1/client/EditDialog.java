package com.lushprojects.circuitjs1.client;

/** Minimal mock — provides the Editable interface and EditDialog class. */
interface Editable {
    EditInfo getEditInfo(int n);
    void setEditValue(int n, EditInfo ei);
}

class EditDialog {
    EditDialog(Editable ce, CirSim sim) {}
    EditDialog(Editable ce, CirSim sim, boolean b) {}
    void show() {}
    void setVisible(boolean v) {}
}

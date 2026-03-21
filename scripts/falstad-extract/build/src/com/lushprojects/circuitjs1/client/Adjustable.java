package com.lushprojects.circuitjs1.client;

/** Minimal mock. */
public class Adjustable {
    CircuitElm elm;
    double minValue = 1, maxValue = 1000;
    String sliderText;
    int editItem;

    Adjustable(CircuitElm ce, int item) { elm = ce; editItem = item; }
    Adjustable(StringTokenizer st, CirSim sim) {}
    public void execute() {}
    String dump() { return ""; }
    void undump(StringTokenizer st) {}
    void createSlider(CirSim sim) {}
    void setSliderValue(double d) {}
    void deleteSlider(CirSim sim) {}
    double getSliderValue() { return 0; }
    void setMouseElm(CircuitElm e) {}
}

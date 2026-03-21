package com.google.gwt.i18n.client;

public class NumberFormat {
    private String pattern;
    private NumberFormat(String pattern) { this.pattern = pattern; }
    public static NumberFormat getFormat(String pattern) { return new NumberFormat(pattern); }
    public String format(double value) { return String.valueOf(value); }
}

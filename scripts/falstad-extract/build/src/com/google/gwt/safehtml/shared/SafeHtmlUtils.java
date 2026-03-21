package com.google.gwt.safehtml.shared;
public class SafeHtmlUtils  { public static SafeHtml fromString(String s) { return new SafeHtml() { public String asString() { return s; } }; }
     public static SafeHtml fromTrustedString(String s) { return fromString(s); } }

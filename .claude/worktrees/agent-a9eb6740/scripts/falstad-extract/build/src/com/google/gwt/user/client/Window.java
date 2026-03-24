package com.google.gwt.user.client;
public class Window  { public static String prompt(String msg, String val) { return val; }
     public static void alert(String msg) {} public static boolean confirm(String msg) { return false; }
     public static int getClientWidth() { return 800; } public static int getClientHeight() { return 600; }
     public static void open(String url, String name, String features) {}
     public static void setTitle(String t) {}
     public static class Location { public static String getParameter(String n) { return null; }
       public static String getHref() { return ""; } public static String getQueryString() { return ""; } }
     public static class Navigator { public static String getUserAgent() { return ""; } }
     public static class ClosingEvent { public void setMessage(String m) {} }
     public static void addResizeHandler(com.google.gwt.event.logical.shared.ResizeHandler h) {}
     public static void addWindowClosingHandler(Object h) {} }

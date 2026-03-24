package com.google.gwt.user.client;
public class Event  { public static final int ONCLICK = 1;
     public static void addNativePreviewHandler(NativePreviewHandler h) {}
     public interface NativePreviewHandler { void onPreviewNativeEvent(NativePreviewEvent e); }
     public static class NativePreviewEvent { public com.google.gwt.dom.client.NativeEvent getNativeEvent() { return new com.google.gwt.dom.client.NativeEvent(); } public void cancel() {} } }

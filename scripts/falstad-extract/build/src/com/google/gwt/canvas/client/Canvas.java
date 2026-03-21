package com.google.gwt.canvas.client;
public class Canvas  { public static Canvas createIfSupported() { return new Canvas(); }
     public com.google.gwt.dom.client.CanvasElement getCanvasElement() { return new com.google.gwt.dom.client.CanvasElement(); }
     public com.google.gwt.canvas.dom.client.Context2d getContext2d() { return new com.google.gwt.canvas.dom.client.Context2d(); }
     public void setWidth(String w) {} public void setHeight(String h) {}
     public void setCoordinateSpaceWidth(int w) {} public void setCoordinateSpaceHeight(int h) {}
     public int getCoordinateSpaceWidth() { return 800; } public int getCoordinateSpaceHeight() { return 600; } }

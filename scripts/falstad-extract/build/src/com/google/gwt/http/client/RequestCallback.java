package com.google.gwt.http.client;
public interface RequestCallback  { void onResponseReceived(Request req, Response resp); void onError(Request req, Throwable ex); }

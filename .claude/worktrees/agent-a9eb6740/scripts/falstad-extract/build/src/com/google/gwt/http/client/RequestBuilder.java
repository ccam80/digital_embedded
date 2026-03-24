package com.google.gwt.http.client;
public class RequestBuilder  { public enum Method { GET, POST }
     public RequestBuilder(Method m, String url) {}
     public void setHeader(String n, String v) {}
     public Request sendRequest(String data, RequestCallback cb) throws RequestException { return new Request(); } }

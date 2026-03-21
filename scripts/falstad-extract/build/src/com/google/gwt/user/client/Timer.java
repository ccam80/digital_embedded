package com.google.gwt.user.client;
public abstract class Timer  { public abstract void run();
     public void schedule(int ms) {} public void scheduleRepeating(int ms) {} public void cancel() {} }

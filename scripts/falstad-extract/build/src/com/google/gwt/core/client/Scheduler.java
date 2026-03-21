package com.google.gwt.core.client;
public class Scheduler  { public static Scheduler get() { return new Scheduler(); }
     public void scheduleDeferred(ScheduledCommand cmd) {}
     public void scheduleFixedDelay(RepeatingCommand cmd, int ms) {}
     public interface ScheduledCommand { void execute(); }
     public interface RepeatingCommand { boolean execute(); } }

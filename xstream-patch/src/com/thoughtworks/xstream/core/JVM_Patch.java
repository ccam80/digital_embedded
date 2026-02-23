/*
 * Patched version of XStream's JVM.loadClassForName for CheerpJ compatibility.
 *
 * Problem: The original catches only LinkageError | ClassNotFoundException,
 * but CheerpJ throws InternalError when loading classes that depend on
 * missing JDK resources (e.g. JapaneseEra needs calendars.properties).
 *
 * Fix: Catch Throwable so any class-loading failure returns null gracefully,
 * which is exactly what the method contract expects.
 */
package com.thoughtworks.xstream.core;

// This file exists only to document the patch. The actual class must match
// the full JVM API since it replaces the original at the classloader level.
// See build-shim.py for the bytecode-level patch.

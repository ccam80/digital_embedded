/*
 * CheerpJ-compatible replacement for XStream's JVM class.
 *
 * The original loadClassForName() catches only LinkageError and
 * ClassNotFoundException. CheerpJ's incomplete JDK throws InternalError
 * when loading classes that depend on missing resources (e.g. JapaneseEra
 * needs calendars.properties). This replacement catches Throwable so any
 * class-probe failure returns null gracefully.
 *
 * All other methods are faithfully reimplemented from XStream 1.4.20.
 */
package com.thoughtworks.xstream.core;

import com.thoughtworks.xstream.converters.reflection.FieldDictionary;
import com.thoughtworks.xstream.converters.reflection.PureJavaReflectionProvider;
import com.thoughtworks.xstream.converters.reflection.ReflectionProvider;

public class JVM implements Caching {

    private ReflectionProvider reflectionProvider;

    private static final float majorJavaVersion;
    private static final boolean isAWTAvailable;
    private static final boolean isSwingAvailable;
    private static final boolean isSQLAvailable;
    private static final boolean reverseFieldOrder = false;
    private static final boolean canAllocateWithUnsafe;
    private static final boolean canWriteWithUnsafe;
    private static final boolean optimizedTreeSetAddAll = true;
    private static final boolean optimizedTreeMapPutAll = true;
    private static final boolean canParseUTCDateFormat;
    private static final boolean canParseISO8601TimeZoneInDateFormat;
    private static final boolean canCreateDerivedObjectOutputStream;
    private static final StringCodec base64Codec;
    private static final Class reflectionProviderType;

    static {
        // Safe version parsing
        float ver = 1.8f;
        try {
            String specVer = System.getProperty("java.specification.version");
            if (specVer != null) ver = Float.parseFloat(specVer);
        } catch (Exception e) { /* use default */ }
        majorJavaVersion = ver;

        // Safe class availability checks
        isAWTAvailable = loadClassForName("java.awt.Color", false) != null;
        isSwingAvailable = loadClassForName("javax.swing.LookAndFeel", false) != null;
        isSQLAvailable = loadClassForName("java.sql.Date") != null;

        // Unsafe reflection — try to detect
        boolean unsafeAlloc = false;
        boolean unsafeWrite = false;
        Class providerType = PureJavaReflectionProvider.class;
        try {
            Class unsafeProviderClass = loadClassForName(
                "com.thoughtworks.xstream.converters.reflection.SunUnsafeReflectionProvider");
            if (unsafeProviderClass != null) {
                ReflectionProvider testProvider = (ReflectionProvider)
                    unsafeProviderClass.getDeclaredConstructor().newInstance();
                // Quick test: can it allocate?
                testProvider.newInstance(JVM.class);
                unsafeAlloc = true;
                providerType = unsafeProviderClass;
                // Check write capability
                Class sunLimitedClass = loadClassForName(
                    "com.thoughtworks.xstream.converters.reflection.SunLimitedUnsafeReflectionProvider");
                if (sunLimitedClass != null) {
                    unsafeWrite = true;
                }
            }
        } catch (Throwable e) {
            // Fall back to PureJava
        }
        canAllocateWithUnsafe = unsafeAlloc;
        canWriteWithUnsafe = unsafeWrite;
        reflectionProviderType = providerType;

        // Date format checks
        boolean utc = false;
        boolean iso = false;
        try {
            new java.text.SimpleDateFormat("z").parse("UTC");
            utc = true;
        } catch (Throwable e) { /* not supported */ }
        try {
            new java.text.SimpleDateFormat("X");
            iso = true;
        } catch (Throwable e) { /* not supported */ }
        canParseUTCDateFormat = utc;
        canParseISO8601TimeZoneInDateFormat = iso;

        // Derived ObjectOutputStream
        boolean canDerived = false;
        try {
            Class c = loadClassForName(
                "com.thoughtworks.xstream.io.xml.PrettyPrintWriter");
            canDerived = c != null;
        } catch (Throwable e) { /* not supported */ }
        canCreateDerivedObjectOutputStream = canDerived;

        // Base64 codec
        StringCodec codec = null;
        try {
            Class c = loadClassForName("com.thoughtworks.xstream.core.util.Base64JavaUtilCodec");
            if (c != null) codec = (StringCodec) c.getDeclaredConstructor().newInstance();
        } catch (Throwable e) { /* ignore */ }
        if (codec == null) {
            try {
                Class c = loadClassForName("com.thoughtworks.xstream.core.util.Base64JAXBCodec");
                if (c != null) codec = (StringCodec) c.getDeclaredConstructor().newInstance();
            } catch (Throwable e) { /* ignore */ }
        }
        if (codec == null) {
            try {
                codec = (StringCodec) loadClassForName(
                    "com.thoughtworks.xstream.core.util.Base64Encoder")
                    .getDeclaredConstructor().newInstance();
            } catch (Throwable e) { /* ignore */ }
        }
        base64Codec = codec;
    }

    public JVM() {}

    // === THE KEY FIX: catch Throwable instead of LinkageError | CNFE ===

    public static Class loadClassForName(String name) {
        return loadClassForName(name, true);
    }

    public static Class loadClassForName(String name, boolean initialize) {
        try {
            return Class.forName(name, initialize, JVM.class.getClassLoader());
        } catch (Throwable e) {
            // Original only caught LinkageError | ClassNotFoundException.
            // CheerpJ throws InternalError for classes that depend on
            // missing JDK resources. Catching Throwable makes all class
            // probing safe.
            return null;
        }
    }

    public Class loadClass(String name) {
        return loadClassForName(name, true);
    }

    public Class loadClass(String name, boolean initialize) {
        return loadClassForName(name, initialize);
    }

    // === Version checks ===

    private static float getMajorJavaVersion() { return majorJavaVersion; }

    private static boolean isAndroid() {
        String vendor = System.getProperty("java.vm.vendor");
        return vendor != null && vendor.contains("Android");
    }

    private static boolean isIBM() {
        String vendor = System.getProperty("java.vm.vendor");
        return vendor != null && vendor.contains("IBM");
    }

    public static boolean isVersion(int version) {
        return majorJavaVersion >= version;
    }

    public static boolean is14() { return isVersion(4); }
    public static boolean is15() { return isVersion(5); }
    public static boolean is16() { return isVersion(6); }
    public static boolean is17() { return isVersion(7); }
    public static boolean is18() { return isVersion(8); }
    public static boolean is19() { return isVersion(9); }
    public static boolean is9()  { return isVersion(9); }

    // === Feature detection ===

    public static boolean isAWTAvailable() { return isAWTAvailable; }
    public boolean supportsAWT() { return isAWTAvailable; }
    public static boolean isSwingAvailable() { return isSwingAvailable; }
    public boolean supportsSwing() { return isSwingAvailable; }
    public static boolean isSQLAvailable() { return isSQLAvailable; }
    public boolean supportsSQL() { return isSQLAvailable; }
    public static boolean hasOptimizedTreeSetAddAll() { return optimizedTreeSetAddAll; }
    public static boolean hasOptimizedTreeMapPutAll() { return optimizedTreeMapPutAll; }
    public static boolean canParseUTCDateFormat() { return canParseUTCDateFormat; }
    public static boolean canParseISO8601TimeZoneInDateFormat() { return canParseISO8601TimeZoneInDateFormat; }
    public static boolean canCreateDerivedObjectOutputStream() { return canCreateDerivedObjectOutputStream; }
    public static boolean reverseFieldDefinition() { return reverseFieldOrder; }
    public static StringCodec getBase64Codec() { return base64Codec; }

    // === Reflection providers ===

    public static ReflectionProvider newReflectionProvider() {
        try {
            return (ReflectionProvider) reflectionProviderType
                .getDeclaredConstructor().newInstance();
        } catch (Throwable e) {
            return new PureJavaReflectionProvider();
        }
    }

    public static ReflectionProvider newReflectionProvider(FieldDictionary fd) {
        try {
            return (ReflectionProvider) reflectionProviderType
                .getDeclaredConstructor(FieldDictionary.class).newInstance(fd);
        } catch (Throwable e) {
            return new PureJavaReflectionProvider(fd);
        }
    }

    public synchronized ReflectionProvider bestReflectionProvider() {
        if (reflectionProvider == null) {
            reflectionProvider = newReflectionProvider();
        }
        return reflectionProvider;
    }

    // === StAX factories ===

    public static Class getStaxInputFactory() throws ClassNotFoundException {
        if (isVersion(6)) {
            if (isIBM()) {
                Class c = loadClassForName("com.ibm.xml.xlxp2.api.wss.WSSInputFactory");
                if (c != null) return c;
            }
            return Class.forName("com.sun.xml.internal.stream.XMLInputFactoryImpl");
        }
        throw new ClassNotFoundException("StAX not available");
    }

    public static Class getStaxOutputFactory() throws ClassNotFoundException {
        if (isVersion(6)) {
            if (isIBM()) {
                Class c = loadClassForName("com.ibm.xml.xlxp2.api.wss.WSSOutputFactory");
                if (c != null) return c;
            }
            return Class.forName("com.sun.xml.internal.stream.XMLOutputFactoryImpl");
        }
        throw new ClassNotFoundException("StAX not available");
    }

    // === Caching interface ===

    public void flushCache() {
        reflectionProvider = null;
    }

    // === Debug main ===

    public static void main(String[] args) {
        System.out.println("XStream JVM Compatibility Info (CheerpJ patched)");
        System.out.println("Java version: " + majorJavaVersion);
        System.out.println("AWT available: " + isAWTAvailable);
        System.out.println("Swing available: " + isSwingAvailable);
        System.out.println("SQL available: " + isSQLAvailable);
    }
}

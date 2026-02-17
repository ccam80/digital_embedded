/*
 * Launcher for Digital that bridges the running Swing app to JavaScript
 * via CheerpJ's native method interoperability.
 *
 * All frame lookup and file loading happens in Java (same JVM), avoiding
 * any CheerpJ proxy boundary issues. JavaScript only sends string commands.
 *
 * Flow:
 *   1. Launcher starts Digital's Main.main(args)
 *   2. Background thread polls Frame.getFrames() until Main frame appears
 *   3. Calls nativeReady() → JS sends 'digital-ready' to parent
 *   4. Enters command loop: waitForCommand() blocks until JS resolves a promise
 *   5. Java loads the file via Main.loadFile(), calls nativeLoaded()/nativeError()
 *   6. Loops back to waitForCommand()
 */
package digital.launcher;

import java.awt.Frame;
import java.io.File;

public class Launcher {

    /** Blocks until JS sends a file path. JS resolves the returned promise. */
    public static native String waitForCommand();

    /** Tells JS the bridge is ready (Main frame found). */
    public static native void nativeReady();

    /** Tells JS a file was loaded successfully. */
    public static native void nativeLoaded();

    /** Tells JS an error occurred. */
    public static native void nativeError(String message);

    public static void main(String[] args) {
        // Start the bridge thread before launching Digital
        new Thread(() -> {
            // Poll until the Main frame appears (same JVM — will find it)
            Frame mainFrame = null;
            for (int attempt = 0; attempt < 120; attempt++) {
                try { Thread.sleep(500); } catch (InterruptedException e) { break; }
                Frame[] frames = Frame.getFrames();
                for (Frame f : frames) {
                    if (f.getClass().getName().equals("de.neemann.digital.gui.Main")) {
                        mainFrame = f;
                        break;
                    }
                }
                if (mainFrame != null) break;
            }

            if (mainFrame == null) {
                System.err.println("[Launcher] Main frame not found after 60s");
                nativeError("Main frame not found");
                return;
            }

            System.out.println("[Launcher] Main frame found, bridge ready");
            nativeReady();

            // Command loop: block on waitForCommand(), load file, repeat
            while (true) {
                try {
                    String path = waitForCommand();
                    if (path == null || path.isEmpty()) continue;

                    File file = new File(path);
                    // loadFile is private — use getDeclaredMethod + setAccessible
                    java.lang.reflect.Method loadFile = mainFrame.getClass()
                        .getDeclaredMethod("loadFile", File.class, boolean.class, boolean.class);
                    loadFile.setAccessible(true);
                    loadFile.invoke(mainFrame, file, true, false);

                    System.out.println("[Launcher] Loaded: " + path);
                    nativeLoaded();
                } catch (Exception e) {
                    System.err.println("[Launcher] Load failed: " + e);
                    nativeError("Load failed: " + e.getMessage());
                }
            }
        }).start();

        // Launch Digital's Main on this thread
        de.neemann.digital.gui.Main.main(args);
    }
}

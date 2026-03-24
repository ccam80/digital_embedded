#!/bin/bash
# Generate minimal GWT stub classes for compilation.
# Each stub is an empty class/interface with just enough to satisfy javac.

STUB_DIR="$1"
mkdir -p "$STUB_DIR"

# Helper: create a stub Java file
stub() {
    local pkg="$1"
    local name="$2"
    local kind="$3"  # class, interface, enum, abstract
    local extra="$4" # extends/implements clause
    local body="$5"  # extra body content

    local dir="$STUB_DIR/$(echo $pkg | tr '.' '/')"
    mkdir -p "$dir"
    local file="$dir/${name}.java"

    echo "package ${pkg};" > "$file"
    case "$kind" in
        interface)  echo "public interface ${name} ${extra} { ${body} }" >> "$file" ;;
        enum)       echo "public enum ${name} { ${body} }" >> "$file" ;;
        abstract)   echo "public abstract class ${name} ${extra} { ${body} }" >> "$file" ;;
        *)          echo "public class ${name} ${extra} { ${body} }" >> "$file" ;;
    esac
}

# --- com.google.gwt.canvas.dom.client ---
P="com.google.gwt.canvas.dom.client"
# Context2d already exists from gwt-stubs, skip
# CanvasGradient already exists from gwt-stubs, skip

# --- com.google.gwt.canvas.client ---
stub "com.google.gwt.canvas.client" "Canvas" "class" "" \
    "public static Canvas createIfSupported() { return new Canvas(); }
     public com.google.gwt.dom.client.CanvasElement getCanvasElement() { return new com.google.gwt.dom.client.CanvasElement(); }
     public com.google.gwt.canvas.dom.client.Context2d getContext2d() { return new com.google.gwt.canvas.dom.client.Context2d(); }
     public void setWidth(String w) {} public void setHeight(String h) {}
     public void setCoordinateSpaceWidth(int w) {} public void setCoordinateSpaceHeight(int h) {}
     public int getCoordinateSpaceWidth() { return 800; } public int getCoordinateSpaceHeight() { return 600; }"

# --- com.google.gwt.i18n.client ---
# NumberFormat already exists from gwt-stubs
stub "com.google.gwt.i18n.client" "DateTimeFormat" "class" "" \
    "public static DateTimeFormat getFormat(String p) { return new DateTimeFormat(); }
     public String format(java.util.Date d) { return \"\"; }"

# --- com.google.gwt.core.client ---
stub "com.google.gwt.core.client" "EntryPoint" "interface" "" "void onModuleLoad();"
stub "com.google.gwt.core.client" "GWT" "class" "" \
    "public static void log(String s) {} public static String getHostPageBaseURL() { return \"\"; }
     public static String getModuleBaseURL() { return \"\"; }"
stub "com.google.gwt.core.client" "JsArrayInteger" "class" "" \
    "public int get(int i) { return 0; } public int length() { return 0; }"
stub "com.google.gwt.core.client" "JsArrayNumber" "class" "" \
    "public double get(int i) { return 0; } public int length() { return 0; }"
stub "com.google.gwt.core.client" "Scheduler" "class" "" \
    "public static Scheduler get() { return new Scheduler(); }
     public void scheduleDeferred(ScheduledCommand cmd) {}
     public void scheduleFixedDelay(RepeatingCommand cmd, int ms) {}
     public interface ScheduledCommand { void execute(); }
     public interface RepeatingCommand { boolean execute(); }"
stub "com.google.gwt.core.client" "JavaScriptObject" "class" "" ""

# --- com.google.gwt.dom.client ---
stub "com.google.gwt.dom.client" "Element" "class" "" \
    "public String getId() { return \"\"; } public void setId(String s) {}
     public com.google.gwt.dom.client.Style getStyle() { return new com.google.gwt.dom.client.Style(); }"
stub "com.google.gwt.dom.client" "CanvasElement" "class" "extends Element" ""
stub "com.google.gwt.dom.client" "Document" "class" "" \
    "public static Document get() { return new Document(); }
     public Element getElementById(String id) { return new Element(); }
     public Element createElement(String tag) { return new Element(); }"
stub "com.google.gwt.dom.client" "NativeEvent" "class" "" \
    "public int getClientX() { return 0; } public int getClientY() { return 0; }
     public void preventDefault() {} public void stopPropagation() {}"
stub "com.google.gwt.dom.client" "Touch" "class" "" \
    "public int getClientX() { return 0; } public int getClientY() { return 0; }"
stub "com.google.gwt.dom.client" "Style" "class" "" \
    "public void setProperty(String n, String v) {}
     public void setFontWeight(FontWeight fw) {}
     public enum FontWeight { NORMAL, BOLD }
     public enum Unit { PX, EM, PCT }
     public void setWidth(double v, Unit u) {} public void setHeight(double v, Unit u) {}"

# --- com.google.gwt.event.dom.client ---
EP="com.google.gwt.event.dom.client"
for evt in Click DoubleClick MouseDown MouseUp MouseMove MouseOver MouseOut MouseWheel \
           Change ContextMenu TouchStart TouchEnd TouchMove TouchCancel; do
    stub "$EP" "${evt}Event" "class" "extends com.google.gwt.event.shared.GwtEvent" ""
    stub "$EP" "${evt}Handler" "interface" "" "void on${evt}(${evt}Event event);"
done

# --- com.google.gwt.event.logical.shared ---
EL="com.google.gwt.event.logical.shared"
stub "$EL" "ResizeEvent" "class" "extends com.google.gwt.event.shared.GwtEvent" ""
stub "$EL" "ResizeHandler" "interface" "" "void onResize(ResizeEvent event);"
stub "$EL" "CloseEvent" "class" "extends com.google.gwt.event.shared.GwtEvent" \
    "public Object getTarget() { return null; }"
stub "$EL" "CloseHandler" "interface" "" "void onClose(CloseEvent event);"
stub "$EL" "ValueChangeEvent" "class" "extends com.google.gwt.event.shared.GwtEvent" \
    "public Object getValue() { return null; }"
stub "$EL" "ValueChangeHandler" "interface" "" "void onValueChange(ValueChangeEvent event);"

# --- com.google.gwt.event.shared ---
stub "com.google.gwt.event.shared" "GwtEvent" "class" "" ""

# --- com.google.gwt.user.client ---
UC="com.google.gwt.user.client"
stub "$UC" "Command" "interface" "" "void execute();"
stub "$UC" "Timer" "abstract" "" \
    "public abstract void run();
     public void schedule(int ms) {} public void scheduleRepeating(int ms) {} public void cancel() {}"
stub "$UC" "Window" "class" "" \
    "public static String prompt(String msg, String val) { return val; }
     public static void alert(String msg) {} public static boolean confirm(String msg) { return false; }
     public static int getClientWidth() { return 800; } public static int getClientHeight() { return 600; }
     public static void open(String url, String name, String features) {}
     public static void setTitle(String t) {}
     public static class Location { public static String getParameter(String n) { return null; }
       public static String getHref() { return \"\"; } public static String getQueryString() { return \"\"; } }
     public static class Navigator { public static String getUserAgent() { return \"\"; } }
     public static class ClosingEvent { public void setMessage(String m) {} }
     public static void addResizeHandler(com.google.gwt.event.logical.shared.ResizeHandler h) {}
     public static void addWindowClosingHandler(Object h) {}"
stub "$UC" "Event" "class" "" \
    "public static final int ONCLICK = 1;
     public static void addNativePreviewHandler(NativePreviewHandler h) {}
     public interface NativePreviewHandler { void onPreviewNativeEvent(NativePreviewEvent e); }
     public static class NativePreviewEvent { public com.google.gwt.dom.client.NativeEvent getNativeEvent() { return new com.google.gwt.dom.client.NativeEvent(); } public void cancel() {} }"

# --- com.google.gwt.user.client.ui ---
UI="com.google.gwt.user.client.ui"
stub "$UI" "Widget" "class" "" \
    "public com.google.gwt.dom.client.Element getElement() { return new com.google.gwt.dom.client.Element(); }
     public void setWidth(String w) {} public void setHeight(String h) {}
     public void setVisible(boolean v) {} public void addStyleName(String s) {}"
stub "$UI" "FocusWidget" "class" "extends Widget" ""
stub "$UI" "Composite" "class" "extends Widget" ""
stub "$UI" "Panel" "class" "extends Widget" \
    "public void add(Widget w) {} public void clear() {}"
stub "$UI" "CellPanel" "class" "extends Panel" ""
stub "$UI" "FlowPanel" "class" "extends Panel" ""
stub "$UI" "VerticalPanel" "class" "extends CellPanel" ""
stub "$UI" "HorizontalPanel" "class" "extends CellPanel" ""
stub "$UI" "DockLayoutPanel" "class" "extends Panel" \
    "public DockLayoutPanel(com.google.gwt.dom.client.Style.Unit u) {}"
stub "$UI" "PopupPanel" "class" "extends Panel" \
    "public PopupPanel() {} public PopupPanel(boolean b) {}
     public void show() {} public void hide() {} public void center() {}
     public void setPopupPosition(int x, int y) {}"
stub "$UI" "DialogBox" "class" "extends PopupPanel" \
    "public void setText(String t) {}"
stub "$UI" "Label" "class" "extends Widget" \
    "public Label() {} public Label(String t) {} public void setText(String t) {} public String getText() { return \"\"; }"
stub "$UI" "HTML" "class" "extends Label" \
    "public HTML() {} public HTML(String h) {} public void setHTML(String h) {}"
stub "$UI" "Button" "class" "extends FocusWidget" \
    "public Button() {} public Button(String t) {} public Button(String t, com.google.gwt.event.dom.client.ClickHandler h) {}
     public void setText(String t) {}"
stub "$UI" "TextBox" "class" "extends FocusWidget" \
    "public String getText() { return \"\"; } public void setText(String t) {}
     public String getValue() { return \"\"; } public void setValue(String v) {}
     public void setVisibleLength(int n) {}"
stub "$UI" "TextArea" "class" "extends TextBox" \
    "public void setCharacterWidth(int w) {} public void setVisibleLines(int n) {}"
stub "$UI" "CheckBox" "class" "extends FocusWidget" \
    "public CheckBox() {} public CheckBox(String s) {}
     public boolean getValue() { return false; } public void setValue(boolean v) {}
     public boolean isChecked() { return false; }"
stub "$UI" "RadioButton" "class" "extends CheckBox" \
    "public RadioButton(String group) {} public RadioButton(String group, String label) {}"
stub "$UI" "ListBox" "class" "extends FocusWidget" \
    "public void addItem(String s) {} public void setSelectedIndex(int i) {}
     public int getSelectedIndex() { return 0; } public String getValue(int i) { return \"\"; }
     public int getItemCount() { return 0; } public void clear() {}"
stub "$UI" "Anchor" "class" "extends FocusWidget" \
    "public Anchor() {} public Anchor(String t) {} public void setHref(String h) {} public void setTarget(String t) {}"
stub "$UI" "FileUpload" "class" "extends Widget" \
    "public FileUpload() {} public com.google.gwt.dom.client.Element getElement() { return new com.google.gwt.dom.client.Element(); }"
stub "$UI" "MenuBar" "class" "extends Widget" \
    "public MenuBar() {} public MenuBar(boolean vertical) {}
     public MenuItem addItem(String t, Command c) { return new MenuItem(t, c); }
     public MenuItem addItem(MenuItem mi) { return mi; }
     public void addSeparator() {} public void clearItems() {}"
stub "$UI" "MenuItem" "class" "" \
    "public MenuItem(String t, Command c) {} public MenuItem(String t, MenuBar sub) {}
     public void setScheduledCommand(Command c) {}
     public void setHTML(String h) {} public String getHTML() { return \"\"; }
     public void setEnabled(boolean e) {}"
stub "$UI" "RootPanel" "class" "extends Panel" \
    "public static RootPanel get() { return new RootPanel(); }
     public static RootPanel get(String id) { return new RootPanel(); }"
stub "$UI" "RootLayoutPanel" "class" "extends Panel" \
    "public static RootLayoutPanel get() { return new RootLayoutPanel(); }"
stub "$UI" "ScrollPanel" "class" "extends Panel" ""
stub "$UI" "FlexTable" "class" "extends Widget" \
    "public void setWidget(int r, int c, Widget w) {} public void setText(int r, int c, String t) {}
     public int getRowCount() { return 0; } public void removeRow(int r) {}"
stub "$UI" "Grid" "class" "extends Widget" ""
stub "$UI" "Frame" "class" "extends Widget" "" "public Frame(String url) {}"
stub "$UI" "RichTextArea" "class" "extends Widget" ""
stub "$UI" "HasHorizontalAlignment" "interface" "" \
    "public static final HorizontalAlignmentConstant ALIGN_LEFT = null;
     public static final HorizontalAlignmentConstant ALIGN_CENTER = null;
     public static final HorizontalAlignmentConstant ALIGN_RIGHT = null;
     public interface HorizontalAlignmentConstant {}"
stub "$UI" "HasVerticalAlignment" "interface" "" ""

# --- com.google.gwt.http.client ---
HP="com.google.gwt.http.client"
stub "$HP" "Request" "class" "" ""
stub "$HP" "RequestBuilder" "class" "" \
    "public enum Method { GET, POST }
     public RequestBuilder(Method m, String url) {}
     public void setHeader(String n, String v) {}
     public Request sendRequest(String data, RequestCallback cb) throws RequestException { return new Request(); }"
stub "$HP" "RequestCallback" "interface" "" \
    "void onResponseReceived(Request req, Response resp); void onError(Request req, Throwable ex);"
stub "$HP" "RequestException" "class" "extends Exception" ""
stub "$HP" "Response" "class" "" \
    "public int getStatusCode() { return 200; } public String getText() { return \"\"; }"
stub "$HP" "URL" "class" "" \
    "public static String encodeQueryString(String s) { return s; }
     public static String decodeQueryString(String s) { return s; }"

# --- com.google.gwt.storage.client ---
stub "com.google.gwt.storage.client" "Storage" "class" "" \
    "public static Storage getLocalStorageIfSupported() { return new Storage(); }
     public String getItem(String key) { return null; }
     public void setItem(String key, String val) {}
     public void removeItem(String key) {}"

# --- com.google.gwt.safehtml.shared ---
stub "com.google.gwt.safehtml.shared" "SafeHtml" "interface" "" "String asString();"
stub "com.google.gwt.safehtml.shared" "SafeHtmlUtils" "class" "" \
    "public static SafeHtml fromString(String s) { return new SafeHtml() { public String asString() { return s; } }; }
     public static SafeHtml fromTrustedString(String s) { return fromString(s); }"

echo "Generated GWT stubs in $STUB_DIR"

# Page snapshot

```yaml
- generic [ref=e2]:
  - menubar [ref=e3]:
    - menuitem "File" [ref=e4] [cursor=pointer]: File ▶ ▶
    - menuitem "Edit" [ref=e5] [cursor=pointer]
    - generic [ref=e6] [cursor=pointer]: View
    - menuitem "Insert" [ref=e7] [cursor=pointer]
    - menuitem "Simulation" [ref=e8] [cursor=pointer]
    - generic [ref=e9] [cursor=pointer]: Analysis
    - generic [ref=e10] [cursor=pointer]: Tutorials
    - textbox "Circuit name" [ref=e11]: Untitled
    - generic [ref=e12]:
      - button "↶" [disabled] [ref=e13]
      - button "↷" [disabled] [ref=e14]
      - button "⧉" [ref=e15] [cursor=pointer]
      - button "▶" [ref=e17] [cursor=pointer]
      - button "⏵" [ref=e18] [cursor=pointer]
      - 'textbox "Step to sim-time offset (SI suffixes: s, m=ms, u=µs, n=ns)" [ref=e19]':
        - /placeholder: e.g. 5m, 100u
        - text: 1m
      - button "▶▶" [ref=e20] [cursor=pointer]
      - button "■" [ref=e21] [cursor=pointer]
      - button "−" [ref=e22] [cursor=pointer]
      - textbox "Steps per second" [ref=e23]: "1000"
      - button "+" [ref=e24] [cursor=pointer]
      - generic [ref=e25]: steps/s
      - button "Toggle light/dark mode" [active] [ref=e27] [cursor=pointer]: ☾
  - generic [ref=e28]:
    - generic [ref=e29]:
      - generic [ref=e30]: Components
      - tree
      - button "‹" [ref=e31] [cursor=pointer]
    - generic "Drag to resize palette" [ref=e32]
    - generic "Circuit editor canvas" [ref=e34]
  - generic [ref=e35]:
    - generic [ref=e36]: Ready
    - button "100%" [ref=e38] [cursor=pointer]
```
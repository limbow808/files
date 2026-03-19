#!/usr/bin/env python3
"""Patch global.css with the new visual identity tokens."""
import re

css = open('src/styles/global.css', encoding='utf-8').read()

# ── Locate the header comment + root block ────────────────────────────────────
# The block we want to REPLACE starts with the Google Fonts comment and ends
# after the closing brace of :root { ... }
start_marker = '/* \u2500\u2500 Google Fonts loaded via index.html'
end_marker = "  --mono:    'Share Tech Mono', monospace;\n}"

idx_start = css.index(start_marker)
idx_end   = css.index(end_marker) + len(end_marker)
old_block = css[idx_start:idx_end]

new_block = (
    "/* \u2500\u2500 Space Grotesk \u2014 local variable font \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n"
    "@font-face {\n"
    "  font-family: 'Space Grotesk';\n"
    "  src: url('../../fonts/Space_Grotesk/SpaceGrotesk-VariableFont_wght.ttf') format('truetype');\n"
    "  font-weight: 100 900;\n"
    "  font-style: normal;\n"
    "  font-display: swap;\n"
    "}\n"
    "\n"
    "/* \u2500\u2500 Design tokens \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n"
    ":root {\n"
    "  --bg:      #0d0d0d;\n"
    "  --bg2:     #121212;\n"
    "  --text:    #E0E0E0;\n"
    "  --text2:   #B0B0B0;\n"
    "  --accent:  #ff4700;\n"
    "  --border:  #444444;\n"
    "  --border2: #B0B0B0;\n"
    "  --dim:     #B0B0B0;\n"
    "  --green:   #4cff91;\n"
    "  --blue:    #4da6ff;\n"
    "  --mono:    'Space Grotesk', sans-serif;\n"
    "}"
)
css = css[:idx_start] + new_block + css[idx_end:]
print('root replaced OK')

# ── Update html/body font-family to Space Grotesk ────────────────────────────
css = css.replace("  font-family: var(--mono);\n  font-size: 13px;\n}", "  font-family: var(--mono);\n  font-size: 13px;\n  font-weight: 400;\n  -webkit-font-smoothing: antialiased;\n}", 1)

# ── Update button styles ──────────────────────────────────────────────────────
old_btn = (
    "/* \u2500\u2500 Buttons \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n"
    ".btn {\n"
    "  font-family: var(--mono);\n"
    "  font-size: 12px;\n"
    "  letter-spacing: 2px;\n"
    "  font-weight: 600;\n"
    "  text-transform: uppercase;\n"
    "  background: transparent;\n"
    "  border: 1px solid var(--border);\n"
    "  color: var(--text);\n"
    "  padding: 6px 16px;\n"
    "  cursor: pointer;\n"
    "  transition: background 0.15s, border-color 0.15s, color 0.15s;\n"
    "}\n"
    ".btn:hover  { border-color: var(--text); color: #000; background: var(--text); }\n"
    ".btn:active { background: #aaa; border-color: #aaa; color: #000; }\n"
    ".btn:disabled { opacity: 0.3; cursor: not-allowed; }\n"
    ".btn.btn-primary { border-color: var(--accent); background: var(--accent); color: #000; }\n"
    ".btn.btn-primary:hover { background: var(--text); border-color: var(--text); color: #000; }"
)
new_btn = (
    "/* \u2500\u2500 Buttons \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n"
    ".btn {\n"
    "  font-family: var(--mono);\n"
    "  font-size: 11px;\n"
    "  letter-spacing: 2px;\n"
    "  font-weight: 600;\n"
    "  text-transform: uppercase;\n"
    "  background: transparent;\n"
    "  border: 1px solid var(--border2);\n"
    "  color: var(--text2);\n"
    "  padding: 5px 14px;\n"
    "  cursor: pointer;\n"
    "  transition: border-color 0.12s, color 0.12s;\n"
    "  position: relative;\n"
    "  overflow: hidden;\n"
    "}\n"
    ".btn:hover  {\n"
    "  border-color: #E0E0E0;\n"
    "  color: #E0E0E0;\n"
    "  animation: crestBtnGlitch 0.18s steps(2) 1;\n"
    "}\n"
    ".btn:active { opacity: 0.7; }\n"
    ".btn:disabled { opacity: 0.3; cursor: not-allowed; }\n"
    ".btn.btn-primary {\n"
    "  border-color: var(--accent);\n"
    "  color: #000;\n"
    "  background: var(--accent);\n"
    "}\n"
    ".btn.btn-primary:hover {\n"
    "  border-color: #E0E0E0;\n"
    "  background: #E0E0E0;\n"
    "  color: #000;\n"
    "  animation: crestBtnGlitch 0.18s steps(2) 1;\n"
    "}"
)
if old_btn in css:
    css = css.replace(old_btn, new_btn, 1)
    print('btn replaced OK')
else:
    print('btn NOT FOUND — searching...')
    idx = css.find('.btn {')
    print(repr(css[idx-80:idx+120]))

# ── Update nav-bar + nav-tab ──────────────────────────────────────────────────
old_nav = (
    "/* \u2500\u2500 Nav bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n"
    ".nav-bar {\n"
    "  display: flex;\n"
    "  align-items: stretch;\n"
    "  background: transparent;\n"
    "}\n"
    ".nav-tab {\n"
    "  font-family: var(--mono);\n"
    "  font-size: 11px;\n"
    "  letter-spacing: 2px;\n"
    "  text-transform: uppercase;\n"
    "  padding: 0 20px;\n"
    "  background: transparent;\n"
    "  border: none;\n"
    "  border-right: 1px solid var(--border);\n"
    "  border-bottom: none;\n"
    "  color: var(--dim);\n"
    "  cursor: pointer;\n"
    "  transition: color 0.15s, background 0.15s;\n"
    "}\n"
    ".nav-tab:hover { color: var(--text); }\n"
    ".nav-tab.active { color: #000; background: var(--accent); }\n"
    ".nav-tab.active:hover { background: var(--text); color: #000; }"
)
new_nav = (
    "/* \u2500\u2500 Nav bar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n"
    ".nav-bar {\n"
    "  display: flex;\n"
    "  align-items: stretch;\n"
    "  background: transparent;\n"
    "}\n"
    ".nav-tab {\n"
    "  font-family: var(--mono);\n"
    "  font-size: 11px;\n"
    "  letter-spacing: 2.5px;\n"
    "  text-transform: uppercase;\n"
    "  font-weight: 500;\n"
    "  padding: 0 22px;\n"
    "  background: transparent;\n"
    "  border: none;\n"
    "  border-right: 1px solid var(--border);\n"
    "  border-bottom: none;\n"
    "  color: var(--dim);\n"
    "  cursor: pointer;\n"
    "  transition: color 0.12s, transform 0.12s;\n"
    "  position: relative;\n"
    "  white-space: nowrap;\n"
    "}\n"
    ".nav-tab:hover { color: var(--text); }\n"
    "/* Active tab: shifts right + small square marker to the left */\n"
    ".nav-tab.active {\n"
    "  color: #000;\n"
    "  background: var(--accent);\n"
    "  transform: translateX(3px);\n"
    "  z-index: 1;\n"
    "}\n"
    ".nav-tab.active::before {\n"
    "  content: '';\n"
    "  position: absolute;\n"
    "  left: -8px;\n"
    "  top: 50%;\n"
    "  transform: translateY(-50%);\n"
    "  width: 5px;\n"
    "  height: 14px;\n"
    "  background: var(--accent);\n"
    "}\n"
    ".nav-tab.active:hover { background: #E0E0E0; color: #000; }\n"
    ".nav-tab.active:hover::before { background: #E0E0E0; }"
)
if old_nav in css:
    css = css.replace(old_nav, new_nav, 1)
    print('nav replaced OK')
else:
    print('nav NOT FOUND')

# ── Update tab-btn (panel sub-tabs) ──────────────────────────────────────────
old_tab = (
    "/* \u2500\u2500 Panel tab buttons (Sell/Buy, Minerals/Ores, etc.) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n"
    ".tab-btn {\n"
    "  font-family: var(--mono);\n"
    "  font-size: 11px;\n"
    "  letter-spacing: 1.5px;\n"
    "  text-transform: uppercase;\n"
    "  padding: 5px 14px;\n"
    "  background: none;\n"
    "  border: none;\n"
    "  border-bottom: none;\n"
    "  color: var(--dim);\n"
    "  cursor: pointer;\n"
    "  transition: color 0.12s, background 0.12s;\n"
    "}\n"
    ".tab-btn:hover { color: var(--text); background: rgba(200,200,183,0.06); }\n"
    ".tab-btn.active { background: var(--accent); color: #000; }\n"
    ".tab-btn.active:hover { background: var(--text); color: #000; }"
)
new_tab = (
    "/* \u2500\u2500 Panel tab buttons (Sell/Buy, Minerals/Ores, etc.) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500 */\n"
    ".tab-btn {\n"
    "  font-family: var(--mono);\n"
    "  font-size: 11px;\n"
    "  letter-spacing: 1.5px;\n"
    "  text-transform: uppercase;\n"
    "  font-weight: 500;\n"
    "  padding: 5px 14px;\n"
    "  background: none;\n"
    "  border: none;\n"
    "  border-bottom: none;\n"
    "  color: #B0B0B0;\n"
    "  cursor: pointer;\n"
    "  transition: color 0.12s, border-color 0.12s;\n"
    "}\n"
    ".tab-btn:hover { color: var(--text); }\n"
    ".tab-btn.active {\n"
    "  color: #E0E0E0;\n"
    "  border-bottom: 2px solid var(--accent);\n"
    "  padding-bottom: 3px;\n"
    "}\n"
    ".tab-btn.active:hover { color: #E0E0E0; }"
)
if old_tab in css:
    css = css.replace(old_tab, new_tab, 1)
    print('tab-btn replaced OK')
else:
    print('tab-btn NOT FOUND')

open('src/styles/global.css', 'w', encoding='utf-8').write(css)
print('global.css written OK')

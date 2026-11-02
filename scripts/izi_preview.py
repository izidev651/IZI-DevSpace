# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
"""Drive a built IZI DevSpace via Marionette: run UI checks and take screenshots.

Usage: python3 scripts/izi_preview.py OUT_DIR   (browser already started with --marionette)
"""
import base64, json, os, sys, time
from marionette_driver.marionette import Marionette

OUT = sys.argv[1]
os.makedirs(OUT, exist_ok=True)
results = []

def check(name, ok, detail=""):
    results.append({"check": name, "ok": bool(ok), "detail": detail})
    print(("PASS " if ok else "FAIL ") + name, detail)

client = Marionette(host="127.0.0.1", port=2828, startup_timeout=120)
client.start_session()
client.set_context(client.CONTEXT_CHROME)
client.timeout.script = 60
try:
    client.set_window_rect(x=0, y=0, width=1440, height=900)
except Exception as e:
    print("could not resize window:", e)

def js(src, args=None):
    return client.execute_script(src, script_args=args or [], new_sandbox=False)

def ajs(src, args=None):
    return client.execute_async_script(src, script_args=args or [], new_sandbox=False)

def shot(name):
    png = client.screenshot(format="base64", full=False)
    with open(os.path.join(OUT, f"{name}.png"), "wb") as f:
        f.write(base64.b64decode(png))
    print("shot", name)

def wait_for(expr, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if js(f"return !!({expr});"):
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False

def run_steps():
    global state, state2
    check("IZI UI initialised", wait_for("document.documentElement.hasAttribute('izi-devspace')", 60))
    time.sleep(2)
    shot("00-boot")
    state = js("""
      const ui = window.gIZIDevSpaceUI;
      if (!ui) return { strip: !!document.getElementById('izi-strip'), spaces: [], groups: [], widgets: [], missing: 'gIZIDevSpaceUI' };
      return {
        strip: !!document.getElementById('izi-strip'),
        spaces: ui.spaces.map(s => s.name),
        groups: ui.groupsOf(ui.activeSpaceId).map(g => g.name),
        activeSpace: ui.activeSpaceId,
        widgets: ['izi-devtools-button','izi-mobile-button','screenshot-button','developer-button','izi-dock-button','izi-sleep-button']
          .map(id => [id, !!document.getElementById(id)]),
        vertical: Services.prefs.getBoolPref('zen.tabs.vertical'),
        stage: ui.stage, errors: ui.errors,
        tabstrip: !!document.getElementById('izi-tabstrip'),
        sidebarHidden: getComputedStyle(document.getElementById('navigator-toolbox')).display === 'none',
        winControls: !!document.getElementById('izi-win-controls') || AppConstants.platform == 'macosx',
        backInNavbar: !!document.querySelector('#nav-bar #back-button'),
        title: document.title,
      };
    """)
    print(json.dumps(state, indent=2))
    check("strip present", state["strip"])
    check("Personal + Work spaces", {"Personal", "Work"} <= set(state["spaces"]), state["spaces"])
    check("toolbar widgets present", all(v for _, v in state["widgets"]), state["widgets"])
    check("init reached ready", state.get("stage") == "ready" and not state.get("errors"), [state.get("stage"), state.get("errors")])
    check("horizontal tab strip present", state.get("tabstrip"))
    check("Zen vertical sidebar hidden", state.get("sidebarHidden"))
    check("window controls present", state.get("winControls"))
    check("back button in nav-bar", state.get("backInNavbar"))
    shot("01-start")

    # Open a few pages (local data: URLs, no network needed)
    js("""
      const page = (t, c) => 'data:text/html,' + encodeURIComponent(`<title>${t}</title><body style="margin:0;font-family:sans-serif"><header style="background:${c};color:#fff;padding:18px;font-size:24px">${t}</header><form style="padding:20px;display:grid;gap:10px;max-width:420px"><input name=fullname placeholder="Full name"><input type=email name=email placeholder=Email><input type=tel name=phone placeholder=Phone><textarea name=bio></textarea><button>Send</button></form></body>`);
      gBrowser.addTrustedTab(page('Demo Shop', '#ff6b35'), { inBackground: false });
      gBrowser.addTrustedTab(page('Docs', '#3b82f6'), { inBackground: true });
    """)
    time.sleep(3)
    n = js("return [document.querySelectorAll('#izi-tabs .izi-tab').length, window.gIZIDevSpaceUI.stripTabs.length];")
    check("tab strip mirrors the Group's tabs", n[0] >= 2 and n[0] <= n[1], n)
    shot("02-tabs")

    # DevTools
    js("window.gIZIDevSpaceUI['_cmd_izi-devtools-button']?.()")
    ok = wait_for("document.querySelector('.devtools-toolbox-bottom-iframe, .devtools-toolbox-side-iframe, browser[src*=\"toolbox\"], iframe[src*=\"toolbox\"]')", 20)
    check("DevTools button opens toolbox", ok)
    time.sleep(2)
    shot("03-devtools")
    js("window.gIZIDevSpaceUI['_cmd_izi-devtools-button']?.()")
    time.sleep(2)

    # Mobile view (Responsive Design Mode)
    js("window.gIZIDevSpaceUI['_cmd_izi-mobile-button']?.()")
    ok = wait_for("gBrowser.selectedTab.linkedBrowser.closest('.rdm-toolbox, [class*=rdm]') || document.querySelector('.rdm-toolbar, .rdm-toolbox, browser.rdm-toolbar')", 20)
    check("Mobile button opens Responsive Design Mode", ok)
    time.sleep(2)
    shot("04-mobile")
    js("window.gIZIDevSpaceUI['_cmd_izi-mobile-button']?.()")
    time.sleep(2)

    # Dock (split view) with the second tab
    ok = js("""
      const tabs = gBrowser.visibleTabs.filter(t => !t.hasAttribute('zen-empty-tab'));
      const cur = gBrowser.selectedTab; const other = tabs.find(t => t !== cur);
      if (!other) return false;
      gZenViewSplitter.splitTabs([cur, other], 'vsep', 0); return true;
    """)
    time.sleep(3)
    check("Dock creates split view", ok and js("return gBrowser.selectedTab.hasAttribute('split-view');"))
    shot("05-dock")
    js("gZenViewSplitter.unsplitCurrentView();")
    time.sleep(1)

    # Sleep tab
    before = js("return gBrowser.tabs.filter(t => t.hasAttribute('pending')).length;")
    ajs("const done = arguments[arguments.length-1]; window.gIZIDevSpaceUI.sleepTab().then(() => done(true), e => done(String(e)));")
    time.sleep(2)
    after = js("return gBrowser.tabs.filter(t => t.hasAttribute('pending')).length;")
    check("Sleep unloads the tab", after > before, f"pending {before} -> {after}")

    # Add group + add space
    ajs("const done = arguments[arguments.length-1]; const ui = window.gIZIDevSpaceUI; ui.createGroup(ui.activeSpaceId, 'Docs').then(() => done(true), e => done(String(e)));")
    time.sleep(3)
    groups = js("const ui = window.gIZIDevSpaceUI; return ui.groupsOf(ui.activeSpaceId).map(g => g.name);")
    check("Add Group creates a group in the active Space", "Docs" in groups, groups)
    shot("06-new-group")

    ajs("""const done = arguments[arguments.length-1];
      const ui = window.gIZIDevSpaceUI;
      const id = ContextualIdentityService.create('Research', 'circle', 'purple').userContextId;
      ui.createGroup(id, 'Main').then(() => done(true), e => done(String(e)));""")
    time.sleep(3)
    state2 = js("const ui = window.gIZIDevSpaceUI; return { spaces: ui.spaces.map(s => s.name), active: ui.spaces.find(s => s.id === ui.activeSpaceId)?.name, groups: ui.groupsOf(ui.activeSpaceId).map(g => g.name) };")
    check("Add Space creates a space and switches to it", state2["active"] == "Research", state2)
    js("try { gURLBar.view.close(); gURLBar.blur(); } catch (e) {}")
    time.sleep(1)
    nt = js("const el = document.getElementById('izi-newtab'); return { shown: !!el && getComputedStyle(el).display !== 'none', empty: document.documentElement.getAttribute('zen-has-empty-tab'), w: el?.getBoundingClientRect().width };")
    check("New Tab waves shown on the empty tab", nt.get("shown") and (nt.get("w") or 0) > 200, nt)
    shot("07-new-space")

    # Back to Personal, then light theme
    ajs("const done = arguments[arguments.length-1]; const ui = window.gIZIDevSpaceUI; const p = ui.spaces.find(s => s.name === 'Personal'); ui.activateSpace(p.id).then(() => done(true), e => done(String(e)));")
    time.sleep(2)
    js("Services.prefs.setIntPref('zen.view.window.scheme', 1);")
    time.sleep(2)
    shot("08-light")
    js("Services.prefs.setIntPref('zen.view.window.scheme', 0);")
    time.sleep(1)


state, state2 = {}, {}
try:
    run_steps()
except Exception as e:
    import traceback
    traceback.print_exc()
    check("preview script completed", False, repr(e))
    try:
        shot("99-error")
    except Exception:
        pass

try:
    errors = js("""
  const msgs = Services.console.getMessageArray() || [];
  return msgs.map(m => m.message || String(m)).filter(t => /IZI|izi-devspace|IZIDevSpace/.test(t)).slice(-30);
""")
except Exception as e:
    errors = [repr(e)]
with open(os.path.join(OUT, "results.json"), "w") as f:
    json.dump({"state": state, "state2": state2, "results": results, "izi_console": errors}, f, indent=2)
client.delete_session()
failed = [r for r in results if not r["ok"]]
print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")

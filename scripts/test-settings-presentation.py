"""Exact Settings renderer in Chromium, with read-only synthetic bridge responses."""
import json
import os
import sys
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from playwright.sync_api import sync_playwright

HTML=Path(sys.argv.pop(1)).read_bytes()
SETTINGS=dict(ok=True,data=dict(
    capabilities=dict(managedAccountConnect=dict(enabled=False,reason="Fixture: unavailable")),
    inferenceRemovable=False,
))
UNAVAILABLE=dict(ok=False,error="Could not read")
LOG="C:\\Users\\example\\AppData\\Roaming\\BeeZilla\\logs\\main.log"

class SettingsPresentation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self):
                if self.path!="/buzzy/settings":
                    self.send_error(404); return
                self.send_response(200); self.send_header("Content-Type","text/html; charset=utf-8")
                self.send_header("Content-Length",str(len(HTML))); self.end_headers(); self.wfile.write(HTML)
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        cls.thread=Thread(target=cls.server.serve_forever,daemon=True); cls.thread.start()
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(executable_path=os.environ.get("SKETCH_BROWSER"))
        print("Chromium",cls.browser.version,flush=True)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def start(self,responses=(),*,logs=None,width=1000,copy=None):
        p=self.browser.new_page(viewport=dict(width=width,height=820))
        self.addCleanup(p.context.close)
        p.set_default_timeout(3000)
        origin="http://127.0.0.1:%d"%self.server.server_port
        p.route("**/*",lambda r:r.continue_() if r.request.url.startswith(origin+"/") else r.abort())
        if responses or logs is not None:
            p.add_init_script("""(() => {
              const results = %s, logs = %s, copy = %s;
              window.readCount=0; window.logReadCount=0;
              const unexpected=()=>{throw Error("A protected operation is forbidden in this read-only test");};
              window.beezilla={settings:{
                get:async()=>results[window.readCount++],
                connectManaged:unexpected, setInference:unexpected, clearInference:unexpected,
                setSearch:unexpected, clearSearch:unexpected, setMusic:unexpected, clearMusic:unexpected
              }};
              if(logs!==null) {
                Object.defineProperty(navigator,"mediaDevices",{value:undefined});
                Object.defineProperty(navigator,"permissions",{value:undefined});
                window.beezilla.app={logs:async()=>{
                  window.logReadCount++;
                  if(logs==="fail") throw Error("Read unavailable");
                  return {ok:true,data:{file:logs}};
                }, openLogs:unexpected};
                if(copy) {
                  window.copyAttempts=0; window.copiedDiagnostics=null; window.diagnosticLogs=[];
                  window.beezilla.app.version=()=>{
                    if(copy.version==="throws") throw Error("Version bridge unavailable");
                    if(copy.version==="incomplete") return Promise.resolve({ok:true});
                    return Promise.resolve({ok:true,data:{version:"0.0-fixture"}});
                  };
                  window.beezilla.app.log=async message=>{window.diagnosticLogs.push(message);};
                  Object.defineProperty(navigator,"clipboard",{value:{writeText:async block=>{
                    window.copyAttempts++;
                    if(copy.blocked) throw Error("Clipboard blocked in fixture");
                    window.copiedDiagnostics=block;
                  }}});
                }
              }
            })();"""%(json.dumps(responses),json.dumps(logs),json.dumps(copy)))
        p.goto(origin+"/buzzy/settings")
        return p
    def test_failed_settings_read_has_live_status_for_assistive_technology(self):
        p=self.start([UNAVAILABLE])
        p.get_by_text("Could not read current settings.",exact=True).wait_for()
        self.assertEqual(p.get_by_role("status").filter(has_text="Could not read current settings.").count(),1)
    def test_failed_read_can_retry_from_keyboard_without_closing(self):
        p=self.start([UNAVAILABLE,SETTINGS])
        p.get_by_text("Could not read current settings.",exact=True).wait_for()
        retry=p.get_by_role("button",name="Retry reading settings")
        self.assertEqual(retry.count(),1)
        retry.focus(); p.keyboard.press("Enter")
        p.get_by_text("Fixture: unavailable",exact=True).wait_for()
        self.assertEqual(p.evaluate("window.readCount"),2)
        self.assertTrue(p.locator("#connect-account").is_disabled())
        self.assertEqual(retry.count(),0)
    def test_long_status_log_path_and_existing_controls_stay_inside_phone_viewport(self):
        p=self.start([UNAVAILABLE],logs=LOG*5,width=320)
        p.locator("#logs-path").get_by_text("Log:",exact=False).wait_for()
        p.get_by_text("Could not read current settings.",exact=True).wait_for()
        for selector in ("#save-inference","#clear-inference","#inference-status","#mic-test","#logs-path"):
            r=p.locator(selector).bounding_box(); self.assertTrue(r,selector)
            self.assertLessEqual(r["x"]+r["width"],320,selector)
        self.assertLessEqual(p.evaluate("document.documentElement.scrollWidth"),320)
        self.assertEqual(p.locator("#logs-path").text_content(),"Log: "+LOG*5)
    def test_browser_without_desktop_bridge_does_not_look_credential_editable(self):
        p=self.start()
        p.get_by_text("This page manages app credentials",exact=False).wait_for()
        for selector in ("#provider-byok","#search-key","#music-key"):
            self.assertTrue(p.locator(selector).is_disabled(),selector)
        self.assertTrue(p.locator("#save-inference").is_disabled())
    def test_troubleshooting_explains_when_log_path_cannot_be_read(self):
        p=self.start([SETTINGS],logs="fail")
        p.locator("#open-logs").wait_for(); self.assertEqual(p.evaluate("window.logReadCount"),1)
        self.assertIn("Could not read the log file path.",p.locator("#logs-path").inner_text())
        self.assertTrue(p.locator("#open-logs").is_enabled())

    def test_copy_diagnostics_still_works_when_version_read_throws_or_is_incomplete(self):
        for version in ("throws","incomplete"):
            with self.subTest(version=version):
                p=self.start([SETTINGS],logs=LOG,copy={"version":version})
                p.locator("#mic-copy").click()
                p.locator("#mic-copy-status").get_by_text("Copied.",exact=True).wait_for()
                self.assertEqual(p.evaluate("window.copyAttempts"),1)
                self.assertTrue(p.evaluate("window.copiedDiagnostics").startswith("BeeZilla ?\n"))
    def test_copy_diagnostics_failure_does_not_log_a_success(self):
        p=self.start([SETTINGS],logs=LOG,copy={"version":"valid","blocked":True})
        p.locator("#mic-copy").click()
        p.locator("#mic-copy-status").get_by_text("Copy blocked",exact=False).wait_for()
        self.assertEqual(p.evaluate("window.copyAttempts"),1)
        self.assertIsNone(p.evaluate("window.copiedDiagnostics"))
        self.assertTrue(p.locator("#mic-result").text_content().startswith("BeeZilla 0.0-fixture\n"))
        logs=p.evaluate("window.diagnosticLogs")
        self.assertTrue(any("diagnostics copy blocked" in line for line in logs),logs)
        self.assertFalse(any("diagnostics copied" in line for line in logs),logs)

if __name__=="__main__": unittest.main(verbosity=2)

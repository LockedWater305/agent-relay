"""Isolated Chromium checks of the actual read-only Memory display."""
import json
import os
import sys
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

HTML=Path(sys.argv.pop(1)).read_bytes()
COMPANY_ID="co_fixture9832"
TITLE="Synthetic saved project"
SOURCE=dict(kind="job",id="job_fixture",companyId=COMPANY_ID,title=TITLE)
COMPANIES="""
window.BZCompanies={
    ready:()=>true,
    active:()=>({id:'co_fixture9832',name:'Fixture Company'}),
    onChange:fn=>queueMicrotask(fn)
};
""".encode()

def payload(*, value="Saved decision", title=TITLE, msg="Saved conversation"):
    source=dict(SOURCE,title=title)
    return dict(scope=dict(companyId=COMPANY_ID),honchoAvailable=False,
                facts=[dict(key="decision",value=value,source=source)],
                messages=[dict(role="user",content=msg,source=source)])

class MemoryDisplay(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def reply(self,code,body,mime):
                self.send_response(code); self.send_header("Content-Type",mime)
                self.send_header("Content-Length",str(len(body))); self.end_headers()
                self.wfile.write(body)
            def do_GET(self):
                path=urlsplit(self.path).path
                if path=="/buzzy/memory": self.reply(200,HTML,"text/html; charset=utf-8")
                elif path=="/buzzy/companies.js": self.reply(200,COMPANIES,"text/javascript; charset=utf-8")
                elif path=="/api/auth/get-session": self.reply(200,b'{"user":{"id":"fixture"}}',"application/json")
                elif path=="/api/buzzy/memory":
                    cls.read_queries.append(self.path)
                    self.reply(200,json.dumps(cls.registry).encode(),"application/json")
                else: self.reply(404,b"","text/plain")
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        cls.thread=Thread(target=cls.server.serve_forever,daemon=True); cls.thread.start()
        cls.pw=sync_playwright().start(); cls.browser=cls.pw.chromium.launch(executable_path=os.environ.get("SKETCH_BROWSER"))
        print("Chromium",cls.browser.version,flush=True)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def start(self,data,width=1000):
        type(self).registry=data; type(self).read_queries=[]
        p=self.browser.new_page(viewport=dict(width=width,height=770))
        self.addCleanup(p.context.close)
        origin="http://127.0.0.1:%d"%self.server.server_port
        p.route("**/*",lambda r:r.continue_() if r.request.url.startswith(origin+"/") else r.abort())
        p.goto(origin+"/buzzy/memory")
        p.get_by_role("heading",name="By job or conversation").wait_for()
        self.assertEqual(self.read_queries,["/api/buzzy/memory?companyId="+COMPANY_ID])
        return p
    def test_memory_source_disclosure_exposes_expanded_state_and_its_panel(self):
        p=self.start(payload()); source=p.locator(".mem-job-head"); detail=p.locator(".mem-job-detail")
        self.assertEqual(source.get_attribute("aria-expanded"),"false")
        self.assertEqual(source.get_attribute("aria-controls"),detail.get_attribute("id"))
        self.assertTrue(detail.get_attribute("id"))
        source.focus(); p.keyboard.press("Enter")
        self.assertTrue(detail.is_visible())
        self.assertEqual(source.get_attribute("aria-expanded"),"true")
        p.keyboard.press("Space")
        self.assertFalse(detail.is_visible())
        self.assertEqual(source.get_attribute("aria-expanded"),"false")
    def test_long_title_fact_and_conversation_stay_readable_at_phone_width(self):
        title="written_title_"*18; value="saved_value_"*36; msg="known_conversation_"*25
        p=self.start(payload(title=title,value=value,msg=msg),width=320)
        head=p.locator(".mem-job-head"); counter=head.locator(".mj-count")
        r=counter.bounding_box(); card=head.bounding_box()
        self.assertLessEqual(r["x"]+r["width"],card["x"]+card["width"])
        head.click(); p.locator(".mem-conv summary").click()
        self.assertEqual(p.locator(".mem-job-head .mj-title").text_content(),title)
        self.assertEqual(p.locator(".fact .v").inner_text(),value)
        self.assertTrue(msg in p.locator(".msg").inner_text())
        self.assertLessEqual(p.evaluate("document.documentElement.scrollWidth"),320)
    def test_multiline_saved_text_is_readable_and_copyable_without_flattening(self):
        fact="Step one\n  use the shorter path\n\nThen confirm."
        msg="File list:\n  A & B\n\n  C"
        p=self.start(payload(value=fact,msg=msg))
        p.locator(".mem-job-head").click(); p.locator(".mem-conv summary").click()
        self.assertEqual(p.locator(".fact .v").inner_text(),fact)
        self.assertTrue(p.locator(".msg").inner_text().endswith(msg))

if __name__=="__main__": unittest.main(verbosity=2)

"""Browser checks for the exact Capabilities page against loopback read-only registry fixtures."""
import json
import os
import sys
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock, Thread
from urllib.parse import urlsplit
from playwright.sync_api import sync_playwright

HTML = Path(sys.argv.pop(1)).read_bytes()
STAMP = "2026-11-26T04:50:00.000Z"
ITEM = dict(id="fixture", label="Read a document", detail="Reads saved Markdown", ok=True)
TOOL = dict(name="read_document", gate="always", cost="none", timeoutMs=3000, offered=True, withheld=None)

def registry(caps=None, tools=None):
    return dict(ok=True, generatedAt=STAMP,
                capabilities=[ITEM.copy()] if caps is None else caps,
                tools=[TOOL.copy()] if tools is None else tools)

class Capabilities(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def reply(self, status, body, mime):
                self.send_response(status)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                try: self.wfile.write(body)
                except (BrokenPipeError, ConnectionResetError): pass
            def do_GET(self):
                path = urlsplit(self.path).path
                if path == "/buzzy/capabilities":
                    self.reply(200,HTML,"text/html; charset=utf-8")
                elif path == "/api/buzzy/capabilities":
                    with cls.lock:
                        status, data, gate = cls.responses.pop(0)
                        cls.requests += 1
                    if gate: gate.wait(8)
                    self.reply(status,json.dumps(data).encode(),"application/json")
                else:
                    self.reply(404,b"","text/plain")
        cls.lock=Lock()
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),Handler)
        cls.thread=Thread(target=cls.server.serve_forever,daemon=True); cls.thread.start()
        cls.pw=sync_playwright().start()
        cls.browser=cls.pw.chromium.launch(executable_path=os.environ.get("SKETCH_BROWSER"),args=["--disable-dev-shm-usage"])
        print("Chromium",cls.browser.version,flush=True)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def start(self,*responses,width=1000,setup=None):
        type(self).responses=list(responses); type(self).requests=0
        p=self.browser.new_page(viewport=dict(width=width,height=720))
        self.addCleanup(p.context.close)
        if setup: setup(p)
        p.goto("http://127.0.0.1:%d/buzzy/capabilities"%self.server.server_port)
        return p
    def loaded(self,p,text="Read a document"):
        p.locator("#caps").get_by_text(text,exact=True).wait_for()
    def test_registry_http_error_is_not_a_success_and_retry_reloads(self):
        p=self.start((503,dict(error="Unavailable"),None),(200,registry(),None))
        p.wait_for_function("!document.querySelector('#caps').innerText.includes('Loading')")
        self.assertIn("Could not load",p.locator("#caps").inner_text())
        self.assertIn("Could not load",p.locator("#tools").inner_text())
        self.assertNotIn("Generated",p.locator("#stamp").inner_text())
        p.get_by_role("button",name="Retry").click()
        self.loaded(p); self.assertEqual(self.requests,2)
        self.assertTrue(p.get_by_text("Generated "+STAMP,exact=True).is_visible())
    def test_valid_empty_registry_has_explicit_empty_sections(self):
        p=self.start((200,registry([],[]),None))
        p.wait_for_function("document.querySelector('#stamp').textContent.includes('Generated')")
        self.assertEqual(p.locator("#caps").inner_text().strip(),"No capabilities were reported.")
        self.assertEqual(p.locator("#tools").inner_text().strip(),"No tools were reported.")
        self.assertEqual(p.get_by_role("button",name="Retry").count(),0)
    def test_capability_status_is_readable_without_color(self):
        other=dict(ITEM,id="b",label="Read a presentation",detail="Missing configuration",ok=False)
        p=self.start((200,registry([ITEM.copy(),other]),None))
        self.loaded(p)
        good=p.locator(".card").filter(has_text="Read a document")
        bad=p.locator(".card").filter(has_text="Read a presentation")
        self.assertTrue(good.get_by_text("Configured here",exact=True).count())
        self.assertTrue(bad.get_by_text("Not configured here",exact=True).count())
        self.assertEqual(good.locator(".dot").get_attribute("aria-hidden"),"true")
    def test_narrow_view_keeps_capability_cards_and_tool_state_inside_page(self):
        name="long_tool_name_" * 12
        detail="configuration_detail_" * 12
        p=self.start((200,registry([dict(ITEM,detail=detail)],[dict(TOOL,name=name,offered=False,withheld="Not configured")]),None),width=320)
        self.loaded(p)
        state=p.get_by_role("cell",name="withheld — Not configured")
        r=state.bounding_box()
        self.assertEqual(p.get_by_role("cell",name=name).inner_text(),name)
        self.assertLessEqual(r["x"]+r["width"],320)
        self.assertLessEqual(p.evaluate("document.documentElement.scrollWidth"),320)
    def test_registry_literal_text_remains_copyable_exactly_as_reported(self):
        label="Marks &amp; symbols"
        detail="Raw configuration text A & B; literal &lt; and &quot;."
        withheld="Literal &copy; stays literal"
        p=self.start((200,registry([dict(ITEM,label=label,detail=detail)],[dict(TOOL,offered=False,withheld=withheld)]),None))
        p.locator("#caps .card").wait_for()
        self.assertEqual(p.locator(".cap-label").inner_text(),label)
        self.assertEqual(p.locator(".cap-detail").inner_text(),detail)
        self.assertTrue(p.get_by_role("cell",name="withheld — "+withheld,exact=True).is_visible())
    def test_retired_read_cannot_replace_reopened_view_with_stale_status(self):
        old=registry([dict(ITEM,label="Old response",ok=False)],[])
        new=registry([dict(ITEM,label="Current response",ok=True)],[])
        routes=[]
        def respond(route):
            routes.append(route)
            if len(routes)==2: route.fulfill(json=new)
        p=self.start(setup=lambda p:p.route("**/api/buzzy/capabilities",respond))
        # Driving a Playwright wait pumps the pending route callback without
        # completing it. The second request can then settle first.
        p.wait_for_function("document.querySelector('#caps').innerText.includes('Loading')")
        self.assertEqual(len(routes),1)
        # Reproduce the shell's ownership transition with a new DOM page and
        # the same shipped inline bootstrap. Keep the former read pending.
        p.evaluate("""() => {
          const bootstrap = [...document.scripts].find(s=>s.textContent.includes('/api/buzzy/capabilities'));
          const old = document.querySelector('main');
          const replacement = old.cloneNode(true);
          old.replaceWith(replacement);
          const script = document.createElement('script');
          script.textContent = bootstrap.textContent;
          replacement.appendChild(script);
        }""")
        self.loaded(p,"Current response")
        self.assertEqual(len(routes),2)
        routes[0].fulfill(json=old)
        p.wait_for_timeout(120)
        self.assertTrue(p.get_by_text("Current response",exact=True).is_visible())
        self.assertEqual(p.get_by_text("Old response",exact=True).count(),0)

if __name__=="__main__": unittest.main(verbosity=2)

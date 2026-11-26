"""Browser regression tests for the shipped Sketch page, with a disposable in-memory project.
Run: SKETCH_BROWSER=/path/to/chromium python scripts/test-sketch-user-paths.py /path/to/public/buzzy/sketch.html
Requires Playwright (Python); no real account, provider, or remote network is used.
"""
import json, os, sys, unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit
from xml.etree import ElementTree
from playwright.sync_api import sync_playwright
HTML = Path(sys.argv.pop(1)).read_bytes()
LINE = dict(id="road", tool="line", color="#ffff00", width=3, x1=30, y1=50, x2=200, y2=50)

class Sketch(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args): pass
            def reply(self, data, typ="application/json", status=200):
                buf = data if isinstance(data, bytes) else json.dumps(data).encode()
                self.send_response(status); self.send_header("Content-Type", typ); self.send_header("Content-Length", str(len(buf))); self.end_headers(); self.wfile.write(buf)
            def do_GET(self):
                path = urlsplit(self.path).path
                if path == "/buzzy/sketch": self.reply(HTML, "text/html; charset=utf-8")
                elif path == "/api/buzzy/art": self.reply(dict(ok=True, board=cls.board, images=[]))
                elif path == "/api/buzzy/projects/test": self.reply(dict(project=dict(title="Fixture")))
                else: self.reply(b"", "text/plain", 404)
            def do_POST(self):
                data=self.rfile.read(int(self.headers["Content-Length"])); req=json.loads(data)
                if self.path != "/api/buzzy/art" or req["action"] != "save" or req["jobId"] != "test":
                    self.reply({}, status=404); return
                cls.board=req["board"]; cls.last_size=len(data); self.reply(dict(ok=True,saved=True))
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),Handler); cls.thread=Thread(target=cls.server.serve_forever,daemon=True); cls.thread.start()
        cls.pw=sync_playwright().start(); cls.browser=cls.pw.chromium.launch(executable_path=os.environ.get("SKETCH_BROWSER"),args=["--disable-dev-shm-usage"]); print("Chromium", cls.browser.version, flush=True)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def start(self, strokes):
        type(self).board=dict(version=1,strokes=strokes,images=[]); type(self).last_size=0
        page=self.browser.new_page(viewport=dict(width=1050,height=770),device_scale_factor=1)
        self.addCleanup(page.context.close)
        page.goto("http://127.0.0.1:%d/buzzy/sketch?job=test"%self.server.server_port)
        page.wait_for_function("document.querySelector('#status').textContent.startsWith('Board loaded')")
        return page
    def save(self,p):
        p.click("#save")
        p.wait_for_function("document.querySelector('#status').textContent==='Board saved.' || document.querySelector('#savedFlag').textContent.startsWith('Not saved')")
    def hit(self,p,x,y): p.locator("#board").click(position=dict(x=x,y=y))
    def svg(self,p):
        with p.expect_download() as dl: p.click("#svg")
        return ElementTree.fromstring(dl.value.path().read_bytes())
    def test_text_edit_does_not_destroy_selected_mark(self):
        p=self.start([LINE.copy()]); self.hit(p,100,50); p.locator("#prompt").press_sequentially("reed"); p.keyboard.press("Backspace")
        self.save(p)
        self.assertEqual((p.input_value("#prompt"),[s["id"] for s in self.board["strokes"]]), ("ree",["road"]))
        self.hit(p,100,50); p.keyboard.press("Delete"); self.save(p); self.assertEqual(self.board["strokes"],[])
    def test_large_board_saves_through_real_browser_fetch(self):
        old=dict(id="long", tool="pen", color="#eee", width=3, points=[{"x": 10+i%480, "y": 95+i%13} for i in range(5500)])
        p=self.start([old])
        p.click('[data-tool="line"]'); rect=p.locator("#board").bounding_box()
        p.mouse.move(rect["x"]+10,rect["y"]+20); p.mouse.down(); p.mouse.move(rect["x"]+70,rect["y"]+45); p.mouse.up()
        self.save(p); self.assertEqual(p.inner_text("#status"),"Board saved.",p.inner_text("#savedFlag")); self.assertGreater(self.last_size,65536)
        self.assertEqual(self.board["strokes"][0],old); self.assertEqual(len(self.board["strokes"]),2)
        print("Large board POST bytes:",self.last_size,flush=True)
    def test_empty_box_interior_cannot_select_and_delete_outline(self):
        box=dict(id="box",tool="rect",color="#00ccff",width=3,x1=50,y1=50,x2=250,y2=250)
        p=self.start([box]); self.hit(p,150,150); p.keyboard.press("Delete"); self.save(p)
        self.assertEqual([s["id"] for s in self.board["strokes"]],["box"])
        self.hit(p,150,50); p.keyboard.press("Delete"); self.save(p); self.assertEqual(self.board["strokes"],[])
    def test_single_brush_tap_remains_visible_and_selectable_after_reload(self):
        p=self.start([]); p.click('[data-tool="pen"]'); self.hit(p,150,110); self.save(p)
        p.reload(); p.wait_for_function("document.querySelector('#status').textContent.startsWith('Board loaded')")
        pixel=p.eval_on_selector("#board","c=>Array.from(c.getContext('2d').getImageData(150,110,1,1).data)")
        self.assertGreater(pixel[3],150,repr(pixel))
        self.assertGreater(len(self.svg(p).findall("{*}circle")),0)
        with p.expect_download() as dl: p.click("#shot")
        raw_png=dl.value.path().read_bytes()
        import base64
        pngpixel=p.evaluate("""async data=>{const i=new Image();i.src='data:image/png;base64,'+data;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);return [...x.getImageData(150,110,1,1).data]}""",base64.b64encode(raw_png).decode())
        self.assertLess(pngpixel[2],90)
        self.hit(p,150,110); p.keyboard.press("Delete"); self.save(p); self.assertEqual(self.board["strokes"],[])
    def test_visible_end_of_saved_note_can_be_selected_without_a_ghost_hitbox(self):
        # Click on the visible baseline far from the original click anchoring the label.
        note=dict(id="note",tool="text",color="#ff0000",x1=31,y1=50,text="Existing bridge inspection label",anchor="road")
        p=self.start([LINE.copy(), note]); self.hit(p,279,34); p.keyboard.press("Delete"); self.save(p)
        self.assertEqual([s["id"] for s in self.board["strokes"]],["road"])
        # A coordinate well to the left of a free note is not inside its glyphs.
        p=self.start([dict(note,anchor=None,x1=220,y1=100)])
        self.hit(p,155,99); p.keyboard.press("Delete"); self.save(p); self.assertEqual(len(self.board["strokes"]),1)
    def test_advertised_shift_z_redoes_the_undone_mark(self):
        p=self.start([LINE.copy()]); self.hit(p,100,50); p.keyboard.press("Delete"); self.save(p)
        self.assertEqual(self.board["strokes"],[])
        p.keyboard.press("Control+z"); self.save(p); self.assertEqual(len(self.board["strokes"]),1)
        p.keyboard.press("Control+Shift+Z"); self.save(p); self.assertEqual(self.board["strokes"],[])
    def test_selection_outline_preserves_mark_color_and_rect_geometry(self):
        p=self.start([dict(id="box",tool="rect",color="#00ccff",width=3,x1=50,y1=50,x2=250,y2=250)])
        self.hit(p,120,50)
        pix=p.eval_on_selector("#board","c=>[[120,50],[150,150]].map(([x,y])=>[...c.getContext('2d').getImageData(x,y,1,1).data])")
        self.assertEqual(pix[0],[0,204,255,255]); self.assertEqual(pix[1][3],0)
    def test_anchored_note_exports_at_its_visible_position(self):
        note=dict(id="note",tool="text",color="#ff0000",x1=31,y1=50,text="Bridge",anchor="road")
        p=self.start([LINE.copy(),note])
        t=self.svg(p).find("{*}text"); self.assertEqual((t.get("x"),t.get("y")),("115","38"))
        with p.expect_download() as dl: p.click("#shot")
        import base64
        count=p.evaluate("""async data=>{const i=new Image();i.src='data:image/png;base64,'+data;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const x=c.getContext('2d');x.drawImage(i,0,0);const a=x.getImageData(115,20,64,20).data;let n=0;for(let k=0;k<a.length;k+=4) if(a[k]>190 && a[k+1]<90 && a[k+2]<90)n++;return n}""",base64.b64encode(dl.value.path().read_bytes()).decode())
        self.assertGreater(count,10)
if __name__=="__main__": unittest.main(verbosity=2)

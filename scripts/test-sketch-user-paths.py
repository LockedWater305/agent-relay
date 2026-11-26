"""Browser regression tests for the shipped Sketch page, with a disposable in-memory project.
Run: SKETCH_BROWSER=/path/to/chromium python scripts/test-sketch-user-paths.py /path/to/public/buzzy/sketch.html
Requires Playwright (Python); no real account, provider, or remote network is used.
"""
import base64, json, os, struct, sys, time, unittest, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from urllib.parse import urlsplit
from xml.etree import ElementTree
from playwright.sync_api import sync_playwright
HTML = Path(sys.argv.pop(1)).read_bytes()
LIBRARY = None
if len(sys.argv) > 2 and sys.argv[1] == "--library":
    LIBRARY = Path(sys.argv.pop(2)).read_bytes()
    sys.argv.pop(1)
LINE = dict(id="road", tool="line", color="#ffff00", width=3, x1=30, y1=50, x2=200, y2=50)

def solid_png(rgb):
    def chunk(typ, data):
        return struct.pack(">I",len(data))+typ+data+struct.pack(">I",zlib.crc32(typ+data))
    return b"\x89PNG\r\n\x1a\n"+chunk(b"IHDR",struct.pack(">IIBBBBB",8,8,8,2,0,0,0))+chunk(b"IDAT",zlib.compress((b"\0"+bytes(rgb)*8)*8))+chunk(b"IEND", b"")

RED = solid_png((220,20,30))
GREEN = solid_png((20,210,40))
BLUE = solid_png((20,40,220))

def ref(id, **geometry):
    return dict(dict(id=id,url='/assets/'+id+'.png',x=50,y=70,w=150,h=100),**geometry)

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
                elif path == "/buzzy/library" and LIBRARY is not None: self.reply(LIBRARY, "text/html; charset=utf-8")
                elif path == "/api/auth/get-session": self.reply(dict(user=dict(id="fixture")))
                elif path == "/api/buzzy/jobs": self.reply(dict(jobs=[]))
                elif path == "/api/buzzy/assets": self.reply(dict(items=cls.shelf))
                elif path == "/api/buzzy/assets/441": self.reply(BLUE,"image/png")
                elif path == "/api/buzzy/art": self.reply(dict(ok=True, board=cls.board, images=cls.outputs))
                elif path == "/api/buzzy/projects/test": self.reply(dict(project=dict(title="Fixture")))
                elif path == "/assets/front.png": self.reply(GREEN, "image/png")
                elif path == "/assets/rear-slow.png":
                    time.sleep(0.22)
                    self.reply(RED, "image/png")
                elif path == "/assets/blue.png": self.reply(BLUE, "image/png")
                elif path == "/assets/101": self.reply(BLUE, "image/png")
                elif path == "/assets/102": self.reply(RED, "image/png")
                elif path == "/assets/103": self.reply(GREEN, "image/png")
                else: self.reply(b"", "text/plain", 404)
            def do_POST(self):
                data=self.rfile.read(int(self.headers["Content-Length"])); req=json.loads(data)
                if self.path != "/api/buzzy/art" or req["jobId"] != "test":
                    self.reply({}, status=404); return
                if req["action"]=="save":
                    cls.board=req["board"]; cls.last_size=len(data); self.reply(dict(ok=True,saved=True))
                elif req["action"]=="render" and cls.outputs:
                    self.reply(dict(image=dict(url="/assets/102"),ms=100))
                elif req["action"]=="edit" and cls.outputs:
                    cls.edits.append(req)
                    self.reply(dict(image=dict(url="/assets/103"),ms=100))
                else: self.reply({},status=404)
        cls.server=ThreadingHTTPServer(("127.0.0.1",0),Handler); cls.thread=Thread(target=cls.server.serve_forever,daemon=True); cls.thread.start()
        cls.pw=sync_playwright().start(); cls.browser=cls.pw.chromium.launch(executable_path=os.environ.get("SKETCH_BROWSER"),args=["--disable-dev-shm-usage"]); print("Chromium", cls.browser.version, flush=True)
    @classmethod
    def tearDownClass(cls):
        cls.browser.close(); cls.pw.stop(); cls.server.shutdown(); cls.server.server_close(); cls.thread.join()
    def start(self, strokes, images=None, *, outputs=None, touch=False):
        type(self).board=dict(version=1,strokes=strokes,images=images or []); type(self).last_size=0
        type(self).outputs=outputs or []; type(self).edits=[]; type(self).shelf=[]
        page=self.browser.new_page(viewport=dict(width=1050,height=770),device_scale_factor=1,has_touch=touch)
        self.addCleanup(page.context.close)
        page.goto("http://127.0.0.1:%d/buzzy/sketch?job=test"%self.server.server_port)
        page.wait_for_function("document.querySelector('#status').textContent.startsWith('Board loaded')")
        return page
    def save(self,p):
        p.click("#save")
        p.wait_for_function("document.querySelector('#status').textContent==='Board saved.' || document.querySelector('#savedFlag').textContent.startsWith('Not saved')")
    def hit(self,p,x,y):
        r=p.locator("#board").bounding_box()
        p.mouse.click(r["x"]+x,r["y"]+y)
    def drag(self,p,x1,y1,x2,y2):
        r=p.locator("#board").bounding_box()
        p.mouse.move(r["x"]+x1,r["y"]+y1); p.mouse.down()
        p.mouse.move(r["x"]+x2,r["y"]+y2,steps=4); p.mouse.up()
    def png(self,p):
        with p.expect_download() as dl: p.click("#shot")
        return dl.value.path().read_bytes()
    def pixel(self,p,png,x,y):
        data=base64.b64encode(png).decode(); return p.evaluate("""async a=>{
          const i=new Image(); i.src='data:image/png;base64,'+a.data; await i.decode();
          const c=document.createElement('canvas'); c.width=i.width;c.height=i.height;
          const g=c.getContext('2d'); g.drawImage(i,0,0);
          return Array.from(g.getImageData(a.x,a.y,1,1).data);
        }""",dict(data=data,x=x,y=y))
    def screenshot_pixel(self,p,x,y):
        from PIL import Image
        from io import BytesIO
        return list(Image.open(BytesIO(p.locator("#stage").screenshot())).getpixel((x,y)))[:3]
    def test_reference_image_does_not_block_or_hide_drawing(self):
        p=self.start([], [ref("blue")]); p.wait_for_function("document.querySelector('#layers img').naturalWidth===8")
        p.click('[data-tool="line"]'); self.drag(p,90,120,170,120); self.save(p)
        self.assertEqual(len(self.board["strokes"]),1)
        self.assertEqual(self.screenshot_pixel(p,140,120),[255,212,13])
        p.click('[data-tool="select"]'); self.hit(p,140,120); p.keyboard.press("Delete"); self.save(p)
        self.assertEqual(self.board["strokes"],[]); self.assertEqual(len(self.board["images"]),1)
    def test_image_move_and_resize_are_single_undoable_edits(self):
        original=ref("blue"); p=self.start([LINE.copy()], [original])
        self.drag(p,90,140,113,161); self.save(p)
        moved=dict(original,x=73,y=91); self.assertEqual(self.board["images"],[moved])
        p.click("#undo"); self.save(p); self.assertEqual(self.board["images"],[original])
        p.click("#redo"); self.save(p); self.assertEqual(self.board["images"],[moved])
        self.drag(p,223,191,255,205); self.save(p); resized=dict(moved,w=182,h=114)
        self.assertEqual(self.board["images"],[resized])
        p.click("#undo"); self.save(p); self.assertEqual(self.board["images"],[moved])
        p.click("#redo"); self.save(p); self.assertEqual(self.board["images"],[resized])
    def test_png_respects_board_image_order_not_download_completion(self):
        p=self.start([], [ref("rear-slow"),ref("front")])
        raw=self.png(p)
        self.assertEqual(self.pixel(p,raw,140,120),[20,210,40,255])
    def test_png_does_not_hide_a_white_note(self):
        p=self.start([dict(id="n",tool="text",color="#ffffff",x1=100,y1=100,text="White lettering")])
        raw=self.png(p)
        background=self.pixel(p,raw,30,30)
        pixels=p.evaluate("""async data=>{
          const i=new Image();i.src='data:image/png;base64,'+data;await i.decode();
          const c=document.createElement('canvas');c.width=i.width;c.height=i.height;
          const g=c.getContext('2d');g.drawImage(i,0,0);
          const a=g.getImageData(100,85,120,20).data; let n=0;
          for(let k=0;k<a.length;k+=4) if(a[k]>220&&a[k+1]>220&&a[k+2]>220)n++;
          return n;
        }""",base64.b64encode(raw).decode())
        self.assertEqual(background,[20,20,20,255])
        self.assertGreater(pixels,25)
    def test_png_does_not_claim_success_when_a_reference_is_missing(self):
        p=self.start([LINE.copy()],[ref("missing")]); downloads=[]; p.on("download",lambda d: downloads.append(d))
        p.click("#shot"); p.wait_for_timeout(250)
        self.assertEqual(downloads,[], "A PNG with a missing image is not a complete board export.")
        self.assertIn("reference image",p.inner_text("#status"))
        self.assertEqual(self.board["images"],[ref("missing")])
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
    def test_legacy_saved_marks_can_be_selected_and_removed(self):
        legacy={k:v for k,v in LINE.items() if k!="id"}
        p=self.start([legacy]); self.hit(p,100,50); p.keyboard.press("Delete"); self.save(p)
        self.assertEqual(self.board["strokes"],[])
        p.click("#undo"); self.save(p); self.assertEqual(self.board["strokes"],[legacy])
    def test_duplicate_ids_delete_only_clicked_stroke(self):
        lower=dict(LINE,y1=120,y2=120)
        p=self.start([LINE.copy(),lower]); self.hit(p,100,120); p.keyboard.press("Delete"); self.save(p)
        self.assertEqual(self.board["strokes"],[LINE])
    def test_selecting_identical_overlap_picks_visible_front_stroke(self):
        front=dict(LINE,id="front",color="#cc00cc")
        p=self.start([LINE.copy(),front]); self.hit(p,100,50); p.keyboard.press("Delete"); self.save(p)
        self.assertEqual(self.board["strokes"],[LINE])
    def test_secondary_mouse_button_does_not_add_a_brush_mark(self):
        p=self.start([LINE.copy()]); p.click('[data-tool="pen"]'); r=p.locator("#board").bounding_box()
        p.mouse.click(r["x"]+100,r["y"]+100,button="right"); self.save(p)
        self.assertEqual(self.board["strokes"],[LINE])
    def test_system_cancel_neither_saves_an_incomplete_stroke_nor_drops_redo(self):
        p=self.start([],touch=True); p.click('[data-tool="pen"]'); r=p.locator("#board").bounding_box()
        p.touchscreen.tap(r["x"]+65,r["y"]+65); self.save(p); prior=self.board["strokes"]
        self.assertEqual(len(prior),1)
        p.click("#undo"); self.save(p); self.assertEqual(self.board["strokes"],[])
        c=p.context.new_cdp_session(p)
        c.send("Input.dispatchTouchEvent",dict(type="touchStart",touchPoints=[dict(x=r["x"]+100,y=r["y"]+100)]))
        c.send("Input.dispatchTouchEvent",dict(type="touchMove",touchPoints=[dict(x=r["x"]+130,y=r["y"]+140)]))
        c.send("Input.dispatchTouchEvent",dict(type="touchCancel",touchPoints=[]))
        self.save(p); self.assertEqual(self.board["strokes"],[])
        p.click("#redo"); self.save(p); self.assertEqual(self.board["strokes"],prior)
    def crop_box(self,p, outside=False):
        overlay=p.locator("#regionOverlay")
        overlay.wait_for(state="visible")
        r=overlay.bounding_box(); x=r["x"]; y=r["y"]
        p.mouse.move(x+30,y+40); p.mouse.down()
        p.mouse.move(x+r["width"]+(20 if outside else -45),y+130,steps=8); p.mouse.up()
    def test_crop_release_outside_preview_clamps_and_selects_edge(self):
        p=self.start([],outputs=[dict(url="/assets/101")]); self.crop_box(p,outside=True)
        self.assertIn("selected",p.inner_text("#regionStatus"))
        p.fill("#regionPrompt","Change just this area."); p.click("#regionApply")
        p.wait_for_function("document.querySelector('#regionStatus').textContent.includes('saved to this project')")
        self.assertEqual(len(self.edits),1); self.assertEqual(self.edits[0]["imageId"],101)
        mask=base64.b64decode(self.edits[0]["mask"].split(',')[1])
        self.assertEqual(self.pixel(p,mask,7,3),[255,255,255,255])
        self.assertEqual(self.pixel(p,mask,4,0),[0,0,0,255])
    def test_new_render_cannot_reuse_previous_render_crop(self):
        p=self.start([],outputs=[dict(url="/assets/101")]); self.crop_box(p)
        self.assertIn("selected",p.inner_text("#regionStatus")); p.fill("#regionPrompt","Old rectangle.")
        p.fill("#prompt","Create a second picture."); p.click("#create")
        p.wait_for_function("document.querySelector('#resultImg').src.endsWith('/assets/102') && document.querySelector('#resultImg').complete")
        p.click("#regionApply"); p.wait_for_timeout(200)
        self.assertEqual(self.edits,[], "Old crop must not be applied to the newly generated picture")
        self.assertIn("Drag a box",p.inner_text("#regionStatus"))
    def test_selected_tool_is_exposed_and_tracks_keyboard_activation(self):
        p=self.start([])
        self.assertEqual(p.get_by_role("button",name="Select",pressed=True).count(),1)
        brush=p.get_by_role("button",name="Brush"); brush.focus(); p.keyboard.press("Space")
        self.assertEqual(p.get_by_role("button",name="Brush",pressed=True).count(),1)
        self.assertEqual(p.get_by_role("button",name="Select",pressed=False).count(),1)
    def test_clicking_canvas_does_not_remove_selected_tools_visual_highlight(self):
        p=self.start([]); brush=p.get_by_role("button",name="Brush")
        brush.click(); self.hit(p,150,210)
        self.assertIn("on",(brush.get_attribute("class") or "").split())
        self.assertNotIn("on",(p.locator("#stage").get_attribute("class") or "").split())
    def test_board_save_and_result_messages_use_live_status(self):
        p=self.start([]); live=p.get_by_role("status")
        self.assertEqual(live.filter(has_text="Board loaded").count(),1)
        p.get_by_role("button",name="Brush").click(); self.hit(p,150,210); self.save(p)
        self.assertEqual(live.filter(has_text="Saved to project").count(),1)
        self.assertEqual(live.filter(has_text="Board saved.").count(),1)
    def test_small_screen_create_toolbar_does_not_clip_actions_or_status(self):
        p=self.start([]); p.set_viewport_size(dict(width=320,height=640))
        p.fill("#prompt","Draw an owl."); p.click("#create", timeout=1000)
        for target in ["#prompt","#create","#iterate","#status"]:
            r=p.locator(target).bounding_box()
            self.assertGreater(r["width"],0,target)
            self.assertLessEqual(r["x"]+r["width"],320,target)
    def test_small_screen_can_reach_preview_download_and_crop_controls(self):
        p=self.start([],outputs=[dict(url="/assets/101")]); p.set_viewport_size(dict(width=320,height=640))
        p.locator("#regionOverlay").wait_for(state="visible")
        pane=p.locator("#result")
        self.assertEqual(pane.evaluate("el=>getComputedStyle(el).overflowY"),"auto")
        self.assertLessEqual(pane.evaluate("el=>el.getBoundingClientRect().bottom"),p.locator("#stage").evaluate("el=>el.getBoundingClientRect().bottom"))
        p.locator("#regionPrompt").scroll_into_view_if_needed()
        field=p.locator("#regionPrompt").bounding_box(); panel=pane.bounding_box()
        self.assertLessEqual(field["x"]+field["width"],panel["x"]+panel["width"])
        with p.expect_download(timeout=1500) as dl: p.locator("#resultLink").click(timeout=1200)
        self.assertEqual(dl.value.path().read_bytes(),BLUE)
    def start_library(self,mode="ok", content="Fixture text.", *, name="First doc.md", grid=False, shelf=None, hold_catalog=None):
        if LIBRARY is None: self.skipTest("Supply --library path to exercise document previews")
        p=self.browser.new_page(viewport=dict(width=735,height=670))
        self.addCleanup(p.context.close)
        type(self).shelf=shelf or []
        docs=dict(fixture=[dict(name=name,md=content,createdAt=1),dict(name="Other doc.md",md="Other content.",createdAt=1)])
        p.add_init_script("localStorage.setItem('bz_docs_v1',"+json.dumps(json.dumps(docs))+");")
        p.add_init_script("""const mode=%s; Object.defineProperty(navigator,'clipboard',{value:mode==='unavailable'?undefined:{writeText:async function(value){if(mode==='denied') throw new Error('Test clipboard unavailable'); window.testClipboard=value;}}});"""%json.dumps(mode))
        if hold_catalog is not None:
            p.route("**/api/buzzy/jobs",lambda route:hold_catalog.append(route))
        p.goto("http://127.0.0.1:%d/buzzy/library"%self.server.server_port + ("" if grid else "?job=fixture"))
        p.locator("[data-folder='fixture']" if grid else "[data-open='%s']"%name).wait_for()
        return p
    def open_document(self,p,name="First doc.md"):
        target=p.locator("[data-open='%s']"%name); target.focus(); p.keyboard.press("Enter")
        p.locator(".docviewer").wait_for()
    def test_library_keyboard_open_and_return_keep_focus_in_document_flow(self):
        p=self.start_library()
        self.open_document(p,"Other doc.md")
        self.assertEqual(p.evaluate("document.activeElement.tagName"),"H1")
        self.assertEqual(p.evaluate("document.activeElement.textContent"),"Other doc.md")
        p.locator("#docsBackList").focus(); p.keyboard.press("Enter")
        self.assertEqual(p.evaluate("document.activeElement.getAttribute('data-open')"),"Other doc.md")
    def test_library_folder_actions_name_their_documents(self):
        p=self.start_library()
        self.assertEqual(p.get_by_role("button",name="Open First doc.md",exact=True).count(),1)
        self.assertEqual(p.get_by_role("button",name="Open Other doc.md",exact=True).count(),1)
        self.assertEqual(p.get_by_role("button",name="Download First doc.md",exact=True).count(),1)
        self.assertEqual(p.get_by_role("button",name="Download Other doc.md",exact=True).count(),1)
    def test_library_copy_reports_outcome_and_never_claims_unavailable_copy_worked(self):
        for mode in ["denied","unavailable","ok"]:
            p=self.start_library(mode,content="Actual fixture bytes • ε"); self.open_document(p)
            p.click("#docCopy")
            if mode == "ok":
                self.assertEqual(p.evaluate("window.testClipboard"),"Actual fixture bytes • ε")
                self.assertEqual(p.get_by_role("status").filter(has_text="Copied to clipboard").count(),1)
            else:
                self.assertNotEqual(p.inner_text("#docCopy"),"Copied",mode)
                self.assertEqual(p.get_by_role("status").filter(has_text="Could not copy").count(),1)
    def test_library_long_unbroken_readable_text_wraps_in_preview(self):
        raw_url="https://example.test/"+"segment"*80
        p=self.start_library(content=raw_url); self.open_document(p)
        width=p.locator(".docviewer").evaluate("(el)=>[el.scrollWidth,el.clientWidth]")
        self.assertEqual(p.locator(".docviewer").text_content(),raw_url)
        self.assertLessEqual(width[0],width[1])
    def test_library_folder_opens_by_keyboard_and_returns_focus_to_same_folder(self):
        p=self.start_library(grid=True)
        folder=p.locator("[data-folder='fixture']")
        folder.focus(); p.keyboard.press("Enter")
        self.assertEqual(p.locator("[data-open]").count(),2)
        self.assertEqual(p.evaluate("document.activeElement.tagName"),"H1")
        p.locator("#docsBackFolders").focus(); p.keyboard.press("Enter")
        self.assertEqual(p.evaluate("document.activeElement.getAttribute('data-folder')"),"fixture")
    def test_long_filename_keeps_mobile_open_and_download_within_viewport(self):
        name="a"*120+".md"; doc="The original local bytes • ε"
        p=self.start_library(name=name,content=doc); p.set_viewport_size(dict(width=320,height=680))
        open_btn=p.get_by_role("button",name="Open "+name,exact=True)
        dl_btn=p.get_by_role("button",name="Download "+name,exact=True)
        for btn in (open_btn,dl_btn):
            rect=btn.bounding_box()
            self.assertLessEqual(rect["x"]+rect["width"],320)
        with p.expect_download() as dl: dl_btn.click()
        self.assertEqual(dl.value.path().read_bytes(),doc.encode())
        open_btn.click(); self.assertEqual(p.locator(".docviewer").inner_text(),doc)
    def test_previewed_image_artifact_has_download_with_original_bytes(self):
        p=self.start_library(grid=True,shelf=[dict(id=441,name="map source.png",type="image/png",bytes=len(BLUE))])
        img=p.get_by_role("img",name="map source.png",exact=True); img.wait_for()
        download=p.get_by_role("link",name="Download map source.png",exact=True)
        self.assertEqual(download.count(),1)
        with p.expect_download() as dl: download.click()
        self.assertEqual(dl.value.suggested_filename,"map source.png")
        self.assertEqual(dl.value.path().read_bytes(),BLUE)
    def library_doc_download(self,markdown,js):
        p=self.start_library(content=markdown); self.open_document(p)
        with p.expect_download() as dl: p.click("#docDlWord")
        word=dl.value.path().read_bytes().decode("utf-8-sig")
        return p.evaluate("(raw)=>{const body=new DOMParser().parseFromString(raw,'text/html').body;"+js+"}",word)
    def test_word_export_preserves_ordered_list_structure_and_start_numbers(self):
        src="First run:\n\n3. Check the fan\n4. Record the result\n\nNext run:\n\n8) Repeat"
        result=self.library_doc_download(src,"return [...body.querySelectorAll('ol')].map(x=>[x.start,[...x.children].map(li=>li.textContent)]);")
        self.assertEqual(result,[[3,["Check the fan","Record the result"]],[8,["Repeat"]]])
    def test_word_export_preserves_code_block_whitespace_and_literal_markdown(self):
        code="# Not a heading\n  echo a < b && c > d\n\n  finish"
        markdown="Before\n\n"+chr(96)*3+"sh\n"+code+"\n"+chr(96)*3+"\n\nAfter"
        result=self.library_doc_download(markdown,"return [body.querySelector('pre code')?.textContent,[...body.querySelectorAll('p')].map(p=>p.textContent)];")
        self.assertEqual(result,[code,["Before","After"]])
    def test_export_keeps_saved_content_outside_a_smaller_viewport(self):
        right=dict(LINE,id="right",color="#ff0000",x1=510,x2=610,y1=85,y2=85)
        left=dict(LINE,id="left",color="#00ff00",x1=-44,x2=12,y1=120,y2=120)
        image=ref("blue",x=70,y=580,w=115,h=70)
        p=self.start([right,left],[image]); p.set_viewport_size(dict(width=320,height=580))
        svg=self.svg(p); left_x,_,svg_w,_=map(float,svg.get("viewBox").split())
        self.assertLessEqual(left_x,-44)
        self.assertGreaterEqual(left_x+svg_w,610)
        from PIL import Image
        from io import BytesIO
        raw=self.png(p); image=Image.open(BytesIO(raw)).convert("RGB")
        self.assertGreaterEqual(image.width,654)
        self.assertGreaterEqual(image.height,650)
        colors={color:n for n,color in image.getcolors(image.width*image.height)}
        self.assertGreater(colors.get((255,0,0),0),50)
        self.assertGreater(colors.get((0,255,0),0),50)
        self.assertGreater(colors.get((20,40,220),0),1000)
    def test_click_without_drag_does_not_save_empty_geometric_marks_or_clear_redo(self):
        p=self.start([]); p.click('[data-tool="pen"]'); self.hit(p,140,170); self.save(p)
        stroke=self.board["strokes"]
        self.assertEqual(len(stroke),1)
        p.click("#undo"); self.save(p); self.assertEqual(self.board["strokes"],[])
        for tool in ('line','rect','arrow'):
            p.click('[data-tool="%s"]'%tool); self.hit(p,140,170)
        self.save(p); self.assertEqual(self.board["strokes"],[])
        p.click("#redo"); self.save(p); self.assertEqual(self.board["strokes"],stroke)
        p.click('[data-tool="rect"]'); self.drag(p,140,170,240,245); self.save(p)
        self.assertEqual([s["tool"] for s in self.board["strokes"]],["pen","rect"])
    def test_new_note_anchors_to_shape_behind_existing_text_not_to_the_note(self):
        older=dict(id="older",tool="text",color="#ff0000",x1=95,y1=53,text="Existing note")
        p=self.start([LINE.copy(),older]); p.click('[data-tool="text"]')
        p.once("dialog",lambda d:d.accept("New note"))
        self.hit(p,105,50); self.save(p)
        expected=self.board["strokes"][-1]
        self.assertEqual(expected["anchor"],"road")
        self.assertEqual(expected["text"],"New note")
        p.once("dialog",lambda d:d.accept("Free note"))
        self.hit(p,175,40); self.save(p)
        self.assertIsNone(self.board["strokes"][-1]["anchor"])
    def test_selected_text_note_has_visible_feedback_but_png_is_not_decorated(self):
        note=dict(id="n",tool="text",color="#ffffff",x1=100,y1=100,text="Note selection")
        p=self.start([note]); original=self.screenshot_pixel(p,98,94)
        self.hit(p,110,94)
        selected=self.screenshot_pixel(p,98,94)
        self.assertNotEqual(selected,original)
        self.assertEqual(self.pixel(p,self.png(p),98,94)[:3],original)
        self.hit(p,30,30)
        self.assertEqual(self.screenshot_pixel(p,98,94),original)
    def test_png_uses_the_board_at_click_even_if_live_marks_change_while_a_reference_loads(self):
        note=dict(id="note",tool="text",color="#ff0000",x1=31,y1=50,text="Bridge",anchor="road")
        p=self.start([LINE.copy(),note],[ref("blue")])
        p.wait_for_function("document.querySelector('#layers img').naturalWidth===8")
        delayed=[]
        p.route("**/assets/blue.png",lambda request:delayed.append(request))
        with p.expect_download() as dl:
            p.click("#shot")
            p.wait_for_timeout(40)
            self.assertEqual(len(delayed),1,"Export is waiting for the existing reference to decode")
            self.hit(p,100,50); p.keyboard.press("Delete")
            p.click('[data-tool="line"]'); self.drag(p,330,200,423,200)
            delayed[0].fulfill(body=BLUE,content_type="image/png")
        saved_png=dl.value.path().read_bytes()
        self.assertEqual(self.pixel(p,saved_png,100,50),[255,255,0,255])
        self.assertEqual(self.pixel(p,saved_png,375,200),[20,20,20,255])
        from PIL import Image
        from io import BytesIO
        image=Image.open(BytesIO(saved_png)).convert("RGB")
        anchored=image.crop((115,20,180,40))
        self.assertGreater(sum(n for n,color in anchored.getcolors(1300) if color[0]>180 and color[1]<80 and color[2]<80),10)
        self.save(p); self.assertEqual([s["tool"] for s in self.board["strokes"]],["text","line"])
        self.assertIsNone(self.board["strokes"][0]["anchor"])
    def test_background_catalog_read_does_not_interrupt_an_open_document(self):
        pending=[]
        body="\n".join("Saved line "+str(i) for i in range(240))
        p=self.start_library(content=body,hold_catalog=pending)
        self.open_document(p)
        p.locator("#docCopy").focus()
        p.evaluate("""() => {
            const preview=document.querySelector('.docviewer');
            preview.scrollTop=390;
            const range=document.createRange();
            range.setStart(preview.firstChild,0); range.setEnd(preview.firstChild,12);
            window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
        }""")
        self.assertEqual(p.evaluate("document.activeElement.id"),"docCopy")
        self.assertEqual(p.evaluate("getSelection().toString()"),"Saved line 0")
        self.assertEqual(p.locator(".docviewer").evaluate("el=>el.scrollTop"),390)
        self.assertEqual(len(pending),1)
        pending[0].fulfill(json=dict(jobs=[dict(id="fixture",title="Loaded job title")]))
        p.locator("#docsBackList").get_by_text("Loaded job title",exact=False).wait_for()
        self.assertEqual(p.locator(".docviewer").evaluate("el=>el.scrollTop"),390)
        self.assertEqual(p.evaluate("document.activeElement.id"),"docCopy")
        self.assertEqual(p.evaluate("getSelection().toString()"),"Saved line 0")
        with p.expect_download() as dl: p.click("#docDl")
        self.assertEqual(dl.value.path().read_bytes(),body.encode())
        p.click("#docsBackList"); self.assertEqual(p.evaluate("document.activeElement.getAttribute('data-open')"),"First doc.md")
        self.open_document(p,"Other doc.md")
        self.assertEqual(p.locator(".docviewer").inner_text(),"Other content.")
    def test_copying_an_empty_library_file_keeps_existing_clipboard_text(self):
        p=self.start_library(content=""); self.open_document(p)
        p.evaluate("window.testClipboard = 'Prior clipboard data'")
        p.click("#docCopy")
        self.assertEqual(p.evaluate("window.testClipboard"),"Prior clipboard data")
        self.assertIn("empty",p.locator("#docCopyStatus").inner_text())
        with p.expect_download() as dl: p.click("#docDl")
        self.assertEqual(dl.value.path().read_bytes(),b"")
    def touch_image_setup(self):
        image=ref("blue"); p=self.start([], [image], touch=True)
        box=p.locator("#board").bounding_box(); c=p.context.new_cdp_session(p)
        def point(id,x,y): return dict(id=id,x=box["x"]+x,y=box["y"]+y)
        def send(kind,*points):
            c.send("Input.dispatchTouchEvent",dict(type=kind,touchPoints=list(points)))
        def x(): return float(p.locator(".img-wrap").evaluate("el=>parseFloat(el.style.left)"))
        return image,p,point,send,x
    def test_reference_drag_ignores_moves_from_a_second_touch(self):
        image,p,point,send,x=self.touch_image_setup()
        one=point(1,100,110); send("touchStart",one)
        midway=point(1,120,110); send("touchMove",midway)
        self.assertAlmostEqual(x(),image["x"]+20,delta=1)
        other=point(2,370,300); send("touchStart",midway,other)
        other=point(2,470,330); send("touchMove",midway,other)
        self.assertAlmostEqual(x(),image["x"]+20,delta=1)
        end=point(1,155,110); send("touchMove",end,other)
        send("touchEnd"); self.save(p)
        self.assertAlmostEqual(self.board["images"][0]["x"],image["x"]+55,delta=1)
    def test_canceled_reference_drag_leaves_saved_image_and_history_unchanged(self):
        image,p,point,send,x=self.touch_image_setup()
        send("touchStart",point(1,100,110)); send("touchMove",point(1,143,110))
        self.assertAlmostEqual(x(),image["x"]+43,delta=1)
        send("touchCancel"); self.save(p)
        self.assertEqual(self.board["images"],[image])
        self.assertAlmostEqual(x(),image["x"],delta=1)
        p.click("#undo"); self.assertEqual(p.inner_text("#status"),"Nothing to undo.")
    def test_changing_brush_color_does_not_repaint_colorless_saved_geometry(self):
        legacy={k:v for k,v in LINE.items() if k!="color"}
        p=self.start([legacy])
        p.locator("#color").fill("#00aaee"); p.click('[data-tool="line"]')
        self.drag(p,310,186,430,186); self.save(p)
        self.assertEqual(self.board["strokes"][0],legacy)
        self.assertEqual(self.board["strokes"][1]["color"],"#00aaee")
        self.assertEqual(self.screenshot_pixel(p,100,50),[255,212,13])
        self.assertEqual(self.screenshot_pixel(p,370,186),[0,170,238])
        png=self.png(p); self.assertEqual(self.pixel(p,png,100,50),[255,212,13,255])
        self.assertEqual(self.pixel(p,png,370,186),[0,170,238,255])
        self.assertEqual([line.get("stroke") for line in self.svg(p).findall("{*}line")],["#ffd40d","#00aaee"])
    def test_undo_while_drawing_cancels_draft_instead_of_removing_unrelated_finished_mark(self):
        p=self.start([]); p.click('[data-tool="line"]')
        self.drag(p,80,80,180,80); self.drag(p,100,110,210,110); self.save(p)
        before=self.board["strokes"]
        self.assertEqual(len(before),2)
        board=p.locator("#board").bounding_box()
        p.mouse.move(board["x"]+150,board["y"]+180); p.mouse.down()
        p.mouse.move(board["x"]+210,board["y"]+240,steps=4)
        p.keyboard.press("Control+z"); p.mouse.up(); self.save(p)
        self.assertEqual(self.board["strokes"],before)
        p.keyboard.press("Control+z"); self.save(p)
        self.assertEqual(self.board["strokes"],before[:1])
    def test_pending_autosave_does_not_persist_a_reference_move_still_in_progress(self):
        image,p,point,send,x=self.touch_image_setup()
        p.click('[data-tool="line"]'); self.drag(p,360,170,470,170)
        p.click('[data-tool="select"]')
        send("touchStart",point(1,100,110)); send("touchMove",point(1,143,110))
        self.assertAlmostEqual(x(),image["x"]+43,delta=1)
        with p.expect_response(lambda r:r.url.endswith("/api/buzzy/art") and r.request.method=="POST") as saved:
            p.wait_for_timeout(1300)
        outbound=saved.value.request.post_data_json["board"]
        send("touchCancel")
        self.assertEqual([s["tool"] for s in outbound["strokes"]],["line"])
        self.assertEqual(outbound["images"],[image])
        self.assertAlmostEqual(x(),image["x"],delta=1)
        p.reload(); p.wait_for_function("document.querySelector('#status').textContent.startsWith('Board loaded')")
        self.assertAlmostEqual(x(),image["x"],delta=1)
    def test_line_ends_where_the_pointer_releases_even_without_a_final_move_event(self):
        p=self.start([]); p.click('[data-tool="line"]')
        box=p.locator("#board").bounding_box()
        c=p.context.new_cdp_session(p)
        def mouse(kind,x,y,**kwargs):
            c.send("Input.dispatchMouseEvent",dict(type=kind,x=box["x"]+x,y=box["y"]+y,**kwargs))
        mouse("mouseMoved",100,150,buttons=0)
        mouse("mousePressed",100,150,button="left",buttons=1,clickCount=1)
        mouse("mouseMoved",138,166,buttons=1)
        mouse("mouseReleased",242,234,button="left",buttons=0,clickCount=1)
        self.save(p)
        self.assertEqual(len(self.board["strokes"]),1)
        line=self.board["strokes"][0]
        self.assertAlmostEqual(line["x2"],242,delta=1)
        self.assertAlmostEqual(line["y2"],234,delta=1)
if __name__=="__main__": unittest.main(verbosity=2)

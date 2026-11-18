/* Offline PDF-1.4 for an explicit WinAnsi subset, using standard Helvetica.
 * No bundled fonts, network or deps. Unsupported text is refused, never replaced.
 * Markdown remains the exact-text option for valid unsupported Unicode. */
(function (root) {
  var SPECIALS = {
    8364: 128, 8218: 130, 402: 131, 8222: 132, 8230: 133, 8224: 134,
    8225: 135, 710: 136, 8240: 137, 352: 138, 8249: 139, 338: 140,
    381: 142, 8216: 145, 8217: 146, 8220: 147, 8221: 148, 8226: 149,
    8211: 150, 8212: 151, 732: 152, 8482: 153, 353: 154, 8250: 155,
    339: 156, 382: 158, 376: 159
  };

  function byteFor(cp) {
    // NBSP and soft hyphen have ambiguous whitespace/rendering semantics here.
    // Do not silently turn them into ordinary spaces or visible hyphens.
    if ((cp >= 32 && cp <= 126) || (cp >= 161 && cp <= 255 && cp !== 173)) return cp;
    return SPECIALS[cp];
  }

  function textError(invalid, cp) {
    var error = new Error(invalid
      ? "This text contains invalid Unicode. Fix the text before exporting; no PDF was downloaded."
      : "PDF export cannot represent every character in this text" +
        (cp == null ? "" : " (U+" + hex(cp, 4) + ")") +
        ". Download the Markdown (.md) copy to preserve the text unchanged; no PDF was downloaded.");
    error.code = invalid ? "pdf_invalid_text" : "pdf_unsupported_text";
    return error;
  }

  function inspectText(text) {
    if (typeof text !== "string") throw textError(true);
    var used = {};
    var unsupported = null;
    for (var i = 0; i < text.length; i++) {
      var cp = text.charCodeAt(i);
      if (cp >= 0xD800 && cp <= 0xDBFF) {
        var next = text.charCodeAt(i + 1);
        if (!(next >= 0xDC00 && next <= 0xDFFF)) throw textError(true);
        if (unsupported === null) unsupported = 0x10000 + (cp - 0xD800) * 1024 + next - 0xDC00;
        i++;
        continue;
      }
      if (cp >= 0xDC00 && cp <= 0xDFFF) throw textError(true);
      if (cp === 10) continue;
      if (cp === 13 && text.charCodeAt(i + 1) === 10) { i++; continue; }
      var code = byteFor(cp);
      if (code === undefined) {
        if (unsupported === null) unsupported = cp;
      } else used[code] = cp;
    }
    // Validate all UTF-16 before suggesting Markdown: an unsupported character
    // followed by an unpaired surrogate is not a lossless UTF-8 fallback.
    if (unsupported !== null) throw textError(false, unsupported);
    return used;
  }

  function hex(n, length) { return n.toString(16).toUpperCase().padStart(length, "0"); }

  function enc(s) {
    var out = "";
    for (var i = 0; i < s.length; i++) out += hex(byteFor(s.charCodeAt(i)), 2);
    return out;
  }

  function unicodeMap(used) {
    var keys = Object.keys(used).map(Number).sort(function (a, b) { return a - b; });
    var out = "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
      "/CMapName /BeeZillaWinAnsi def\n/CMapType 2 def\n" +
      "1 begincodespacerange\n<00> <FF>\nendcodespacerange\n";
    for (var i = 0; i < keys.length; i += 100) {
      var batch = keys.slice(i, i + 100);
      out += batch.length + " beginbfchar\n";
      batch.forEach(function (code) { out += "<" + hex(code, 2) + "> <" + hex(used[code], 4) + ">\n"; });
      out += "endbfchar\n";
    }
    return out + "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n";
  }

  function wrap(text, width) {
    const out = [];
    text.split(/\r\n|\n/).forEach(function (line) {
      if (line.length <= width) {
        out.push(line);
        return;
      }
      var rest = line;
      while (rest.length > width) {
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      out.push(rest);
    });
    return out;
  }

  root.beezillaSowPdf = function (text) {
    var used = inspectText(text); // Refuse the whole input before producing any PDF.
    // 45 of Helvetica's widest supported glyph (@, 1015/1000 em) at 11pt
    // fit inside the 512pt content width. No trimming or dropped characters.
    var lines = wrap(text, 45);
    var fontSize = 11;
    var lineHeight = 15;
    var pageTop = 750;
    var pageBottom = 50;
    var margin = 50;
    var per = Math.floor((pageTop - pageBottom) / lineHeight) || 40;
    var pages = [];
    for (var i = 0; i < lines.length; i += per) pages.push(lines.slice(i, i + per));
    if (!pages.length) pages = [[""]];

    var parts = [];
    var offset = 0;
    var offsets = [0];

    function emit(num, content) {
      offsets[num] = offset;
      var block = num + " 0 obj\n" + content + "\nendobj\n";
      parts.push(block);
      offset += block.length;
    }

    var header = "%PDF-1.4\n";
    parts.push(header);
    offset += header.length;

    var nPages = pages.length;
    var pageStart = 3;
    var streamStart = pageStart + nPages;
    var fontNum = streamStart + nPages;
    var unicodeNum = fontNum + 1;

    emit(1, "<< /Type /Catalog /Pages 2 0 R >>");
    var kids = pages
      .map(function (_, i) {
        return pageStart + i + " 0 R";
      })
      .join(" ");
    emit(2, "<< /Type /Pages /Kids [" + kids + "] /Count " + nPages + " >>");

    var streams = pages.map(function (pageLines) {
      var y = pageTop;
      var s = "";
      pageLines.forEach(function (line) {
        s += "BT /F1 " + fontSize + " Tf " + margin + " " + y + " Td <" + enc(line) + "> Tj ET\n";
        y -= lineHeight;
      });
      return s;
    });

    for (var p = 0; p < nPages; p++) {
      emit(
        pageStart + p,
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents " +
          (streamStart + p) +
          " 0 R /Resources << /Font << /F1 " +
          fontNum +
          " 0 R >> >> >>",
      );
    }
    for (var q = 0; q < nPages; q++) {
      var body = streams[q];
      emit(streamStart + q, "<< /Length " + body.length + " >>\nstream\n" + body + "endstream");
    }
    emit(fontNum, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding /ToUnicode " + unicodeNum + " 0 R >>");
    var cmap = unicodeMap(used);
    emit(unicodeNum, "<< /Length " + cmap.length + " >>\nstream\n" + cmap + "endstream");

    var xrefOffset = offset;
    var size = unicodeNum + 1;
    var xref = "xref\n0 " + size + "\n0000000000 65535 f \n";
    for (var o = 1; o < size; o++) {
      xref += String(offsets[o] || 0).padStart(10, "0") + " 00000 n \n";
    }
    parts.push(xref);
    parts.push(
      "trailer\n<< /Size " + size + " /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF",
    );
    // All serialized syntax, hex text and CMap entries are ASCII, so the
    // recorded string lengths are exactly their emitted byte lengths.
    return new TextEncoder().encode(parts.join(""));
  };
})(typeof window !== "undefined" ? window : globalThis);

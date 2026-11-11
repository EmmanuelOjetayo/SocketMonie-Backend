/* Smoke test: multi-page PDF footer stamping pattern used by ReportsController.
 * Run: node tests/pdfPagination.smoke.js  → writes a real PDF to stdout > NUL */
const PDFDocument = require("pdfkit");
const fs = require("fs");

const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });
const out = fs.createWriteStream(__dirname + "/../pdf_smoke_out.pdf");
doc.pipe(out);

// Simulate 120 rows so the doc rolls onto multiple pages.
for (let i = 1; i <= 120; i += 1) {
  if (doc.y > doc.page.height - 90) doc.addPage();
  doc.fontSize(9).text(`Row ${i} — SocketMoni statement line item`, 50, doc.y + 4);
}

const range = doc.bufferedPageRange();
for (let i = range.start; i < range.start + range.count; i += 1) {
  doc.switchToPage(i);
  const pageHeight = doc.page.height;
  doc.rect(20, pageHeight - 52, doc.page.width - 40, 32).fill("#2563eb");
  doc
    .fillColor("#ffffff")
    .fontSize(8)
    .text(
      `Page ${i + 1} of ${range.count} — Thank you for building your financial future with SocketMoni.`,
      40,
      pageHeight - 41,
      { align: "center", width: doc.page.width - 80 }
    );
}

doc.end();

out.on("finish", () => {
  const size = fs.statSync(__dirname + "/../pdf_smoke_out.pdf").size;
  if (size < 2000) throw new Error(`PDF too small (${size} bytes)`);
  console.log(`PDF pagination smoke OK — ${range.count} pages, ${size} bytes`);
  fs.unlinkSync(__dirname + "/../pdf_smoke_out.pdf");
});

const PDFDocument = require("pdfkit");
const MemberStatementService = require("../Services/MemberStatementService");

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/* ------------------------------------------------------------------ */
/* GET /api/reports/monthly?month=7&year=2026                          */
/* ------------------------------------------------------------------ */
const getMonthlyReport = async (req, res, next) => {
  try {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const statement = await MemberStatementService.buildMonthlyStatement(
      req.user,
      month,
      year
    );

    return res.status(200).json({ success: true, statement });
  } catch (error) {
    next(error);
  }
};

/* ------------------------------------------------------------------ */
/* GET /api/reports/download-pdf?month=7&year=2026                     */
/* ------------------------------------------------------------------ */

const PDF_LAYOUT = {
  margin: 40,
  tableColumns: [
    { key: "date", label: "DATE", x: 50, width: 58 },
    { key: "description", label: "DESCRIPTION", x: 112, width: 118 },
    { key: "reference", label: "REFERENCE", x: 234, width: 104 },
    { key: "method", label: "METHOD", x: 342, width: 58 },
    { key: "status", label: "STATUS", x: 404, width: 52 },
    { key: "amount", label: "AMOUNT (NGN)", x: 460, width: 85, align: "right" },
  ],
};

const naira = (value) =>
  Number(value || 0).toLocaleString("en-NG", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const shortDate = (iso) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "—"
    : d.toISOString().split("T")[0];
};

/**
 * Renders the branded header + member info block. Returns the y position
 * where the caller can continue drawing.
 */
const drawPageChrome = (doc, user, period, pageNumber) => {
  const brandBlue = "#2563eb";
  const pageWidth = doc.page.width;
  const pageHeight = doc.page.height;

  if (pageNumber > 1) doc.addPage();

  // Outer border
  doc
    .rect(20, 20, pageWidth - 40, pageHeight - 40)
    .lineWidth(1.5)
    .stroke(brandBlue);

  // Header bar
  doc.rect(20, 20, pageWidth - 40, 65).fill(brandBlue);

  doc
    .fillColor("#ffffff")
    .fontSize(20)
    .font("Helvetica-Bold")
    .text("SocketMoni", 40, 32)
    .fontSize(9)
    .font("Helvetica")
    .text("OFFICIAL MONTHLY FINANCIAL STATEMENT", 40, 56);

  // Right side of the header bar
  doc
    .fontSize(9)
    .text(
      `Page ${pageNumber}`,
      pageWidth - 110,
      40,
      { width: 70, align: "right" }
    );

  // User info block (page 1 only)
  if (pageNumber === 1) {
    doc
      .fillColor("#1e293b")
      .fontSize(10)
      .font("Helvetica-Bold")
      .text("Account Name: ", 40, 100, { continued: true })
      .font("Helvetica")
      .text(user.fullName || user.name || "Valued Member")
      .font("Helvetica-Bold")
      .text("Email Address: ", { continued: true })
      .font("Helvetica")
      .text(user.email || "—")
      .font("Helvetica-Bold")
      .text("Statement Period: ", { continued: true })
      .font("Helvetica")
      .text(`${MONTH_NAMES[period.month - 1]} ${period.year}`)
      .font("Helvetica-Bold")
      .text("Generated Date: ", { continued: true })
      .font("Helvetica")
      .text(new Date().toISOString().split("T")[0]);
    return 175;
  }
  return 110;
};

const drawSummaryCards = (doc, statement, y) => {
  const brandBlue = "#2563eb";
  const darkText = "#1e293b";
  const mutedText = "#64748b";
  const bgLight = "#f8fafc";
  const { savings, loans, rating } = statement;

  // Card 1: Total saved & growth
  doc.roundedRect(40, y, 240, 70, 6).fillAndStroke(bgLight, brandBlue);
  doc
    .fillColor(mutedText)
    .fontSize(8)
    .font("Helvetica")
    .text("TOTAL SAVED THIS MONTH", 52, y + 10)
    .fillColor(brandBlue)
    .fontSize(14)
    .font("Helvetica-Bold")
    .text(`NGN ${naira(savings.totalSaved)}`, 52, y + 23)
    .fillColor(savings.growthRate >= 0 ? "#16a34a" : "#dc2626")
    .fontSize(9)
    .font("Helvetica")
    .text(
      `${savings.growthRate >= 0 ? "+" : ""}${savings.growthRate}% growth vs prev. month`,
      52,
      y + 45
    );

  // Card 2: Loan balance
  doc.roundedRect(295, y, 240, 70, 6).fillAndStroke(bgLight, brandBlue);
  doc
    .fillColor(mutedText)
    .fontSize(8)
    .font("Helvetica")
    .text("OUTSTANDING LOAN BALANCE", 307, y + 10)
    .fillColor(loans.outstandingBalance > 0 ? "#dc2626" : darkText)
    .fontSize(14)
    .font("Helvetica-Bold")
    .text(`NGN ${naira(loans.outstandingBalance)}`, 307, y + 23)
    .fillColor(mutedText)
    .fontSize(9)
    .font("Helvetica")
    .text(`Active Loans: ${loans.activeLoansCount}`, 307, y + 45);

  // Card 3: Deposits / withdrawals / net
  const y3 = y + 80;
  doc.roundedRect(40, y3, 240, 70, 6).fillAndStroke(bgLight, brandBlue);
  doc
    .fillColor(mutedText)
    .fontSize(8)
    .font("Helvetica")
    .text("DEPOSITS / WITHDRAWALS", 52, y3 + 10)
    .fillColor("#16a34a")
    .fontSize(11)
    .font("Helvetica-Bold")
    .text(`Deposits: NGN ${naira(savings.totalDeposits)}`, 52, y3 + 23)
    .fillColor("#dc2626")
    .text(`Withdrawals: NGN ${naira(savings.totalWithdrawals)}`, 52, y3 + 41)
    .fillColor(darkText)
    .text(`Net: NGN ${naira(savings.netGrowth)}`, 52, y3 + 59);

  // Card 4: Socket score
  doc.roundedRect(295, y3, 240, 70, 6).fillAndStroke(bgLight, brandBlue);
  doc
    .fillColor(darkText)
    .fontSize(8)
    .font("Helvetica")
    .text("SOCKET SCORE RATING", 307, y3 + 10)
    .fillColor(brandBlue)
    .fontSize(14)
    .font("Helvetica-Bold")
    .text(`${rating.current}/100`, 307, y3 + 23)
    .fillColor(mutedText)
    .fontSize(9)
    .font("Helvetica")
    .text(
      `Tier: ${rating.tier} | Prev. month: ${rating.previous ?? "—"}`,
      307,
      y3 + 45
    );

  return y3 + 85;
};

const downloadPdfStatement = async (req, res, next) => {
  try {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const user = req.user;

    // Same statement the JSON endpoint serves — one source of truth.
    const statement = await MemberStatementService.buildMonthlyStatement(
      user,
      month,
      year
    );

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=SocketMoni_Statement_${MONTH_NAMES[month - 1]}_${year}.pdf`
    );

    // bufferPages: keep pages in memory so footers + "Page X of Y" can be
    // stamped on every page just before the stream ends.
    const doc = new PDFDocument({ margin: 40, size: "A4", bufferPages: true });
    doc.pipe(res);

    const brandBlue = "#2563eb";
    const darkText = "#1e293b";
    const mutedText = "#64748b";
    const cols = PDF_LAYOUT.tableColumns;
    const pageBottom = doc.page.height - 70; // footer band clearance

    let pageNumber = 1;
    let y = drawPageChrome(doc, user, statement.period, pageNumber);
    y = drawSummaryCards(doc, statement, y);

    const drawTableHeader = (yPos) => {
      doc.rect(40, yPos, 515, 22).fill(brandBlue);
      doc.fillColor("#ffffff").fontSize(8).font("Helvetica");
      cols.forEach((c) => {
        doc.text(c.label, c.x, yPos + 7, {
          width: c.width,
          align: c.align || "left",
        });
      });
      return yPos + 26;
    };

    doc
      .fillColor(darkText)
      .fontSize(12)
      .font("Helvetica-Bold")
      .text("Transaction Breakdown", 40, y + 8);
    y += 24;

    y = drawTableHeader(y);

    const rows = statement.transactions || [];
    if (rows.length === 0) {
      doc
        .fillColor(mutedText)
        .fontSize(9)
        .font("Helvetica")
        .text("No transaction records found for this period.", 50, y);
      y += 20;
    }

    rows.forEach((tx, index) => {
      // Multi-page: roll over when the footer band gets close.
      if (y > pageBottom) {
        pageNumber += 1;
        y = drawPageChrome(doc, user, statement.period, pageNumber);
        y = drawTableHeader(y);
      }

      if (index % 2 === 0) {
        doc.rect(40, y - 3, 515, 20).fill("#f1f5f9");
      }

      const isDebit =
        tx.direction === "debit" ||
        (tx.type === "savings" && tx.category === "withdrawal");

      const values = {
        date: shortDate(tx.date || tx.paidAt || tx.createdAt),
        description: tx.label || tx.category || "Transaction",
        reference: tx.reference || "—",
        method: (tx.method || "—").replace(/_/g, " "),
        status: (tx.status || "completed").toUpperCase(),
        amount: `${isDebit ? "-" : "+"}${naira(tx.amount)}`,
      };

      doc.fillColor(darkText).fontSize(7.5).font("Helvetica");
      cols.forEach((c) => {
        const text = String(values[c.key]);
        doc.text(text, c.x, y, {
          width: c.width,
          align: c.align || "left",
          ellipsis: true,
          lineBreak: false,
        });
      });

      doc
        .moveTo(40, y + 15)
        .lineTo(555, y + 15)
        .lineWidth(0.5)
        .stroke("#cbd5e1");

      y += 22;
    });

    // --- Totals band (completed money movement only) ----------------
    if (y > pageBottom - 90) {
      pageNumber += 1;
      y = drawPageChrome(doc, user, statement.period, pageNumber);
    }
    y += 10;
    doc.roundedRect(40, y, 515, 60, 6).fillAndStroke("#f8fafc", brandBlue);
    doc.fillColor(darkText).fontSize(10).font("Helvetica-Bold");
    doc.text("Period Summary (completed transactions only)", 52, y + 10);
    doc.fontSize(9).font("Helvetica");
    doc
      .fillColor("#16a34a")
      .text(
        `Total Deposits: NGN ${naira(savingsOf(rows, "deposit"))}`,
        52,
        y + 28
      )
      .fillColor("#dc2626")
      .text(
        `Total Withdrawals: NGN ${naira(savingsOf(rows, "withdrawal"))}`,
        52,
        y + 44
      );

    // --- Footers on every page, with Page X of Y --------------------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      const pageHeight = doc.page.height;
      doc
        .rect(20, pageHeight - 52, doc.page.width - 40, 32)
        .fill(brandBlue);
      doc
        .fillColor("#ffffff")
        .fontSize(8)
        .font("Helvetica")
        .text(
          "Thank you for building your financial future with SocketMoni.",
          40,
          pageHeight - 41,
          { align: "center", width: doc.page.width - 80 }
        );
    }

    doc.end();
  } catch (error) {
    next(error);
  }
};

// Completed savings withdrawals total from the unified rows.
const savingsOf = (rows, category) =>
  rows
    .filter(
      (t) =>
        t.type === "savings" &&
        t.category === category &&
        t.status === "completed"
    )
    .reduce((s, t) => s + Number(t.amount || 0), 0);

module.exports = {
  getMonthlyReport,
  downloadPdfStatement,
};

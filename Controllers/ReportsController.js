const PDFDocument = require("pdfkit");
const Savings = require("../Models/SavingsModel");
const Loan = require("../Models/LoanModel");

// Helper: Calculate growth percentage
const calculateGrowthRate = (current, previous) => {
  if (previous === 0) return current > 0 ? 100 : 0;
  return (((current - previous) / previous) * 100).toFixed(1);
};

// GET /api/reports/monthly?month=7&year=2026
const getMonthlyReport = async (req, res, next) => {
  try {
    const userId = req.user._id;
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    // 1. Date Ranges for current month
    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    // Date Ranges for previous month
    const startOfPrevMonth = new Date(year, month - 2, 1);
    const endOfPrevMonth = new Date(year, month - 1, 0, 23, 59, 59, 999);

    // 2. Fetch Current Month Savings
    const currentMonthSavings = await Savings.find({
      userId,
      status: "completed",
      type: "deposit",
      createdAt: { $gte: startOfMonth, $lte: endOfMonth },
    });
    const currentTotalSaved = currentMonthSavings.reduce((sum, t) => sum + t.amount, 0);

    // 3. Fetch Previous Month Savings for Growth Rate
    const prevMonthSavings = await Savings.find({
      userId,
      status: "completed",
      type: "deposit",
      createdAt: { $gte: startOfPrevMonth, $lte: endOfPrevMonth },
    });
    const prevTotalSaved = prevMonthSavings.reduce((sum, t) => sum + t.amount, 0);

    const growthRate = calculateGrowthRate(currentTotalSaved, prevTotalSaved);

    // 4. Fetch Real Outstanding Loans
    const activeLoans = await Loan.find({
      userId,
      status: { $in: ["active", "defaulted"] },
    });
    const outstandingLoanBalance = activeLoans.reduce(
      (sum, loan) => sum + (loan.remainingBalance || 0),
      0
    );

    return res.status(200).json({
      success: true,
      statement: {
        period: { month, year },
        savings: {
          totalSaved: currentTotalSaved,
          growthRate: Number(growthRate),
        },
        loans: {
          outstandingBalance: outstandingLoanBalance,
          activeLoansCount: activeLoans.length,
        },
        rating: {
          current: req.user.socketScore || 75,
          tier: req.user.tier || "Tier 1",
        },
      },
    });
  } catch (error) {
    next(error);
  }
};

// GET /api/reports/download-pdf?month=7&year=2026
const downloadPdfStatement = async (req, res, next) => {
  try {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const user = req.user;

    const startOfMonth = new Date(year, month - 1, 1);
    const endOfMonth = new Date(year, month, 0, 23, 59, 59, 999);

    const startOfPrevMonth = new Date(year, month - 2, 1);
    const endOfPrevMonth = new Date(year, month - 1, 0, 23, 59, 59, 999);

    // 1. Fetch live filtered savings records
    const savings = await Savings.find({
      userId: user._id,
      status: "completed",
      createdAt: { $gte: startOfMonth, $lte: endOfMonth },
    }).sort({ createdAt: -1 });

    const totalSaved = savings
      .filter((s) => s.type === "deposit")
      .reduce((acc, curr) => acc + curr.amount, 0);

    // Previous month total for growth calculation
    const prevSavings = await Savings.find({
      userId: user._id,
      status: "completed",
      type: "deposit",
      createdAt: { $gte: startOfPrevMonth, $lte: endOfPrevMonth },
    });
    const prevTotal = prevSavings.reduce((acc, curr) => acc + curr.amount, 0);
    const growthRate = calculateGrowthRate(totalSaved, prevTotal);

    // 2. Fetch Real Outstanding Loan Balance
    const activeLoans = await Loan.find({
      userId: user._id,
      status: { $in: ["active", "defaulted"] },
    });
    const outstandingLoan = activeLoans.reduce(
      (sum, loan) => sum + (loan.remainingBalance || 0),
      0
    );

    const currentScore = user.socketScore || 75;

    // 3. Response Headers
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=SocketMoni_Statement_${month}_${year}.pdf`
    );

    // 4. Initialize PDF Stream
    const doc = new PDFDocument({ margin: 40, size: "A4" });
    doc.pipe(res);

    const brandBlue = "#2563eb";
    const darkText = "#1e293b";
    const mutedText = "#64748b";
    const bgLight = "#f8fafc";

    // --- OUTER BORDER ---
    doc.rect(20, 20, 555, 802).lineWidth(1.5).stroke(brandBlue);

    // --- HEADER BAR ---
    doc.rect(20, 20, 555, 65).fill(brandBlue);

    doc
      .fillColor("#ffffff")
      .fontSize(20)
      .text("SocketMoni", 40, 32, { bold: true })
      .fontSize(9)
      .text("OFFICIAL MONTHLY FINANCIAL STATEMENT", 40, 56);

    // --- USER INFO ---
    doc
      .fillColor(darkText)
      .fontSize(10)
      .text(`Account Name: `, 40, 100, { continued: true, bold: true })
      .font("Helvetica")
      .text(user.fullName || user.name || "Valued Member")
      .text(`Email Address: `, { continued: true, bold: true })
      .font("Helvetica")
      .text(user.email)
      .text(`Statement Period: `, { continued: true, bold: true })
      .font("Helvetica")
      .text(`Month ${month}, ${year}`)
      .text(`Generated Date: `, { continued: true, bold: true })
      .font("Helvetica")
      .text(new Date().toISOString().split("T")[0]);

    // --- SUMMARY CARDS ---
    
    // Card 1: Total Saved & Growth
    doc.roundedRect(40, 170, 240, 70, 6).fillAndStroke(bgLight, brandBlue);

    doc
      .fillColor(mutedText)
      .fontSize(8)
      .text("TOTAL SAVED THIS MONTH", 52, 180)
      .fillColor(brandBlue)
      .fontSize(14)
      .text(`NGN ${totalSaved.toLocaleString()}`, 52, 193, { bold: true })
      .fillColor(growthRate >= 0 ? "#16a34a" : "#dc2626")
      .fontSize(9)
      .text(`${growthRate >= 0 ? "+" : ""}${growthRate}% growth vs prev. month`, 52, 215);

    // Card 2: Loan Balance
    doc.roundedRect(295, 170, 240, 70, 6).fillAndStroke(bgLight, brandBlue);

    doc
      .fillColor(mutedText)
      .fontSize(8)
      .text("OUTSTANDING LOAN BALANCE", 307, 180)
      .fillColor(outstandingLoan > 0 ? "#dc2626" : darkText)
      .fontSize(14)
      .text(`NGN ${outstandingLoan.toLocaleString()}`, 307, 193, { bold: true })
      .fillColor(mutedText)
      .fontSize(9)
      .text(`Active Loans: ${activeLoans.length}`, 307, 215);

    // Card 3: Socket Score Rating
    doc.roundedRect(40, 250, 495, 45, 6).fillAndStroke(bgLight, brandBlue);

    doc
      .fillColor(darkText)
      .fontSize(11)
      .text("Socket Score Rating: ", 52, 260, { continued: true, bold: true })
      .fillColor(brandBlue)
      .text(`${currentScore}/100`)
      .fillColor(mutedText)
      .fontSize(9)
      .text(`Tier: ${user.tier || "Tier 1"} | Evaluated dynamically based on savings and repayment discipline.`, 52, 276);

    // --- TRANSACTION HISTORY TABLE ---
    doc
      .fillColor(darkText)
      .fontSize(12)
      .text("Savings & Transaction Breakdown", 40, 312, { bold: true });

    // Table Header Line
    const tableTop = 330;
    doc.rect(40, tableTop, 495, 22).fill(brandBlue);

    doc.fillColor("#ffffff").fontSize(8);
    doc.text("DATE", 50, tableTop + 7, { width: 90 });
    doc.text("METHOD", 150, tableTop + 7, { width: 100 });
    doc.text("TYPE", 270, tableTop + 7, { width: 80 });
    doc.text("STATUS", 360, tableTop + 7, { width: 70 });
    doc.text("AMOUNT (NGN)", 440, tableTop + 7, { width: 85, align: "right" });

    let y = tableTop + 26;

    if (savings.length === 0) {
      doc
        .fillColor(mutedText)
        .fontSize(9)
        .text("No transaction records found for this period.", 50, y);
    } else {
      savings.slice(0, 15).forEach((tx, index) => {
        if (index % 2 === 0) {
          doc.rect(40, y - 3, 495, 20).fill("#f1f5f9");
        }

        doc.fillColor(darkText).fontSize(8);
        doc.text(new Date(tx.createdAt).toISOString().split("T")[0], 50, y);
        doc.text(tx.method || "Payment Gateway", 150, y);
        doc.text((tx.type || "deposit").toUpperCase(), 270, y);
        doc.text((tx.status || "completed").toUpperCase(), 360, y);
        doc.text(`${tx.amount.toLocaleString()}`, 440, y, { width: 85, align: "right" });

        doc
          .moveTo(40, y + 15)
          .lineTo(535, y + 15)
          .lineWidth(0.5)
          .stroke("#cbd5e1");

        y += 22;
      });
    }

    // --- FOOTER ---
    doc.rect(20, 790, 555, 32).fill(brandBlue);

    doc
      .fillColor("#ffffff")
      .fontSize(8)
      .text("Thank you for building your financial future with SocketMoni.", 40, 802, { align: "center" });

    doc.end();
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getMonthlyReport,
  downloadPdfStatement,
};
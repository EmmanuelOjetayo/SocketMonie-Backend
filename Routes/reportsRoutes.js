const express = require("express");
const reportsRoutes = express.Router();
const { getMonthlyReport, downloadPdfStatement } = require("../Controllers/ReportsController");
const protect = require("../Middleware/AuthMiddleware");

reportsRoutes.use(protect);

// User monthly analytics JSON statement
reportsRoutes.get("/monthly", getMonthlyReport);

// PDF download stream endpoint
reportsRoutes.get("/download-pdf", downloadPdfStatement);

module.exports = reportsRoutes;
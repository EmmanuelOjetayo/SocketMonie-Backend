const express = require("express");
const router = express.Router();
const routeProtect = require("../Middleware/AuthMiddleware");
const { getTransactions } = require("../Controllers/TransactionController");

// Unified transaction history (savings / minutes / membership / loan).
router.get("/", routeProtect, getTransactions);

module.exports = router;

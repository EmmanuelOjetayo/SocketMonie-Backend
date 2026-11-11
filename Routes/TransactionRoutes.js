const express = require("express");
const router = express.Router();
const routeProtect = require("../Middleware/AuthMiddleware");
const { getTransactions, getTransaction } = require("../Controllers/TransactionController");

// Unified transaction history (savings / minutes / membership / loan).
router.get("/", routeProtect, getTransactions);

// A single transaction owned by the requesting member (transaction details).
router.get("/:id", routeProtect, getTransaction);

module.exports = router;

const express = require("express");
const router = express.Router();
const protect = require("../Middleware/AuthMiddleware");
const authorize = require("../Middleware/authorize");
const validate = require("../Middleware/validate");
const controller = require("../Controllers/ExpenseController");

router.use(protect, authorize("super_admin"));
router.get("/", controller.list);
router.post("/", validate({ title: "required|string", amount: "required|monetary", category: "required|string", reference: "required|string" }), controller.create);
router.post("/:id/reverse", validate({ reason: "required|string" }), controller.reverse);

module.exports = router;
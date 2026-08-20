const express = require("express");
const router = express.Router();
const notificationController = require("../Controllers/NotificationController");
const protect = require("../Middleware/AuthMiddleware");
router.use(protect);
router.get("/", notificationController.getNotifications);
router.patch("/:id/read", notificationController.markAsRead);
router.patch("/mark-all-read", notificationController.markAllAsRead);
module.exports = router;
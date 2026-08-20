const express = require("express");
const PolicyRouter = express.Router();
const { getPolicy, updatePolicy } = require("../Controllers/PolicyConfigController");
const routeProtect = require("../Middleware/AuthMiddleware");
const requireRole = require("../Middleware/authorize");

PolicyRouter.get("/", routeProtect, getPolicy);
PolicyRouter.put("/", routeProtect, requireRole("super_admin"), updatePolicy);

module.exports = PolicyRouter;

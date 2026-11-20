const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

test("NIN is the only national identity number collected", () => {
  const sources = [
    "Models/UserModel.js",
    "Middleware/UserValidate.js",
    "Services/UserService.js",
    "Repositories/UserRepository.js",
    "Utilis/tierService.js",
    "Utilis/formatValidationError.js",
    "Models/Policyconfigmodel.js",
  ];

  for (const rel of sources) {
    assert.ok(!/\bbvn\b/i.test(read(rel)), `${rel} still references BVN`);
  }
});

test("NIN validation, storage, duplicate checks and tier policy stay intact", () => {
  assert.ok(
    read("Middleware/UserValidate.js").includes("nin: joi.string().pattern(/^\\d{11}$/).required()")
  );
  assert.ok(read("Models/UserModel.js").includes("nin: { type: String, default: null }"));
  assert.ok(read("Services/UserService.js").includes("{ nin }"));
  assert.ok(
    read("Repositories/UserRepository.js").includes("if (nin) identities.push({ nin: String(nin).trim() });")
  );
  assert.ok(read("Utilis/tierService.js").includes("nin: hasNIN"));
  assert.ok(read("Models/Policyconfigmodel.js").includes('requiredDocuments: ["passport", "nin"]'));
});

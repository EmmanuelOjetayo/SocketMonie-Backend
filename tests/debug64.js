const http = require("http");

function req(path, method, body, headers) {
  return new Promise((resolve) => {
    const opts = { hostname: "localhost", port: 5000, path, method,
      headers: Object.assign({ "Content-Type": "application/json" }, headers || {}) };
    const r = http.request(opts, (res) => {
      let data = "";
      const sc = res.headers["set-cookie"] || [];
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode, body: data, setCookie: sc }));
    });
    r.on("error", () => resolve({ status: 0, body: "ERR" }));
    if (body) r.write(JSON.stringify(body));
    r.end();
  });
}

(async () => {
  const login = await req("/api/auth/login", "POST", { email: "authtest@test.com", password: "TestPass123!" });
  console.log("login:", login.status);
  const cookie = (login.setCookie || []).map((c) => c.split(";")[0]).join("; ");
  const r = await req("/api/complaints", "POST", { subject: "Debug complaint", message: "debug message body" }, { Cookie: cookie });
  console.log("complaint:", r.status, r.body.substring(0, 300));
})();

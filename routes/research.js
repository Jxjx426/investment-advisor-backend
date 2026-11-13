const express = require("express");
const { instrument } = require("../services/research");
function createResearchRouter(service) {
  const router = express.Router(), attempts = new Map();
  router.use((req, res, next) => {
    const now = Date.now(), key = req.userId;
    for (const [id, entry] of attempts) if (now - entry.start >= 60000) attempts.delete(id);
    const entry = attempts.get(key) || { start: now, count: 0 };
    if (++entry.count > 40) return res.status(429).set("Retry-After", "60").json({ error: "Too many research requests. Try again in a minute." });
    attempts.set(key, entry); next();
  });
  for (const type of ["history", "news", "summary"]) {
    router[type === "summary" ? "post" : "get"](`/:market/:symbol/${type}`, async (req, res, next) => {
      try { res.json(await service[type](instrument(req.params.market, req.params.symbol), req.query.range)); }
      catch (error) {
        if (error.status) return res.status(error.status).set("Retry-After", String(error.retryAfter || 300)).json({ error: error.message });
        next(error);
      }
    });
  }
  return router;
}
module.exports = { createResearchRouter };

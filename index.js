require("dotenv").config({ quiet: true });
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const db = require("./db");
const { createTrackerRouter } = require("./routes/tracker");
const { createAuthRouter } = require("./routes/auth");
const { createQuoteService } = require("./services/quotes");
const { createUsageBudget } = require("./services/usage");
const { createResearchService } = require("./services/research");
const { createResearchRouter } = require("./routes/research");
const { snapshot, startBackupScheduler } = require("./lib/backup");

function createApp(database = db, env = process.env, quoteService, researchService) {
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET must be configured.");
  if (env.NODE_ENV === "production") {
    if (Buffer.byteLength(env.JWT_SECRET) < 32) throw new Error("Use a JWT_SECRET of at least 32 bytes in production.");
    if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required in production.");
    if (env.ENABLE_LEGACY_ROUTES === "true" || env.LOCAL_RECORDS === "true" || env.DEMO_MODE === "true") throw new Error("Local/demo and legacy routes must be disabled in production.");
  }
  const app = express();
  app.disable("x-powered-by");
  if (env.TRUST_PROXY === "1") app.set("trust proxy", 1);
  const origins = (
    env.ALLOWED_ORIGINS ||
    "http://localhost:5173,http://127.0.0.1:5173,https://investment-advisor-frontend-one.vercel.app"
  ).split(",");
  app.use(
    cors({
      origin: (origin, callback) =>
        callback(null, !origin || origins.includes(origin)),
    }),
  );
  app.use(express.json({ limit: "1mb" }));
  app.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    res.set("X-Frame-Options", "DENY");
    next();
  });
  const auth = async (req, res, next) => {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization || "");
    if (!match) return res.status(401).json({ error: "Please sign in." });
    try {
      const payload = jwt.verify(match[1], env.JWT_SECRET, {
        algorithms: ["HS256"],
      });
      if (
        !Number.isSafeInteger(payload.userId) ||
        !(
          await database.query("SELECT id FROM users WHERE id=$1", [
            payload.userId,
          ])
        ).rowCount
      )
        return res.status(401).json({ error: "Please sign in again." });
      req.userId = payload.userId;
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError)
        return res
          .status(401)
          .json({ error: "Your session expired. Please sign in again." });
      return next(error);
    }
    next();
  };
  app.get("/ping", async (req, res, next) => {
    try { await database.query("SELECT 1"); res.json({ status: "ok", phase: 3 }); }
    catch (error) { next(error); }
  });
  const budget = createUsageBudget(database, env);
  app.use("/auth", createAuthRouter(database, env.JWT_SECRET));
  app.use(
    "/tracker",
    auth,
    createTrackerRouter(
      database,
      quoteService || createQuoteService(database, env, fetch, budget),
      { demo: env.DEMO_MODE === "true", local: env.LOCAL_RECORDS === "true" },
    ),
  );
  app.use("/research", auth, createResearchRouter(researchService || createResearchService(database, env, { budget })));
  app.get("/backup", auth, async (req, res, next) => {
    try {
      res.set("Content-Disposition", `attachment; filename="investments-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(await snapshot(database, req.userId));
    } catch (error) { next(error); }
  });
  // Preserve research routes for Phase 3; all financial/research endpoints require a session.
  if (env.ENABLE_LEGACY_ROUTES === "true") {
    app.use("/holdings", auth, require("./routes/holdings"));
    app.use("/portfolio", auth, require("./routes/portfolio"));
    app.use("/news", auth, require("./routes/news"));
  }
  app.use((req, res) => res.status(404).json({ error: "Endpoint not found." }));
  app.use((error, req, res, next) => {
    // eslint-disable-line no-unused-vars
    if (!error.status || error.status >= 500)
      console.error("Request failed:", error.message);
    const status = error.status || 500;
    res.status(status).json({
      error:
        status < 500
          ? error.message
          : "The server could not complete this request. Try again.",
    });
  });
  return app;
}
if (require.main === module) {
  db.init()
    .then(() => {
      const port = Number(process.env.PORT || 3000);
      const host = process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1");
      const scheduler = startBackupScheduler(db);
      const server = createApp().listen(port, host, () =>
        console.log(
          `Tracker API ready at http://${host}:${port}`,
        ),
      );
      for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
        server.close(async () => { await scheduler.stop(); await db.close(); process.exit(0); });
      });
    })
    .catch((error) => {
      console.error("Startup failed:", error.message);
      process.exitCode = 1;
    });
}
module.exports = { createApp };

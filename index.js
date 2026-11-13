require("dotenv").config({ quiet: true });
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const db = require("./db");
const { createTrackerRouter } = require("./routes/tracker");
const { createAuthRouter } = require("./routes/auth");
const { createQuoteService } = require("./services/quotes");

function createApp(database = db, env = process.env, quoteService) {
  if (!env.JWT_SECRET) throw new Error("JWT_SECRET must be configured.");
  const app = express();
  app.disable("x-powered-by");
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
  app.get("/ping", (req, res) => res.json({ status: "ok", phase: 1 }));
  app.use("/auth", createAuthRouter(database, env.JWT_SECRET));
  app.use(
    "/tracker",
    auth,
    createTrackerRouter(
      database,
      quoteService || createQuoteService(database, env),
      { demo: env.DEMO_MODE === "true", local: env.LOCAL_RECORDS === "true" },
    ),
  );
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
      createApp().listen(port, process.env.HOST || "127.0.0.1", () =>
        console.log(
          `Tracker API ready at http://${process.env.HOST || "127.0.0.1"}:${port}`,
        ),
      );
    })
    .catch((error) => {
      console.error("Startup failed:", error.message);
      process.exitCode = 1;
    });
}
module.exports = { createApp };

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
function createAuthRouter(db, secret) {
  const router = express.Router();
  const attempts = new Map();
  router.post("/register", (req, res) =>
    res
      .status(403)
      .json({
        error: "Public registration is disabled. Use your existing account.",
      }),
  );
  router.post("/login", async (req, res) => {
    const key = req.ip;
    const now = Date.now();
    const previous = attempts.get(key);
    const limit =
      previous && previous.until > now
        ? previous
        : { count: 0, until: now + 15 * 60 * 1000 };
    if (limit.count >= 20)
      return res
        .status(429)
        .json({ error: "Too many login attempts. Try again in 15 minutes." });
    limit.count += 1;
    attempts.set(key, limit);
    // Bound memory use on long-running private servers.
    if (attempts.size > 1000)
      for (const [ip, entry] of attempts)
        if (entry.until <= now) attempts.delete(ip);
    const { email, password } = req.body || {};
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      email.length > 254 ||
      password.length > 200
    )
      return res.status(400).json({ error: "Enter your email and password." });
    const user = (
      await db.query(
        "SELECT id,email,password_hash FROM users WHERE email=$1",
        [email.trim().toLowerCase()],
      )
    ).rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: "Email or password is incorrect." });
    attempts.delete(key);
    res.json({
      token: jwt.sign({ userId: user.id, email: user.email }, secret, {
        expiresIn: "7d",
        algorithm: "HS256",
      }),
      email: user.email,
    });
  });
  return router;
}
module.exports = { createAuthRouter };

require('dotenv').config();
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const pool = require('../db');
const jwt = require('jsonwebtoken');

router.post('/register', express.json(), async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '请输入email和密码' });
  }

  try {
    const existingResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );

    // pool.query(...)回传的不是资料本身，而是一个"结果物件"，真正的资料在.rows这个欄位里（一个array）
    if (existingResult.rows.length > 0) {
      return res.status(400).json({ error: '这个email已经被注册过了' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    // 这是把使用者输入的原始密码，转换成一串看起来完全无法逆推回原文的乱码
    // 10 叫salt rounds（加盐次数），数字越高，加密运算越慢、越安全（但也越吃运算资源）

    const insertResult = await pool.query(
      // 要用RETURNING这个关键字，明确告诉PostgreSQL"新增完后，把这些欄位回传给我"。
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
      [email, passwordHash]
    );
    // PostgreSQL用**$1、$2...当占位符（不是SQLite的?），后面用一个array**依序对应每个占位符的实际值。
    // 这次[email, passwordHash]有两个值，分别对应$1和$2

    res.json(insertResult.rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to register' });
  }
});

router.post('/login', express.json(), async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: '请输入email和密码' });
  }

  try {
    const userResult = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    const user = userResult.rows[0];

    if (!user) {
      return res.status(401).json({ error: 'email或密码错误' });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatches) {
      return res.status(401).json({ error: 'email或密码错误' });
    }

    const token = jwt.sign( // 产生token的地方
      { userId: user.id, email: user.email }, // "包"进token里的资料，叫payload。
      process.env.JWT_SECRET, // 用这把密钥，把整个payload加密签名
      { expiresIn: '7d' } // 设定这个token7天后失效
    );

    res.json({ token, email: user.email });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

module.exports = router;
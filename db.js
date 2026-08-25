const { Pool } = require('pg');
/*
PostgreSQL是"真正的数据库服务器"（不像SQLite是单一文件），Pool代表"一组随时可以重复
使用的连接"，比每次都开一条新连接更有效率。这是PostgreSQL常见的使用模式。
*/

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Supabase要求用加密连接（SSL），这行是让Node.js的pg库知道要用SSL连线。
  // rejectUnauthorized: false是简化的安全性设定，对个人专案来说足够，正式大型产品会用更严谨的憑證设定。
});

// PostgreSQL的每一个操作，都是非同步的（要await），不像better-sqlite3是同步的
// 这代表你所有用到数据库的地方，都要改成await的写法，包括所有route。
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  // SERIAL PRIMARY KEY 取代 INTEGER PRIMARY KEY AUTOINCREMENT
  // 这是PostgreSQL自己的"自动递增"语法，功能上等同SQLite的AUTOINCREMENT，只是关键字不同。

  await pool.query(`
    CREATE TABLE IF NOT EXISTS holdings (
      id SERIAL PRIMARY KEY,
      symbol TEXT NOT NULL,
      quantity REAL NOT NULL,
      avg_buy_price REAL NOT NULL,
      user_id INTEGER REFERENCES users(id)
    )
  `);
  // REFERENCES users(id)  这是PostgreSQL的**外键（foreign key）**语法
}

initDb().catch((err) => {
  console.error('数据库初始化失败:', err);
});

module.exports = pool;
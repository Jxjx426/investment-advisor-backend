// CRUD 相关
/*
1. app.get('/holdings', ...) 变成 router.get('/', ...) — 因为"/holdings"这个前缀待会儿会在index.js统一指定，这个文件里只管"holdings底下"的路径
2. require('../db') — 注意是../db（上一层），因为这个文件在routes资料夹里，db.js在外面
3. 最后module.exports = router — 把这个route整包导出去
*/

const express = require('express');
const router = express.Router();
const pool = require('../db');

// 查询所有持仓 (Read) — 只回传属于自己的
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM holdings WHERE user_id = $1',
      [req.userId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to fetch holdings' });
  }
});

// 新增持仓 (Create)
router.post('/', express.json(), async (req, res) => {
  const { symbol, quantity, avg_buy_price } = req.body;
  const apiKey = process.env.FINNHUB_API_KEY;
  const upperSymbol = symbol.toUpperCase();

  try {
    const checkResponse = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${upperSymbol}&token=${apiKey}`
    );
    const checkData = await checkResponse.json();

    if (checkData.c === 0 && checkData.h === 0 && checkData.l === 0) {
      return res.status(400).json({ error: `找不到股票代号 "${symbol}"，请确认输入是否正确` });
    }

    const existingResult = await pool.query(
      'SELECT * FROM holdings WHERE symbol = $1 AND user_id = $2',
      [upperSymbol, req.userId]
    );
    const existing = existingResult.rows[0];

    if (existing) {
      const newQuantity = existing.quantity + Number(quantity);
      const newAvgPrice =
        (existing.quantity * existing.avg_buy_price +
          Number(quantity) * Number(avg_buy_price)) /
        newQuantity;

      await pool.query(
        'UPDATE holdings SET quantity = $1, avg_buy_price = $2 WHERE id = $3',
        [newQuantity, newAvgPrice, existing.id]
      );

      return res.json({
        id: existing.id,
        symbol: upperSymbol,
        quantity: newQuantity,
        avg_buy_price: Number(newAvgPrice.toFixed(2)),
        merged: true,
      });
    }

    const insertResult = await pool.query(
      'INSERT INTO holdings (symbol, quantity, avg_buy_price, user_id) VALUES ($1, $2, $3, $4) RETURNING id',
      [upperSymbol, quantity, avg_buy_price, req.userId]
    );

    res.json({
      id: insertResult.rows[0].id,
      symbol: upperSymbol,
      quantity,
      avg_buy_price,
      merged: false,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to verify or add holding' });
  }
});

// 修改持仓 (Update)
router.put('/:id', express.json(), async (req, res) => {
  const { id } = req.params;
  const { symbol, quantity, avg_buy_price } = req.body;

  try {
    const result = await pool.query(
      'UPDATE holdings SET symbol = $1, quantity = $2, avg_buy_price = $3 WHERE id = $4 AND user_id = $5',
      [symbol, quantity, avg_buy_price, id, req.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Holding not found' });
    }
    res.json({ id: Number(id), symbol, quantity, avg_buy_price });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to update holding' });
  }
});


// 删除持仓 (Delete)
router.delete('/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      'DELETE FROM holdings WHERE id = $1 AND user_id = $2',
      [id, req.userId]
    );

    if (result.rowCount === 0) { // SQLite用result.changes看"改了几行"，PostgreSQL用result.rowCount
      return res.status(404).json({ error: 'Holding not found' });
    }
    res.json({ message: `Holding ${id} deleted` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to delete holding' });
  }
});

module.exports = router;
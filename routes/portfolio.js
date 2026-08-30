// portfolio summary

const express = require('express');
const router = express.Router(); 
// 这是Express提供的"迷你app"功能，让你可以把一群相关的route包成一个模组，
// 之后整包"挂载"到主app上。
const pool = require('../db');
const requireAuth = require('../middleware/auth');

router.get('/summary', requireAuth, async (req, res) => {
  // 之前所有route的function前面都没有async，这次有了，因为这个route内部要"等"外部API回应，
  // 才能继续往下做事。没有async/await的话，JavaScript会不等结果就往下跑，你会拿到还没准备好的资料。
  if (!req.userId) {
    return res.status(401).json({ error: '请先登入' });
  }

  const apiKey = process.env.FINNHUB_API_KEY;
  try {
    const holdingsResult = await pool.query(
      'SELECT * FROM holdings WHERE user_id = $1',
      [req.userId]
    );
    const holdings = holdingsResult.rows;

    const enrichedHoldings = await Promise.all(
    // 这是关键的新东西。如果你有5笔holdings，理论上可以一笔一笔慢慢去问Finnhub（第1笔问完等回应，才问第2笔...），但那样很慢。
    // Promise.all的作用是：同时把5个请求都发出去，然后一起等全部回应回来，再继续往下做。这样比逐一等快很多。 
      holdings.map(async (holding) => {
        // map你可能在JS基础学过——把array里每一笔资料都做同一件事，回传一个新array。这里特别的是，
        // 每次做的事情里面有await（要去问Finnhub要价格），所以每个都是一个"还没完成的承诺"（Promise）。
        try{
          const response = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${holding.symbol}&token=${apiKey}`
          );
          // fetch是用来发HTTP请求的（跟浏览器网址栏输入网址、Postman发请求，本质是同一件事，
          // 只是这次是你的backend自己去当"客户端"，向Finnhub要资料）。
          // await的意思是"先暂停在这一行，等Finnhub回应了再继续"
          const priceData = await response.json();
          // Finnhub回传的是原始的HTTP response，
          // 还要再"解析"一次才能变成你能用的JavaScript物件——这也是要等的，所以再await一次。
          const currentPrice = priceData.c;

          if (!currentPrice) {
            console.error(`无法取得 ${holding.symbol} 的价格:`, priceData);
            return {
              id: holding.id,
              symbol: holding.symbol,
              quantity: holding.quantity,
              avgBuyPrice: holding.avg_buy_price,
              currentPrice: null,
              currentValue: null,
              gainLoss: null,
              gainLossPercent: null,
            };
          }

          const currentValue = currentPrice * holding.quantity;
          const costBasis = holding.avg_buy_price * holding.quantity;
          const gainLoss = currentValue - costBasis;
          const gainLossPercent = (gainLoss / costBasis) * 100;

          return {
            id: holding.id,
            symbol: holding.symbol,
            quantity: holding.quantity,
            avgBuyPrice: holding.avg_buy_price,
            currentPrice,
            currentValue,
            gainLoss,
            gainLossPercent,
          };
          /*
          Finnhub这个API回传的资料长这样：
          {
          "c": 180.5,   // current price
          "d": 2.3,     // change
          "dp": 1.29,   // percent change
          "h": 182.0,   // high of day
          "l": 178.9    // low of day
          }
          你代码里把它转成更好读的名字（currentPrice、change等）再回传
          */ 
    }catch(error){
      console.error(`查询 ${holding.symbol} 价格失败:`, error);
      return {
        id: holding.id,
        symbol: holding.symbol,
        quantity: holding.quantity,
        avgBuyPrice: holding.avg_buy_price,
        currentPrice: null,
        currentValue: null,
        gainLoss: null,
        gainLossPercent: null,
      };
    }
  })
);

    const totalValue = enrichedHoldings.reduce((sum, h) => sum + (h.currentValue || 0), 0);
    const totalCost = enrichedHoldings.reduce(
      (sum, h) => sum + h.avgBuyPrice * h.quantity, 0
    );
    // 这也是JS的array方法，作用是把一个array"压缩"成一个值。
    // 这里用来把每一笔holding的currentValue加总，得出totalValue。
    const totalGainLoss = totalValue - totalCost;

    res.json({
      holdings: enrichedHoldings,
      totalValue,
      totalCost,
      totalGainLoss,
      totalGainLossPercent: totalCost === 0 ? 0 : (totalGainLoss / totalCost) * 100,    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch portfolio summary' });
  }
  /*
  200 成功
  201 新增成功（有些人POST成功会用这个，不是必须，但比较规范）
  404 找不到
  400 请求本身有问题（比如漏了必填栏位）
  500 server自己出错了
  */
});

router.get('/history/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').toUpperCase();
  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!symbol) {
    return res.status(400).json({ error: 'Missing symbol' });
  }

  if (!apiKey) {
    return res.status(500).json({ error: 'Missing Twelve Data API key' });
  }

  try {
    const response = await fetch(
      `https://api.twelvedata.com/time_series?symbol=${symbol}&interval=1day&outputsize=30&apikey=${apiKey}`
    );
    const data = await response.json();

    if (!response.ok || data.status === 'error' || !Array.isArray(data.values)) {
      console.error(`无法取得 ${symbol} 的历史价格:`, data);
      return res.status(404).json({ error: 'No historical data available' });
    }

    const history = data.values
      .map((point) => ({
        date: point.datetime,
        price: Number(point.close),
      }))
      .filter((point) => Number.isFinite(point.price))
      .reverse();

    return res.json({ symbol, history });
  } catch (error) {
    console.error(`Failed to fetch history for ${symbol}:`, error);
    return res.status(500).json({ error: 'Failed to fetch price history' });
  }
});

module.exports = router;
// news + ai analysis
const express = require('express');
const router = express.Router();
const { GoogleGenAI } = require('@google/genai');
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const POSITIVE_WORDS = ['rally', 'surge', 'gain', 'growth', 'upgrade', 'beat', 'soar', 'jump', 'rise', 'bullish', 'buy', 'strong'];
const NEGATIVE_WORDS = ['drop', 'decline', 'cut', 'miss', 'downgrade', 'fall', 'plunge', 'sink', 'bearish', 'sell', 'weak', 'loss'];
function buildNewsSummaryPrompt(symbol, headlines) {
  return `你是一位专业的财经新闻编辑，任务是帮读者快速掌握某支股票的近期新闻重点。

    股票代号：${symbol}

    以下是相关英文新闻标题（依发布时间排序）：
    ${headlines}

    请完成以下任务：
    1. 只关注与「${symbol}」这家公司直接相关的新闻，忽略提及该代号但主题其实是其他公司或机构的新闻（例如只是「某基金买入该股票」这类间接提及）。
    2. 用简体中文，将S相关新闻归纳成2-3个主题类别（例如：财报与营收、产品与技术、市场情绪与股价、政策与法规等，依实际内容决定分类，不要硬套）。
    3. 完全不要提及你做了哪些筛选或忽略了哪些标题——直接呈现整理好的结果。
    4. 内容尽量丰富一点详细，易懂！！
    5. 输出必须是纯文字，绝对不要使用星号、井号、破折号等任何格式符号。
    6. 如果提供的新闻标题内容稀少、模糊、或明显与「${symbol}」这支股票无关，请直接回复：「目前没有足够的相关新闻可供摘要。」不要编造任何财报数字、高管言论、产品资讯或其他具体细节。
    请直接输出摘要内容，不要加开头的客套话（例如「好的，以下是摘要」），也不要加结尾总结句。`;
}

router.get('/:symbol', async (req, res) => {
  const { symbol } = req.params;
  const apiKey = process.env.NEWS_API_KEY;
  const finnhubKey = process.env.FINNHUB_API_KEY;

   try {
    const checkResponse = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${symbol.toUpperCase()}&token=${finnhubKey}`
    );
    const checkData = await checkResponse.json();

    if (checkData.c === 0 && checkData.h === 0 && checkData.l === 0) {
      return res.status(400).json({ error: `找不到股票代号 "${symbol}"，请确认输入是否正确` });
    }

    const response = await fetch(
      `https://newsapi.org/v2/everything?q=${symbol}&sortBy=publishedAt&language=en&pageSize=10&apiKey=${apiKey}`
      //sortBy=publishedAt — 让最新的新闻排前面
    );
    const data = await response.json();

    const articles = data.articles.map((article) => ({
      title: article.title,
      source: article.source.name,
      url: article.url,
      publishedAt: article.publishedAt,
    }));
    // NewsAPI回传的原始资料每篇文章包含很多栏位（描述、图片网址等），我们只挑需要的几个（标题、来源、链接、日期）重新包装，
    // 丢掉用不到的资讯——这跟你处理股价资料时"转换成更干净的格式"是同一个概念

    res.json({ symbol: symbol.toUpperCase(), articles });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch news' });
  }
});

router.get('/:symbol/analysis', async (req, res) => {
  const { symbol } = req.params;
  const newsApiKey = process.env.NEWS_API_KEY;

  try {
    const newsResponse = await fetch(
      `https://newsapi.org/v2/everything?q=${symbol}&sortBy=publishedAt&language=en&pageSize=20&apiKey=${newsApiKey}`
    );
    const newsData = await newsResponse.json();

    if (!newsData.articles || newsData.articles.length === 0) {
      return res.status(404).json({
        error: `找不到与 "${symbol}" 相关的新闻，请确认代号是否正确`,
      });
    }

    let positiveCount = 0;
    let negativeCount = 0;

    newsData.articles.forEach((article) => {
      const title = article.title.toLowerCase();
      POSITIVE_WORDS.forEach((word) => {
        if (title.includes(word)) positiveCount++;
      });
      NEGATIVE_WORDS.forEach((word) => {
        if (title.includes(word)) negativeCount++;
      });
    });

    const totalSignals = positiveCount + negativeCount;
    let sentiment = 'neutral';
    if (totalSignals > 0) {
      const positiveRatio = positiveCount / totalSignals;
      if (positiveRatio > 0.6) sentiment = 'leaning positive';
      else if (positiveRatio < 0.4) sentiment = 'leaning negative';
    }

    const headlines = newsData.articles
      .slice(0, 10)  // 取前十个
      .map((a, i) => `${i + 1}. ${a.title}`) //template literal（模板字串），用反引号 ` 包起来，里面${...}会被替换成实际的值。
      // .map = 跑过array里每一个元素，做点事，回传新的array
      // a — 代表当前这篇文章（跟之前用article是一样的意思，只是这里偷懒缩写）
      // i — 代表这是array里的第几个（从0开始算），这是map额外提供的一个"index编号"，你不用自己算，JavaScript自动帮你数
      .join('\n');
      // 把新闻标题们拼成一段编号列表，塞进你要问Claude的问题里。
      // 这叫prompt engineering——你怎么问，会决定它怎么答

    const result = await genAI.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: buildNewsSummaryPrompt(symbol, headlines),
    });

    // 3. 合并回传
    res.json({
      symbol: symbol.toUpperCase(),
      articlesAnalyzed: newsData.articles.length,
      sentiment: {
        label: sentiment,
        positiveSignals: positiveCount,
        negativeSignals: negativeCount,
      },
      summary: result.text,
      note: '情绪标记基于关键字比对，摘要由AI生成 — 仅整理新闻内容，不构成投资建议。',
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Failed to generate news analysis' });
  }
});

module.exports = router;
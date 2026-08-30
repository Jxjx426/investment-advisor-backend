require('dotenv').config();
const cors = require('cors');
/*
CORS（跨来源资源共享）是浏览器内建的一个安全机制：默认情况下，网页只能跟"自己的来源"（同一个网址+port）沟通，
如果要跟不同的来源（你的情况是localhost:5173 → localhost:3000，port不同就算不同来源）沟通，
对方必须明确声明"我允许这个来源来问我要资料"，否则浏览器会直接挡下来，不管你的backend其实有没有正确回应。
*/
const express = require('express');
const app = express();
const PORT = 3000;

const allowedOrigins = [
  'https://investment-advisor-frontend-one.vercel.app',
  'http://localhost:5173',
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
}));
/*
cors()这个套件，作用就是帮你的Express server自动加上"我允许任何来源访问"的允许标头。
开发阶段这样设定完全没问题，正式上线之前可以再限制成"只允许我的前端网址访问"，会更安全
*/

const holdingsRouter = require('./routes/holdings');
const portfolioRouter = require('./routes/portfolio');
const newsRouter = require('./routes/news');
const authRouter = require('./routes/auth');
const requireAuth = require('./middleware/auth');

app.get('/', (req, res) => {
  res.send('Backend is alive!');
});

app.get('/ping', (req, res) => {
  res.json({ message: 'pong', status: 'ok' });
});

app.use('/holdings', requireAuth, holdingsRouter);
app.use('/portfolio', requireAuth, portfolioRouter);
app.use('/news', newsRouter);
app.use('/auth', authRouter);
// 意思是"任何以/holdings开头的请求，都交给holdingsRouter处理"。
// 所以holdings.js里写的router.get('/')，实际上对应的完整网址是/holdings；
// router.get('/:id')对应的是/holdings/:id。
// 这就是为什么之前那些route里，路径都要"去掉/holdings这个前缀"重写。

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
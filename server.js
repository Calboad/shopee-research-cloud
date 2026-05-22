import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import researchRoutes from './routes/research.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

const exportsDir = path.join(__dirname, 'exports');
if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });

app.use(cors({
  origin: true,
  credentials: false,
  allowedHeaders: ['Content-Type', 'X-Auth-Token'],
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.parse.failed' || err.type === 'entity.too.large' || err.status === 400)) {
    console.error('[body-parser]', req.method, req.url, '→', err.type || err.status, err.message);
    return res.status(400).json({
      ok: false,
      error: `请求体解析失败：${err.type || err.status} — ${err.message}`,
    });
  }
  next(err);
});

app.use('/exports', express.static(exportsDir));

app.use('/api/research', researchRoutes);

app.get('/', (req, res) => {
  res.json({
    service: 'shopee-research-cloud',
    health: '/api/research/health',
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`Shopee research cloud server running at :${PORT}`);
  console.log(`Health: /api/research/health`);
  console.log(`AUTH_TOKEN required: ${!!process.env.AUTH_TOKEN}`);
  console.log(`GEMINI_API_KEY configured: ${!!process.env.GEMINI_API_KEY}`);
});

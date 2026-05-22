# Shopee 调研工具 — 云端精简版

仅含 Shopee 调研路由（采集数据导出 Excel + 调研报告），剥离 ImageForge / playwright / sharp 等本地重依赖，跑得动 Render / Railway / Fly 免费层。

## 本地启动

```
cd cloud
npm install
cp .env.example .env   # 填 AUTH_TOKEN + GEMINI_API_KEY
npm start
```

健康检查：http://127.0.0.1:3001/api/research/health

## Render 部署

1. 把 `cloud/` 推到独立 GitHub 仓库（仓库根 = 本目录，不是父目录）
2. Render → New → Web Service → Connect 这个仓库
3. Build Command：`npm install`
4. Start Command：`node server.js`
5. Health Check Path：`/api/research/health`
6. Environment 添加：
   - `AUTH_TOKEN`（已有的 48 位串）
   - `GEMINI_API_KEY`
7. Deploy 完成后，把 Render 给的 URL（如 `https://shopee-research.onrender.com`）填进扩展 popup
8. （可选）Cloudflare DNS 把 `shopee-research.koorfly-ai.online` 改成 CNAME 指向 Render URL，扩展端 URL 不用改

## 与本地版的差异

- 不依赖 OpenVPN / HTTPS_PROXY：Render 海外节点直连 Gemini
- exports 文件落 `cloud/exports/`，但导出走 base64 优先，URL 只是兜底
- Render 免费层 15 分钟无访问会睡眠，下次请求需 30 秒冷启动；同事使用前先点扩展 popup「测试连接」唤醒

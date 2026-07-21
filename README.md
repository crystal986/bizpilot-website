# BizPilot Website

BizPilot (https://bizpilot.co) 官网的静态站点版本，从 GoHighLevel (GHL) 导出，保持原有排版、配色与内容。

## 页面

| 文件 | 原始路径 | 说明 |
|------|----------|------|
| `index.html` | `/` (`/home-cn`) | 首页 |
| `ai-jingyingli.html` | `/ai-jingyingli` | AI 经营力课程 |
| `ai-automation-guide.html` | `/ai-automation-guide` | AI 自动化完整指南 |
| `automation-risk.html` | `/automation-risk` | 自动化风险解析 |
| `bizpilot-community.html` | `/bizpilot-community` | 会员社区 |
| `contact.html` | `/contact` | 关于与联系 |
| `ai-automation-stage-test.html` | `/ai-automation-stage-test` | 3 分钟阶段测试 |
| `start-ai-decision-page.html` | `/start-ai-decision-page` | 阶段判断入口页 |

## 说明

- 图片已全部下载到 `assets/images/`（120 个文件），不再依赖 GHL 媒体 CDN。
- 页面样式为内联 CSS，交互脚本仍加载 GHL 公共静态 CDN（`stcdn.leadconnectorhq.com`），表单/测试等功能仍提交到 GHL 后端。
- Google 字体（Fira Sans Condensed / Poppins / Roboto）通过 Google Fonts CDN 加载。
- Cloudflare 邮箱混淆已解码为明文 `mailto:` 链接。

## 本地预览

```bash
python3 -m http.server 8000
# 打开 http://localhost:8000
```

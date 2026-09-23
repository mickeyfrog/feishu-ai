# 组内 AI（feishu-ai）· 第四阶段：真实可用的组内 GPT

一个嵌入 **飞书** 的组内 AI 聊天应用。

当前版本已经打通完整链路：

> 飞书 OAuth 登录 → 每个人自己的账号 → 每个人自己的聊天列表 →
> 每个聊天窗口独立的上下文 → OpenAI Responses API **流式输出** →
> SQLite 保存聊天记录（刷新页面后仍然存在）

张三和李四登录后看到的是**各自完全隔离**的会话；李四无论怎么改 URL / 参数都拿不到张三的数据
（归属由后端 session 强制校验，越权统一返回 404）。
>
> 📦 各阶段「已完成事项」的完整归档（含测试结论、运行状态与踩坑记录）见 [ARCHIVE.md](./ARCHIVE.md)。

---

## 一、环境要求

| 项目 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11（macOS、Linux 同样可用） |
| Node.js | **18 及以上**，推荐 LTS 版本 |
| 包管理器 | npm（安装 Node.js 时自带） |
| 编辑器 | VSCode（可选） |
| 浏览器 | Chrome / Edge 等现代浏览器 |

### 检查 Node.js 是否已安装

打开 **PowerShell** 或 **CMD**，输入：

```bash
node -v
npm -v
```

能看到版本号（例如 `v24.14.0`、`11.9.0`）就说明已经装好。
如果提示“不是内部或外部命令”，请先到 <https://nodejs.org/> 下载 **LTS 版本** 安装（一路下一步即可）。

---

## 二、安装

在项目根目录（`D:\feishu-ai`）打开终端：

- VSCode：菜单 **终端 → 新建终端**
- 或者在文件夹地址栏输入 `powershell` 回车

然后执行：

```bash
npm install
```

看到类似 `added 60 packages` 就表示安装成功，会生成一个 `node_modules` 文件夹。

> 如果下载很慢，可以临时使用国内镜像：
> ```bash
> npm install --registry=https://registry.npmmirror.com
> ```

---

## 三、启动

```bash
npm start
```

或者等价的：

```bash
node server.js
```

终端会输出：

```text
飞书 AI 服务已启动
访问地址：http://localhost:3000
接口自检：http://localhost:3000/api/test
```

**停止服务**：在终端按 `Ctrl + C`。

> 开发时想让代码改动自动重启，可以用：`npm run dev`

---

## 四、浏览器访问

打开浏览器，访问：

👉 <http://localhost:3000>

你会看到一个类 ChatGPT 的界面：

- **左侧**：Logo、“组内 AI”、＋新建对话、历史对话（模拟数据）、底部当前用户
- **右侧**：顶部栏（标题 / 当前模型 / 当前用户）、聊天区域、底部输入框
- **首次打开**：中间显示“有什么可以帮忙的？”和 4 个快捷问题卡片

在输入框输入 **你好** 并回车，会看到：

```text
你好                                        ← 你的消息（右侧灰色气泡）

AI  这是测试回复，AI 接口将在下一阶段接入。      ← 后端返回（左侧）
```

---

## 五、API 测试

### 1）健康检查

浏览器直接打开，或用命令：

👉 <http://localhost:3000/api/test>

```bash
curl http://localhost:3000/api/test
```

返回：

```json
{ "success": true, "message": "飞书 AI 后端运行正常" }
```

### 2）会话与聊天接口（需要飞书登录）

第四阶段的业务接口都需要登录态 Cookie，未登录统一返回 **401** `{ "success": false, "message": "请先登录飞书" }`：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/conversations` | 列出当前用户自己的会话（updated_at 倒序） |
| POST | `/api/conversations` | 新建会话（标题默认「新对话」） |
| PATCH | `/api/conversations/:id` | 重命名 |
| DELETE | `/api/conversations/:id` | 删除（消息随外键级联删除） |
| GET | `/api/conversations/:id/messages` | 读取该会话的历史消息 |
| POST | `/api/conversations/:id/chat` | 非流式聊天 |
| POST | `/api/conversations/:id/chat/stream` | **流式聊天（SSE）** |

未配置 `OPENAI_API_KEY` 时，两个聊天接口返回 **503** `{ "success": false, "message": "服务器尚未配置 AI API" }`。
字段与行为细节见文末「十三、第四阶段」。

---

## 六、项目结构

```text
feishu-ai/
├── public/              # 前端静态文件（由 Express 托管）
│   ├── index.html       # 页面结构
│   ├── style.css        # 样式（简洁现代 / 响应式）
│   └── app.js           # 交互逻辑（调用 /api/chat）
├── server.js            # Node.js + Express 后端入口
├── package.json         # 项目配置与依赖（ES Module）
├── .env.example         # 环境变量示例（复制为 .env 使用）
├── .gitignore           # Git 忽略规则
└── README.md            # 当前这份说明
```

数据流（本阶段）：

```text
浏览器输入框
   ↓ fetch POST /api/chat  { "message": "..." }
Express（server.js）
   ↓ 校验 message 非空
返回 { "success": true, "answer": "这是测试回复..." }
   ↓
app.js 用 textContent 渲染到聊天区域
```

---

## 七、已实现的功能

**界面**

- 类 ChatGPT 的现代布局：白色 / 浅灰、圆角、轻阴影、良好留白
- 左侧栏 264px（窄屏自动变为覆盖层），右侧顶部栏 60px
- 欢迎页 + 4 个快捷问题卡片（点击自动填入输入框）
- 用户消息右侧灰色气泡、AI 消息左侧正文排版
- 纯 CSS / 内联 SVG 图标与头像，**不依赖任何网络图片**

**交互**

1. ＋新建对话：调用 `POST /api/conversations` 创建真实会话并回到欢迎页
2. 输入框自动增高，最大 180px 后内部滚动
3. `Enter` 发送，`Shift + Enter` 换行
4. 左侧历史对话来自 `GET /api/conversations`（只有自己的），点击加载真实消息；每条带「⋯」菜单：重命名 / 删除
5. 发送后先显示“AI 正在思考...”，随后 AI 回复**逐字流式**渲染（Markdown + 代码块）
6. 发送过程中禁用发送按钮，防止重复提交
7. 新消息自动滚动到底部
8. 请求失败时显示“请求失败，请检查服务器状态。”
9. 顶部栏实时显示后端连接状态（页面加载时自检 `/api/test`）
10. `☰` 按钮收起 / 展开侧边栏；窄屏下侧边栏为覆盖层，点遮罩或按 `Esc` 关闭
11. 未登录时输入区锁定，占位符提示「使用飞书登录后开始对话」；点击快捷卡片会提示先登录
12. 刷新页面后历史会话与聊天记录仍然存在（数据在服务端 SQLite）

**安全**

- 用户输入只通过 `textContent` / `createElement` 渲染，**没有使用 `innerHTML` 注入用户内容**，避免基础 XSS
- 后端限制 JSON 请求体大小（1MB），并统一处理 404 / 500 / JSON 解析错误

**响应式**

- 适配 1920×1080、1440×900、普通笔记本、飞书内嵌窗口
- ≤900px：侧边栏变覆盖层；≤560px：快捷卡片单列、隐藏次要信息；≤380px：进一步压缩边距

---

## 八、环境变量

项目使用 `dotenv` 读取根目录下的 `.env`（**没有 `.env` 也能正常启动**）。

如需修改端口：

```bash
# Windows PowerShell
Copy-Item .env.example .env
```

然后编辑 `.env`：

```ini
PORT=3000
```

改完重新 `npm start`，访问地址中的端口会同步变化。
`.env` 已加入 `.gitignore`，不会被提交到 Git。

---

## 九、常见问题（零基础排查）

**1. 启动报错：`端口 3000 已被占用`**
说明 3000 端口被别的程序占了。两种解决办法：
- 关掉占用程序（常见：另一个没关的 node 窗口、其他本地服务）
- 或在 `.env` 里写 `PORT=3001`，重启后访问 <http://localhost:3001>

查看占用端口的命令（PowerShell）：

```powershell
netstat -ano | findstr :3000
```

**2. 打开网页一片空白 / 没有样式**
- 确认终端里服务已经启动且没有报错
- 确认访问的是 <http://localhost:3000> 而不是直接双击打开 `index.html`
  （双击打开时是 `file://` 协议，接口请求会失败）
- 按 `Ctrl + F5` 强制刷新一次

**3. 发送消息后提示“请求失败，请检查服务器状态。”**
- 后端没启动：重新执行 `npm start`
- 端口改了但网页还是旧地址：用终端里打印的地址访问
- 看终端是否有报错信息

**4. `npm install` 失败**
- 检查网络，或换镜像：`npm install --registry=https://registry.npmmirror.com`
- 删除 `node_modules` 文件夹和 `package-lock.json` 后重新 `npm install`

**5. 修改了代码但页面没变化**
- 前端文件（`public/`）：浏览器 `Ctrl + F5` 刷新即可
- 后端文件（`server.js`）：需要 `Ctrl + C` 停止后重新 `npm start`（或用 `npm run dev` 自动重启）

---

## 十、下一阶段计划（本阶段故意不做）

- [ ] 接入 OpenAI / 其他大模型，替换 `/api/chat` 里的模拟回复（支持流式输出）
- [x] 飞书 OAuth 登录（第三阶段已完成：`/auth/feishu`、`/auth/feishu/callback`、`/api/me`、`/auth/logout`）
- [ ] 数据库（SQLite / PostgreSQL）持久化会话与消息
- [ ] 每个成员拥有独立的历史对话，左侧栏改为真实数据
- [ ] 打包为飞书内嵌网页（H5 应用），配置可信域名与免登

---

## 十一、技术栈

- 后端：**Node.js + Express 5 + dotenv**（ES Module，`"type": "module"`）
- 前端：**原生 HTML + CSS + JavaScript**（无 React / Vue / TypeScript / UI 组件库）
- 依赖只有三个：`express`、`express-session`、`dotenv`

---

## 十二、第三阶段：飞书用户身份登录（当前版本）

不同飞书成员打开网页后，服务端通过 **飞书官方 Web OAuth（授权码模式）** 识别用户身份：
登录成功后右上角显示该成员的 **头像 + 姓名**，后端 session 中保存其稳定唯一标识 `open_id`。

### 12.1 接口一览

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/auth/feishu` | 生成 state 存入 session，302 跳转飞书官方授权页 |
| GET | `/auth/feishu/callback` | 校验 state → 服务端用 code 换 `user_access_token` → 拉取用户身份 → 写 session → 回首页 |
| GET | `/api/me` | 未登录返回 **401** `{"loggedIn":false}`；已登录返回 `{"loggedIn":true,"user":{"name","avatar","feishuUserId"}}` |
| POST | `/auth/logout` | 销毁 session、清除 Cookie |

使用的飞书官方端点（2026-09 核对的当前版本）：

```text
授权页    GET  https://accounts.feishu.cn/open-apis/authen/v1/authorize
          参数：client_id（App ID）、response_type=code、redirect_uri（URL 编码）、state
换令牌    POST https://accounts.feishu.cn/oauth/v3/token      ← 官方当前版本（v2 已标记历史版本）
          body（form-urlencoded）：grant_type=authorization_code、client_id、client_secret、code、redirect_uri
用户信息  GET  https://open.feishu.cn/open-apis/authen/v1/user_info
          头：Authorization: Bearer <user_access_token>
          取 data.open_id（应用内唯一、稳定，无需额外权限）作为 feishuUserId
```

### 12.2 你需要在 `.env` 填写的字段

```ini
PORT=3000
FEISHU_APP_ID=cli_xxxxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
FEISHU_REDIRECT_URI=https://ai.wzyiloveu.kdns.fr/auth/feishu/callback
BASE_URL=https://ai.wzyiloveu.kdns.fr
SESSION_SECRET=（任意长随机串，见下方生成命令）
```

生成 SESSION_SECRET：

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

可选：`COOKIE_SECURE=false` 仅在「非 localhost 的纯 HTTP」环境调试时使用；
走 Cloudflare Tunnel（HTTPS）或 localhost 时 **不要设置**。

### 12.3 飞书开发者后台还需要配置什么

1. **创建/进入企业自建应用**：<https://open.feishu.cn/app> → 你的应用。
2. **凭证与基础信息**：复制 `App ID`、`App Secret` 填入 `.env`（App Secret 只显示一次，注意保存）。
3. **安全设置 → 重定向 URL**：添加
   `https://ai.wzyiloveu.kdns.fr/auth/feishu/callback`
   （必须与 `.env` 中 `FEISHU_REDIRECT_URI` 完全一致，否则报 `redirect_uri unmatch` / 2000）。
4. **权限管理**：本阶段登录 **不需要** 额外 API 权限（`open_id / name / avatar` 属于登录基础信息）。
   如以后需要 `user_id`（员工 ID）、邮箱、手机号，再申请 `contact:user.employee_id:readonly` 等权限。
5. **版本管理与发布**：创建版本并提交发布（企业自建应用一般管理员审核通过即可），
   并在 **可用范围** 里包含需要使用该网页的成员，否则成员授权时会报 20010（无应用使用权限）。
6. **网页应用 / 机器人能力** 均非必需；本阶段只是把网站作为 OAuth 客户端。

### 12.4 Cloudflare Tunnel / 反向代理注意事项

- 代码已 `app.set('trust proxy', 1)`，Cloudflare 传来的 `X-Forwarded-Proto: https` 会被正确识别。
- Session Cookie：`httpOnly=true`、`sameSite=lax`；`secure` 默认在对外地址为 https 时开启
  （express-session 只在请求被识别为 HTTPS 时下发 Secure Cookie，Tunnel 场景已验证可正常登录）。
- 若你在纯 HTTP 的局域网地址调试登录，临时加 `COOKIE_SECURE=false`。

### 12.5 安全约定（已实现）

- App Secret 只存在于服务端环境变量：**不进 public/、不返回前端、不硬编码、不进 Git**（`.env` 已在 `.gitignore`）。
- 用户身份只由后端通过飞书认证结果写入 session；**绝不信任浏览器提交的 user_id / open_id**（伪造 Cookie 无法冒充，已测试）。
- 授权流程带随机 `state` 防 CSRF，校验后立即失效；用户拒绝授权（`error=access_denied`）回首页提示“已取消授权”。
- `/api/me` 只返回 `name / avatar / feishuUserId`，不含 token 与任何密钥。

### 12.6 本地自测（无需真实飞书凭证）

```bash
node work/auth-test.mjs      # 进程内跑完整 OAuth 流程（stub 飞书接口），23 项断言
node work/e2e-auth-ui.mjs    # 浏览器验证未登录/已登录/退出三种 UI（拦截 /api/me）
node work/e2e-check.mjs      # 第二阶段聊天界面回归，34 项断言
```

（以上脚本位于本仓库外的开发工作区 `work/` 目录，不属于交付项目本身。）

---

## 十三、第四阶段：会话隔离 + 真实 AI 流式对话（当前版本）

### 13.1 本阶段新增

- **SQLite（better-sqlite3）**：数据库文件 `data/feishu-ai.db`（目录不存在自动创建），
  `PRAGMA foreign_keys = ON`、`PRAGMA journal_mode = WAL`
- **飞书用户入库**：登录成功后以飞书稳定唯一 ID（`open_id`）为身份 upsert 到 `users` 表，
  并把数据库主键 `user.id` 写入 session；之后所有数据库操作都使用 `req.session.user.id`
- **用户隔离**：会话 / 消息接口的 SQL 一律带 `WHERE user_id = 当前用户`；
  不属于当前用户或不存在，统一返回 **404**（不告诉对方“这个对话属于别人”）
- **OpenAI Responses API**：官方 `openai` SDK，`responses.stream()` 流式；
  模型名只来自 `process.env.OPENAI_MODEL`，代码不硬编码
- **SSE 流式输出**：`POST /api/conversations/:id/chat/stream`；
  响应头带 `Cache-Control: no-cache, no-transform` 与 `X-Accel-Buffering: no`，
  在 Cloudflare Tunnel（正式 Tunnel 支持长连接）下不会被缓冲成整段
- **上下文控制**：`services/openai.js` 中集中定义 `MAX_CONTEXT_MESSAGES = 30`，
  只把最近 30 条发给模型；数据库仍保存全部历史
- **自动标题**：首条用户消息去掉换行 / 多余空白后取前 30 字，过长截断加 `...`；不额外调用 AI
- **Markdown 渲染**：前端 `marked` 解析 + `DOMPurify` 清理后才写入 innerHTML；
  用户输入仍然只走 `textContent`
- **失败语义**：AI 中途失败 / 流被截断时，前端显示「AI 回复失败，请重试。」，
  后端**不保存**半截 assistant 消息（用户消息保留）

### 13.2 数据库表结构

**users**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | 数据库内部主键（session 里存的就是它） |
| feishu_user_id | TEXT UNIQUE | 飞书 `open_id`，唯一身份 |
| name / avatar | TEXT | 姓名 / 头像 |
| created_at / updated_at | DATETIME | 时间戳 |

**conversations**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | 会话 ID |
| user_id | INTEGER FK→users.id | 归属用户，`ON DELETE CASCADE` |
| title | TEXT | 默认「新对话」 |
| created_at / updated_at | DATETIME | 列表按 `updated_at DESC` 排序 |

**messages**

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| id | INTEGER PK | 消息 ID |
| conversation_id | INTEGER FK→conversations.id | `ON DELETE CASCADE` |
| role | TEXT | 只允许 `user` / `assistant` |
| content | TEXT | 消息正文 |
| created_at | DATETIME | 读取时按 `created_at ASC` |

### 13.3 流式事件格式（SSE）

```text
data: {"type":"start","conversationId":12,"title":"LM5575 学习"}

data: {"type":"delta","text":"LM"}
data: {"type":"delta","text":"5575"}

data: {"type":"done","messageId":34,"title":"LM5575 学习"}

data: {"type":"error","message":"AI 回复失败，请重试。"}
```

前端用 `fetch` + `ReadableStream` 按 `\n\n` 切帧解析，`delta` 累积在内存里，
用 `requestAnimationFrame` 节流重渲染；**不会**每个 token 写一次数据库。

### 13.4 `.env` 需要新增的字段

```ini
# OpenAI（Responses API）
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5-mini
```

`OPENAI_MODEL` 可以随时换成你账号里可用的任意模型名；不配置时聊天接口返回
「服务器尚未配置 AI API」，其余功能（登录 / 会话列表）不受影响。

### 13.5 本地自测（无需真实飞书凭证 / 真实 OpenAI Key）

```bash
node work/auth-test.mjs          # 23 项：飞书 OAuth 全流程（打桩飞书官方接口）
node work/stage4-api-test.mjs    # 95 项：会话隔离 / 流式 / 上下文 / 失败处理 / 密钥不泄露
node work/e2e-auth-ui.mjs        # 10 项：登录态 UI（Chrome DevTools Protocol）
node work/e2e-stage4-ui.mjs      # 52 项：前端交互、流式增量、Markdown、XSS 清理、刷新持久化
```

测试使用独立临时数据库（`DB_FILE` 环境变量）与页面内打桩接口，不会污染 `data/feishu-ai.db`。

### 13.6 安全清单（本阶段再次确认）

- `FEISHU_APP_SECRET`、`OPENAI_API_KEY`、`SESSION_SECRET` 只存在于 `.env`；
  `.gitignore` 已包含 `.env`、`node_modules/`、`data/*.db`、`data/*.db-shm`、`data/*.db-wal`
- 任何接口响应都不包含密钥；`/api/me` 只返回 `name` / `avatar` / `feishuUserId`
- 绝不接受前端提交的 `user_id`：归属完全由服务端 session 决定
- 越权访问他人会话统一 404；接口响应也不暴露内部 `user_id`
- AI 的 Markdown 必须经过 DOMPurify 清理；用户输入只走 `textContent`
---

## 十四、使用 OpenAI-Compatible API（中转站）

本项目的 AI Provider 不绑定 OpenAI 官方：任何提供 **OpenAI-Compatible** 接口的中转站
（GPT / Claude / Gemini / DeepSeek / Qwen 等）都可以通过只改 `.env` 接入，代码里不写死任何中转站地址。

### 14.1 四个配置项

```ini
# 中转站给出的 OpenAI-Compatible Base URL（一般形式），代码不会再拼 /v1；
# 留空 = 连接 OpenAI 官方 https://api.openai.com/v1
AI_BASE_URL=https://example.com/v1

# 中转站提供的 API Key
AI_API_KEY=your-api-key

# 模型名称（由中转站决定）
AI_MODEL=your-model-name

# 接口模式：responses | chat_completions（默认 responses）
AI_API_MODE=chat_completions
```

| 变量 | 说明 | 留空时 |
| --- | --- | --- |
| `AI_BASE_URL` | 中转站 Base URL，**原样**交给 SDK（不要自己再补 `/v1`） | `https://api.openai.com/v1` |
| `AI_API_KEY` | API Key（优先级高于旧变量 `OPENAI_API_KEY`） | 回退读 `OPENAI_API_KEY` |
| `AI_MODEL` | 模型名（优先级高于旧变量 `OPENAI_MODEL`） | 回退读 `OPENAI_MODEL` |
| `AI_API_MODE` | `responses` 或 `chat_completions` | `responses` |

### 14.2 两种模式怎么选

- 中转站支持 `POST /v1/responses` → `AI_API_MODE=responses`
  （走 `client.responses.create()` / `responses.stream()`，含终止事件检测与流截断检测）
- 中转站只支持 `POST /v1/chat/completions` → `AI_API_MODE=chat_completions`
  （走 `client.chat.completions.create()`，流式安全解析 `choices[0].delta.content`，
  以 `finish_reason` 判断流是否正常收尾）

**模式只由 `AI_API_MODE` 决定**：某次请求失败时不会自动切换模式再发一次收费请求。
若 `responses` 模式收到 404，页面会直接提示
「当前中转站可能不支持 Responses API，请将 AI_API_MODE 改为 chat_completions。」

### 14.3 错误提示对照（中转站常见状态码）

| 上游状态 | 用户看到的提示 |
| --- | --- |
| 401 | AI API Key 无效或未授权 |
| 403 | 当前 API Key 没有该模型权限 |
| 404（responses 模式） | 当前中转站可能不支持 Responses API，请将 AI_API_MODE 改为 chat_completions。 |
| 404（其他） | AI API 地址或模型接口不存在 |
| 429 | AI 请求过于频繁或中转站额度不足 |
| 5xx | AI 服务暂时不可用 |
| 网络层失败 | 无法连接 AI 服务 |

服务器日志会记录技术细节，但任何接口响应都**不会**包含 API Key、Authorization、请求头或 `.env` 内容。

### 14.5 第五阶段：文件上传与 AI 生图

**文件上传**（聊天输入框左侧回形针按钮）：

- 格式对齐 ChatGPT 上传：`pdf / docx / doc / pptx / xlsx / xls / csv / txt / md / json / xml / html`
  + 常见代码文件（js/ts/py/java/c/cpp/go/rs/php/sql/yaml 等 46 种）+ `png / jpg / jpeg / gif / webp`
- **默认不限制文件大小**（如需兜底：`.env` 设 `UPLOAD_MAX_MB=<数字>`）
- 文档/文本类自动抽取文本进入该会话的 AI 上下文（每个附件最多 8000 字符）；pptx 逐页抽取
- **图片走多模态视觉**：发送消息时图片以 base64 内联进请求（仅当前这条消息，历史不重复发），
  kimi-k3 实测可正确描述截图内容；模型不支持视觉时 `.env` 设 `AI_VISION=false` 关闭
- **附件随消息发送**：发送后附件从输入框消失、显示在对应消息气泡里（缩略图 + 文件名）；
  待发附件（未发送的）停留在输入框 chips，可随时 × 移除
- **在线预览**：点击附件（气泡里或输入框 chips）——图片看大图、PDF 用浏览器内建渲染、
  Office 文档/表格显示抽取文本预览，均可一键下载原文件
- 文件存 `data/uploads/<用户>/<随机名>`，原始文件名只存数据库；所有接口校验归属，越权 404

**AI 生图**（顶栏「生图」按钮）：

- 只走「浏览器自动化」模式（详见 §14.8）：不调任何 API，由本机已登录 ChatGPT 的调试 Chrome 出图
  （API 生图模式已于 2026-09-20 移除，原因与实测记录见 §14.7）
- 停用：`.env` 设 `AI_IMAGE_MODEL=off`；页面会得到明确的 503 提示
- 生成结果落盘 `data/generated/` 并记入历史；只能下载自己的图（越权 404）
- 失败提示可操作：浏览器未连接（503）/ 未登录 / 超时 / 页面结构变化各有明确文案

### 14.6 联网搜索

- 输入框上的「联网」按钮：开启后每次提问先做网页检索，检索结果带编号注入上下文，
  模型回答时用 `[1] [2]` 标注来源
- 提供商（`.env` 的 `WEB_SEARCH_PROVIDER`）：
  - `duckduckgo`（默认，**免 Key**，实测本机 1~2s 出结果）
  - `searxng`（**免 Key** 元搜索，聚合 Google/Bing 等；`SEARXNG_BASE_URL` 可配多个实例逗号分隔做实例级转移；
    公共实例的 JSON 接口不稳，追求稳定建议用 searxng/searxng-docker 自建，37k★）
  - `brave` + `BRAVE_SEARCH_KEY=`（https://brave.com/search/api 免费 2000 次/月，需注册）
  - `tavily` + `TAVILY_API_KEY=`（https://tavily.com 免费 1000 次/月，专为 LLM 设计）
  - `bing` + `BING_SEARCH_KEY=`
- **失败转移链**：主提供商请求失败 / 超时 / 空结果时，自动依次尝试其余「已配置 Key」的提供商，
  duckduckgo 永远垫底兜底；**缺 Key 等配置错误不触发转移**（避免误配时悄悄走免 Key 通道）。
  实测：searxng 公共实例 429 限流时自动切到 duckduckgo，结果照常返回
- `WEB_SEARCH_ENABLED=false` 可整体关闭
- **失败自动降级**：整条链都失败时只记日志，聊天继续「无搜索」回答，不会中断对话
- **上下文记忆**：多轮对话历史由数据库重建发给模型（最近 30 条 / 16000 字符预算），
  与联网搜索可同时使用，搜索摘要不占用历史消息条数

### 14.7 API 生图模式已移除（2026-09-20）

**本项目生图只保留浏览器自动化模式（§14.8）**，OpenAI-Compatible `/v1/images/generations` 路径已整体删除
（`getImageProvider` / `getImageConfig` / `getImageClient` / `AI_IMAGE_API_KEY` / `AI_IMAGE_BASE_URL` / `AI_IMAGE_PROVIDER` 全部移除）。

当时决定移除的实测记录（结论仍有效，脚本仍可用来排查新中转站）：

| 探测 | 结果 |
| --- | --- |
| 中转站 `GET /v1/models` | 200，列出 88 个模型（含 `grok-imagine-image`、`gpt-6-astra`） |
| `POST /v1/images/generations` 扫全部 88 个模型 | 80 个「无可用渠道」；仅 8 个 `minimax-*` 有渠道，但上游回 `unsupported model` |
| `gpt-6-astra` 走 `/chat/completions` | 同样「可用渠道不存在」——**列在 /models 里 ≠ 能用** |
| `kimi-k3` 直接要求出图 | 模型自述 `"I'm not able to generate images—I'm a text-based AI"` |
| 官方 `OPENAI_API_KEY`（`gpt-image-1-mini`） | Key 有效但 **429 `credit_balance_exhausted`：账户没有余额** |
| 免 Key 的 Pollinations | 已改收费（`Insufficient balance`） |

排查脚本（都在 work/，零计费）：`relay-probe.mjs` / `relay-image-sweep.mjs` / `relay-image-names.mjs` / `relay-image-probe.mjs` / `openai-image-probe.mjs` / `live-search-probe.mjs`。

> **不要**用「抓 ChatGPT 网页版 cookie / session token 打私有接口」的方式：违反 OpenAI 使用条款，
> 账号会被封禁。浏览器自动化模式（§14.8）不碰 cookie/token，但仍属自动化使用网页版，有封号风险，仅建议小号。

### 14.8 浏览器自动化生图（ChatGPT Plus 网页版，当前唯一生图模式）

**先读这段风险**：以自动化方式使用 ChatGPT 网页版违反 OpenAI 服务条款，账号可能被封。
强烈建议**只用小号**，且并发不要超过 3。启用即视为你已知情并自担风险。

**原理**：不调用任何 API。用 playwright-core 通过 CDP 连接一个本机「已人工登录 ChatGPT」的
独立 Chrome，把提示词当作一次网页对话发送，等图片出现后提取：统一在**页面内** fetch -> FileReader 转 base64
（同源后台接口，Node 直连会 403）；失败时退化为元素截图。**不抓 cookie、不读浏览器凭证文件、不碰任何私有接口 token**。

**第 1 步：启动带调试端口的独立 Chrome**（独立用户目录，和日常浏览器完全隔离）：

```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="D:\feishu-ai\data\chrome-profile"
```

（也可以用 `work/start-debug-chrome.ps1`，内容相同。）

**第 2 步：首次人工登录**：在这个新开的 Chrome 里访问 https://chatgpt.com 并登录你的账号。
登录态保存在 `data\chrome-profile` 里，重启不丢。这一步只做一次。

**第 3 步：重启服务**（无需任何新配置；以下为可选项）：

```ini
# AI_IMAGE_BROWSER_CDP=http://127.0.0.1:9222
# AI_IMAGE_BROWSER_TIMEOUT_MS=180000     # 单次生成总超时，默认 180s
# AI_IMAGE_BROWSER_CONCURRENCY=1         # 并发上限，默认 1（串行），最大 3
# AI_IMAGE_MODEL=off                     # 想停用生图时设 off
```

**行为约定**：

- browser 是当前唯一生图模式；失败**绝不静默重试**（避免重复出图）
- 修复记录：弹窗 `[hidden]` 曾被 CSS `display` 覆盖导致「× 关不掉」，已显式修复
- 并发 > 1 时每个任务使用独立标签页、用完即关；并发 = 1 时复用同一个标签页
- `data\chrome-profile` 已加入 .gitignore，**不要把该目录提交 Git**

**错误提示对照**：

| 情况 | 页面提示 |
| --- | --- |
| 调试 Chrome 没启动 / 端口不对 | 浏览器未连接：请先启动带 --remote-debugging-port=9222 的 Chrome 并登录 ChatGPT（HTTP 503） |
| 登录态失效 / 未登录 | 未检测到 ChatGPT 登录态：请在调试 Chrome 中登录后重试 |
| 网页排队 / 生成太慢 | 生图超时：ChatGPT 网页可能正在排队，请稍后重试 |
| ChatGPT 前端改版 | 页面结构已变化：自动化脚本需要更新，请联系管理员 |

**归档**：在 .env 配置 `AI_BROWSER_PROJECT_URL`（ChatGPT「项目」页地址）后，
新生图会话会自动落在该项目里；留空则在普通新会话出图。

### 14.9 浏览器自动化对话（ChatGPT Plus 网页版，可替代中转站）

与 §14.8 同一套机制，只不过把「聊天」也交给本机已登录的 ChatGPT Plus 网页：
你的 Plus 会员直接变成对话后端，不再消耗任何 API 额度。

**启用**（.env）：

```ini
AI_CHAT_PROVIDER=browser
# 可选：新对话自动归档到这个 ChatGPT 项目（推荐；生图也共用这个归档位）
AI_BROWSER_PROJECT_URL=https://chatgpt.com/g/<你的项目id>/project
# AI_CHAT_BROWSER_TIMEOUT_MS=240000   # 单次回答总超时，默认 240s
```

**行为约定**：

- 默认 `AI_CHAT_PROVIDER` 为空 = 走 `AI_*` 中转站接口，行为与之前完全一致
- browser 模式下每个 feishu 会话对应一个 ChatGPT 会话：第一条消息开新会话
  （配置了项目 URL 则落在项目里），把 `/c/<id>`（项目内为 `/g/<slug>/c/<id>`）地址
  存入 conversations.external_url；之后同一 feishu 会话的消息都回原会话续聊，上下文连续
- 前端先收到「伪流式」纯文本增量（轮询页面文字增长），结束后服务端把页面 DOM 转成
  Markdown 全文，通过 done 事件的 fullText 字段整段替换，保证代码块/列表/表格排版正确
- 附件与联网搜索的上下文会拼在用户消息前面一起发送（网页版没有独立上下文通道）
- 失败绝不回退到 API 模式、绝不静默重试；未连接返回 503，其余失败 502
- 风险与 §14.8 相同：违反 OpenAI 服务条款，建议只用小号，`AI_BROWSER_CONCURRENCY` 勿超 3

### 14.4 使用第三方中转站的安全提醒

你的问题、聊天内容、粘贴的代码或文档都会经过中转站服务器；
不要假设它拥有与 OpenAI 官方相同的数据处理政策。
本项目发给 AI Provider 的内容**只包含模型请求所需的聊天消息**，
不会发送飞书 App Secret、Session Secret、飞书 access token、数据库 user_id 或用户 Cookie。
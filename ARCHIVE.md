# 归档：已完成事项（截至 2026-09-19）

> 本文件只记录**已经完成并通过验证**的事项，作为阶段交接与维护依据。
> 未完成 / 待办见 §7；运行态信息见 §5。
> 项目位置：`D:\feishu-ai`　公网地址：`https://ai.wzyiloveu.kdns.fr`（Cloudflare Tunnel → localhost:3000）

---

## 1. 阶段二（2026-09-18）：本地网页 + Node.js 后端骨架

- Express 5 + ES Module 后端 `server.js`，端口 3000，`GET /api/test` 健康检查
- ChatGPT 风格前端 `public/index.html` / `style.css` / `app.js`（纯原生 JS，无框架）
- 响应式适配：1920×1080 / 1440×900 / 笔记本 / 飞书内嵌窗口 / ≤900px / ≤560px / ≤380px
- 欢迎页 + 4 个快捷问题卡片；`Enter` 发送、`Shift + Enter` 换行；发送防重复
- **用户输入一律 `textContent` 渲染**，不使用 innerHTML 注入用户内容
- 界面截图：`outputs/preview-01 ~ preview-06`

## 2. 阶段三（2026-09-18）：飞书用户身份登录（Web OAuth 授权码）

- `GET /auth/feishu`：生成 state 存 session，302 到官方授权页
  `https://accounts.feishu.cn/open-apis/authen/v1/authorize`
- `GET /auth/feishu/callback`：校验 state → 服务端用 code 换 token
  （**v3 令牌端点** `https://accounts.feishu.cn/oauth/v3/token`，form-urlencoded）
  → `GET https://open.feishu.cn/open-apis/authen/v1/user_info` 拉取身份（只信飞书返回）
- `GET /api/me`（未登录 401 `{loggedIn:false}`）、`POST /auth/logout`
- express-session：cookie 名 `feishu_ai_sid`，`httpOnly=true`、`sameSite=lax`、
  `secure` 由 `COOKIE_SECURE` / `BASE_URL` 自动判定；`app.set('trust proxy', 1)` 适配 Cloudflare Tunnel
- 集成测试 `work/auth-test.mjs` **23 项全绿**（打桩飞书官方接口，含 state/拒绝/令牌失败/伪造 cookie 分支）
- 界面截图：`outputs/preview-07 ~ preview-09`

## 3. 阶段四（2026-09-18 ~ 09-19）：会话隔离 + 真实 AI 流式对话

### 3.1 后端

- `database/db.js`：SQLite（better-sqlite3）`data/feishu-ai.db`（目录自动创建）；
  三表 `users` / `conversations` / `messages`，外键 `ON DELETE CASCADE`；
  `PRAGMA foreign_keys=ON`、`journal_mode=WAL`；
  `updated_at` 更新语句改用 `strftime('%Y-%m-%d %H:%M:%f','now')`（毫秒精度，保证「最近使用」排序稳定）；
  支持 `DB_FILE` 环境变量指向独立库（测试不污染正式数据）
- `middleware/requireAuth.js`：未登录统一 `401 {success:false,message:'请先登录飞书'}`
- `routes/auth.js`：第三阶段 OAuth **原样迁移**（逻辑未改），新增「登录成功后以飞书 `open_id`
  upsert 到 `users` 表，并把数据库主键写入 `req.session.user.id`」
- `routes/conversations.js`：`GET/POST /api/conversations`、`PATCH/DELETE /:id`、`GET /:id/messages`；
  所有 SQL 带 `WHERE user_id = 当前用户`；越权 / 不存在统一 **404「对话不存在」**；
  响应只暴露 `{id,title,createdAt,updatedAt}`，不下发内部 `user_id`
- `routes/chat.js`：`POST /:id/chat`（非流式）与 `POST /:id/chat/stream`（SSE）；
  事件 `start` / `delta` / `done` / `error`；响应头
  `Cache-Control: no-cache, no-transform` + `X-Accel-Buffering: no`（Tunnel 下不缓冲）+ 15s 保活注释帧；
  配置检查在写 SSE 头之前（未配置时返回 503 JSON 而不是半截流）；
  **失败或客户端断开时不保存半截 assistant 消息（用户消息保留）**
- `services/openai.js`：官方 `openai` SDK 的 Responses API（`responses.stream()` / `create()`）；
  模型名只读 `process.env.OPENAI_MODEL`；`MAX_CONTEXT_MESSAGES = 30` 集中定义；
  新增**流截断检测**：未收到 `response.completed / incomplete` 即视为失败（SDK 对「干净 EOF」不报错）
- `server.js`：路由拆分挂载；`/vendor/marked.umd.js`、`/vendor/purify.min.js`
  （直接从 node_modules 提供，避免 public/ 里出现两份不同步的库）；
  `/api/test` 增加 `feishuLogin` / `aiReady`；SIGINT 时关闭数据库；下线阶段二的模拟接口 `/api/chat`

### 3.2 前端

- 左侧历史会话来自 `GET /api/conversations`（只有自己的），按 `updated_at DESC`；
  每条带「⋯」菜单：重命名（`prompt`）/ 删除（`confirm`），菜单为 fixed 弹层并做视口收敛
- 「＋ 新建对话」→ `POST /api/conversations`；点击会话 → `GET /:id/messages` 加载真实消息
- 流式渲染：`fetch` + `ReadableStream` 按 `\n\n` 切帧，`delta` 内存累积，
  `requestAnimationFrame` 节流重渲染 + 流式光标；**不逐 token 写库**
- Markdown：`marked` 解析 + `DOMPurify.sanitize(USE_PROFILES:{html:true})` 后才写 innerHTML；
  用户输入仍只走 `textContent`
- 未登录：输入区锁定，占位符「使用飞书登录后开始对话」，新建对话禁用，
  点快捷卡片提示「请先使用飞书登录」而不偷建会话
- 快捷卡片：已登录且无会话时**自动创建会话并直接发送**
- 首条消息自动生成标题（去换行、取前 30 字、过长加 `...`），列表与 `done` 事件同步返回
- 刷新页面后历史会话与消息仍在；退出登录清空本地状态并重新锁定输入区
- **修复历史遗留 bug**：旧样式 `.msg-ai .msg-body { white-space: pre-wrap }` 会让 Markdown
  块级标签之间的换行符变成空行，已在 `style.css` 末尾覆盖为 `normal`（代码块仍为 `pre`）

### 3.3 配置与文档

- `.env.example` 新增 `OPENAI_API_KEY` / `OPENAI_MODEL`
- `.gitignore` 新增 `data/`、`data/*.db`、`data/*.db-shm`、`data/*.db-wal`
- `package.json` 版本升至 `0.4.0`，描述更新
- `README.md` 新增「十三、第四阶段」章节（表结构 / SSE 格式 / 自测命令 / 安全清单）

### 3.4 测试归档（2026-09-19 全量执行，全部通过）

| 套件 | 覆盖 | 结果 |
| --- | --- | --- |
| `work/auth-test.mjs` | 飞书 OAuth 全流程（打桩官方接口） | 23 / 23 |
| `work/stage4-api-test.mjs` | 会话隔离、越权 404、未配置 503、SSE 事件、自动标题、多轮上下文、截断/上游报错不落库、级联删除、密钥不泄露 | 95 / 95 |
| `work/e2e-auth-ui.mjs` | 登录态 UI（真实 Chrome + CDP） | 10 / 10 |
| `work/e2e-stage4-ui.mjs` | 前端交互：流式增量、Markdown/代码块、XSS 清理、⋯ 菜单、刷新持久化、退出登录 | 52 / 52 |
| **合计** | | **180 / 180** |

- 界面截图：`outputs/preview-10 ~ preview-16`（未登录锁定 / 流式 Markdown / ⋯ 菜单 / 流失败 / 刷新恢复 / 退出）
- 测试隔离说明：API 测试用 `DB_FILE` 临时库；UI 测试用页面内打桩接口（`work/e2e-stage4-stub.js`），
  均不污染 `data/feishu-ai.db`
- 阶段二的 `work/e2e-check.mjs`（模拟聊天流程）已随 `/api/chat` 下线一并删除
---

## 4. 安全事项归档（已实现并有测试覆盖）

- `FEISHU_APP_SECRET` / `OPENAI_API_KEY` / `SESSION_SECRET` 只存在于 `.env`；
  `.gitignore` 已覆盖 `.env`、`node_modules/`、`data/*.db*`
- 任何接口响应都不包含密钥；`/api/me` 只返回 `name` / `avatar` / `feishuUserId`
- **绝不接受前端提交的 `user_id`**：归属完全由服务端 session（`req.session.user.id`）决定；
  查询串 / 请求体里伪造 `user_id` 均有测试覆盖
- 越权访问他人会话统一 404，不泄露「它属于谁」；列表 / 详情响应也不含内部 `user_id`
- AI 的 Markdown 必须经过 DOMPurify 清理（`<script>` / `onerror` / `javascript:` 链接有 E2E 覆盖）；
  用户输入只走 `textContent`
- OAuth 带 state 防 CSRF，一次性使用；登录失败各分支均回首页带 `?login=error|denied`
- SSE 的 AI 配置检查发生在写响应头之前，未配置时不会产出「半截流」

---

## 5. 运行状态归档（2026-09-19）

- 服务进程：`node server.js`（隐藏窗口），PID 记录在 `%TEMP%\feishu-ai.pid`（归档时为 16468），
  日志 `%TEMP%\feishu-ai-out.log` / `%TEMP%\feishu-ai-err.log`
- 数据库：`D:\feishu-ai\data\feishu-ai.db`（归档时为空库，等待真实登录写入）
- `.env`：已于 2026-09-19 创建并**全部填写完成**
  - `FEISHU_APP_ID` / `FEISHU_APP_SECRET`：已填，并通过飞书
    `POST /open-apis/auth/v3/tenant_access_token/internal` 验证（code=0，tenant_access_token 正常签发）
  - `OPENAI_API_KEY`：已填，`GET /v1/models` 验证通过（账号共 124 个可用模型）
  - `OPENAI_MODEL=gpt-5.6-sol`（用户指定；同账号还有 `gpt-5.6-terra` / `gpt-5.6-luna` 可随时切换）
  - `SESSION_SECRET`：自动生成 64 位随机串
- ⚠️ 该 OpenAI 账号**额度已用完**：真实流式调用返回 `insufficient_quota / credit_balance_exhausted`；
  应用按设计优雅降级（SSE 发 `error` 事件、非流式返回 502，前端显示「AI 回复失败，请重试。」），
  充值后即恢复：https://platform.openai.com/settings/organization/billing/
- 备注：`D:\jidaxia\Electron\resources\.env` 中的旧 OpenAI Key 经实测 401 已失效，**未采用**
- 填完配置后服务已重启（归档时 PID 26192）；`/api/test` 返回 `feishuLogin=true, aiReady=true`；
  因 `BASE_URL` 为 https，Cookie `secure=true`（纯 localhost HTTP 调试登录需取消 `# COOKIE_SECURE=false` 的注释）

---

## 6. 关键实现决策 / 踩坑记录（供后续维护参考）

1. Node 24 + Express 5 + better-sqlite3 13 组合可用；ESM 下测试脚本必须用
   `pathToFileURL('D:/feishu-ai/server.js').href` 动态 import，且环境变量要在 import 之前设置
2. OpenAI SDK v7 的 Responses 流事件序列非常严格：
   `response.created → output_item.added → content_part.added → output_text.delta* → ...done → response.completed`；
   打桩测试必须按此顺序，否则内部 accumulator 直接抛错
3. SDK 对「流干净结束但缺少 completed」**不会报错**，会返回半截累积结果 ——
   因此 `services/openai.js` 自行检测终止事件，缺失即抛 `OpenAIStreamError`，路由层据此不保存半截回复
4. SQLite `CURRENT_TIMESTAMP` 只有秒级精度，同一秒内多次 touch 会乱序；
   UPDATE 语句统一改用 `strftime('%Y-%m-%d %H:%M:%f','now')`
5. Cloudflare Tunnel 下 SSE 必须带 `X-Accel-Buffering: no` 与 `Cache-Control: no-cache, no-transform`，
   否则会被缓冲成整段返回
6. 前端第三方库（marked / DOMPurify）通过 `/vendor/*` 路由直接从 node_modules 提供，
   避免复制进 `public/` 造成版本不同步
7. 阶段二样式 `.msg-ai .msg-body { white-space: pre-wrap }` 与 Markdown 渲染冲突（块间出现空行），
   已在 `style.css` 末尾覆盖；用户消息仍保留 pre-wrap 以保留换行
8. Windows 下单条命令行有长度上限（约 32KB），大文件写入需分块追加
9. `express-session` 在 `secure=true` 时仅当请求被识别为 HTTPS 才下发 Cookie；
   依赖 `trust proxy 1` + Tunnel 的 `X-Forwarded-Proto: https`；纯 localhost HTTP 调试需 `COOKIE_SECURE=false`

---

## 7. 未完成 / 待办

- [x] `.env` 三个密钥已填写并验证（2026-09-19），服务已重启
- [ ] OpenAI 账号充值（当前 `credit_balance_exhausted`；充值后真实对话即恢复）
- [ ] 飞书开发者后台：确认「安全设置 → 重定向 URL」已包含
      `https://ai.wzyiloveu.kdns.fr/auth/feishu/callback`，且应用版本已发布、身份权限已开通
- [ ] 真实环境端到端验收：真实飞书账号登录 + 真实 OpenAI 流式回复 + 双人隔离抽查
- [ ] 可选优化：会话搜索 / 按日期分组、消息分页加载、session 换持久化 store、接口速率限制

---

## 8. 代码文件清单（归档时）

| 文件 | 职责 |
| --- | --- |
| `server.js` | 入口：中间件、session、静态与 vendor、路由挂载、兜底与错误处理、启动横幅 |
| `routes/auth.js` | 飞书 OAuth 四个接口 + 用户入库同步 |
| `routes/conversations.js` | 会话 CRUD 与历史消息（requireAuth + 用户隔离） |
| `routes/chat.js` | 非流式 / SSE 流式聊天 |
| `services/openai.js` | OpenAI Responses API 封装、上下文裁剪、流截断检测 |
| `database/db.js` | SQLite 建表与预编译语句 |
| `middleware/requireAuth.js` | 登录校验 |
| `public/index.html` | 页面结构（含 vendor 脚本引入） |
| `public/app.js` | 前端全部交互逻辑 |
| `public/style.css` | 样式（含 Markdown / 菜单 / 流式光标） |
| `ARCHIVE.md` | 本归档文件 |
| `README.md` | 使用文档（含第十三章：第四阶段说明） |
---

## 9. 运行巡检记录

### 2026-09-20

- 服务：PID 26192 存活；`http://localhost:3000/api/test` 与公网
  `https://ai.wzyiloveu.kdns.fr/api/test` 均返回 200 且 `feishuLogin=true, aiReady=true`
  （Cloudflare Tunnel 链路正常）
- 飞书凭证：`POST /open-apis/auth/v3/tenant_access_token/internal` 仍返回 code=0，有效
- OpenAI：Key 有效、模型 `gpt-5.6-sol` 存在，但**额度仍未充值**
  （429 `credit_balance_exhausted`）；真实对话暂不可用，应用按设计降级为「AI 回复失败，请重试。」
- 数据清理：正式库中误入的测试用户行（`ou_test_open_id_0001`）已删除；
  `work/auth-test.mjs` 增加默认隔离（未设置 `DB_FILE` 时自动改用系统临时目录的独立库），
  复跑 23/23 全绿，且正式库保持 0 用户 / 0 会话 / 0 消息
- 尚未发生真实飞书登录（`users` 表为空）。恢复真实可用仍需：
  ① OpenAI 账号充值　② 飞书后台确认重定向 URL 与应用发布　③ 真实登录 + 真实流式回复验收
### 2026-09-20（二）：services/openai.js 专项加固

- **空闲看门狗**：新增 `OPENAI_IDLE_TIMEOUT_MS`（默认 60000）。这么久没有任何事件就 abort 上游请求，
  防止上游挂死时 SSE 连接与服务器资源被永久占用；超时归为 `OpenAITimeoutError`，
  路由层按失败处理（不保存半截回复）。实测打桩「挂死流」在 328ms 内被掐断并给出超时提示
- **上下文字符预算**：新增 `MAX_CONTEXT_CHARS = 16000`。在条数上限（`MAX_CONTEXT_MESSAGES = 30`）
  之外再按字符裁剪，从最旧的消息开始丢，且至少保留用户当前提问
- **错误分类**：新增 `describeOpenAIError()`，把上游错误映射成可对用户展示的中文提示：
  额度不足 / 密钥无效 / 限流 / 模型不存在 / 超时，其余回落「AI 回复失败，请重试。」；
  `routes/chat.js` 的 SSE `error` 事件与 502 响应改用该分类
  （例如额度问题现在提示「AI 服务额度不足，请联系管理员充值后重试」，而不是误导性的「重试」）
- **可选网关**：支持 `OPENAI_BASE_URL` 覆盖默认 API 地址；SDK 客户端缓存按 key + baseURL 失效
- 测试：`work/stage4-api-test.mjs` 增至 **104 项**（新增 quota、stall 超时、字符预算、错误分类单测）；
  并修复「.env 已有真实密钥时，dotenv 在 import 时回填被测试删除的变量」导致 503 分支测不到的问题
- 回归结果：23 + 104 + 10 + 52 = **189 项全绿**；服务已重启（归档时 PID 9396）
### 2026-09-20（三）：AI Provider 通用化（任意 OpenAI-Compatible 中转站）

- `services/openai.js` 重写为 Provider 抽象层：
  - 新配置 `AI_BASE_URL` / `AI_API_KEY` / `AI_MODEL` / `AI_API_MODE`，优先级高于旧变量
    `OPENAI_API_KEY` / `OPENAI_MODEL`；`AI_BASE_URL` 留空默认 `https://api.openai.com/v1`
  - `baseURL` 原样交给 SDK，代码不做任何 `/v1` 拼接
  - 双模式：`responses`（原有逻辑全保留）与 `chat_completions`
    （`chat.completions.create({stream:true|false})`，安全解析 `choices[0].delta.content`，
    以 `finish_reason` 做流截断检测）
  - **模式只由 `AI_API_MODE` 决定**：失败不自动切换模式、不自动重发收费请求；
    responses 模式遇 404 时提示「请将 AI_API_MODE 改为 chat_completions。」
  - 错误映射按中转站常见状态码：401「AI API Key 无效或未授权」、403「当前 API Key 没有该模型权限」、
    404「AI API 地址或模型接口不存在」（responses 模式为切换提示）、429「AI 请求过于频繁或中转站额度不足」、
    5xx「AI 服务暂时不可用」、网络层「无法连接 AI 服务」
- `server.js`：启动横幅显示 模型 / 模式 / 地址
- `.env.example`：按需求重写 AI Provider 段（含占位示例与安全说明）；**真实 `.env` 未做任何改动**
- `README.md`：新增「十四、使用 OpenAI-Compatible API（中转站）」
- 新增测试 `work/ai-provider-test.mjs`：**20 项**（需求清单 1~12 + 404 不自动回退等附加项），
  全程打桩假中转站 `relay.example.com`，不产生真实收费请求
- 既有测试断言同步到新错误文案；回归结果：
  23 + 110 + 20 + 10 + 52 = **215 项全绿**；服务已重启（归档时 PID 19480）
- 安全：发给 Provider 的内容仅含聊天消息；任何响应不含 Key / Authorization / 请求头 / .env 内容
### 2026-09-20（四）：接入真实中转站配置

- 用户提供中转站参数并已写入 `.env`（追加块，未改动任何既有条目）：
  `AI_BASE_URL=https://api.tokendancelab.com/v1`、`AI_API_KEY=sk-xK0****`、
  `AI_MODEL=kimi-k3`、`AI_API_MODE=responses`
- 模型 ID 校正：用户口述「kimi k3」在中转站 `/v1/models`（88 个模型）中不存在，
  实际 ID 为 **kimi-k3**（同系列另有 kimi-k2.5 / k2.6 / k2.7-code）
- Key 有效性：`GET /v1/models` 返回 200（不计费）
- 真实调用验证（仅 1 次，responses 模式）：`completeChat("回复 OK")` 成功，4185ms，回复 "OK"；
  因此 `AI_API_MODE` 保持 `responses`
- 服务已重启（归档时 PID 4988），横幅：模型 kimi-k3 / 模式 responses / 地址 tokendancelab
- 说明：`.env` 中旧的 `OPENAI_API_KEY`（官方、额度耗尽）保留为回退项，但 `AI_*` 优先级更高，
  实际流量走中转站
### 2026-09-20（五）：修复「AI 回复失败，请重试。」（中转站 responses 流兼容）

- **现象**：网页提示「AI 回复失败，请重试。」；服务端日志为
  `[流式聊天] 调用 AI 失败： missing content at index 0`
- **根因**：官方 SDK 的 `responses.stream()` 助手内部对事件序列做严格累积，
  要求先发 `response.output_item.added` / `response.content_part.added` 再发 delta；
  该中转站（tokendancelab）流式只发 `response.output_text.delta`，缺少铺垫事件，SDK 直接抛错
- **修复**：`services/openai.js` 的 responses 流式改走**低层接口**
  `responses.create({ stream: true })`（只解析 SSE 事件、不做严格累积），
  终止事件 / 截断检测仍由本项目自己完成；最终文本优先取终止事件里的完整响应，兜底用逐段累积
- **验证**：1 次真实流式调用成功（4.3s，回复 "OK"）；服务已重启（PID 9256）
- **事故与加固**：`.env` 加入真实 `AI_*` 后，dotenv 会在 import 时注入它们，
  而 `stage4-api-test.mjs` 原先只清除 `OPENAI_*`，导致 2 次「未配置 503」检查误打真实中转站
  （消耗 2 次计费调用）。已修复：
  ① 测试在 import 后同时清除 `AI_*`；
  ② `stage4-api-test.mjs` 与 `ai-provider-test.mjs` 的 fetch 打桩增加**安全闸**：
     任何未显式打桩的外网地址一律返回 599 `UNSTUBBED_NETWORK_CALL`，杜绝测试误发真实请求
- 复跑：stage4 110/110、provider 20/20，安全闸零触发
- 备注：该中转站的 kimi-k3 流式通常一次性返回整段文本（delta 段数=1），
  因此打字机效果可能表现为「整段出现」，属中转站行为，非本项目缺陷
### 2026-09-20（六）：第五阶段 - 文件上传 + AI 生图

- **新增依赖**：multer 2.4 / pdf-parse 2.4 / mammoth 1.12 / xlsx 0.18
- **新增文件**：
  - `services/files.js`：扩展名白名单、文本抽取（pdf / docx / xlsx|xls|csv / txt|md）、
    图片魔数识别；**文件大小默认不限制**（`UPLOAD_MAX_MB` 可选兜底，按用户要求不设限）
  - `routes/uploads.js`：`POST/GET /api/conversations/:id/uploads`、`DELETE /api/uploads/:id`、
    `GET /api/uploads/:id/file`；multer 磁盘流式接收，路径 `data/uploads/<userId>/<随机名>`，
    原始文件名只存 DB；非图片强制 attachment 下载 + `X-Content-Type-Options: nosniff`
  - `routes/images.js`：`POST /api/images/generate`、`GET /api/images`、`GET /api/images/:id/file`；
    模型 `AI_IMAGE_MODEL`（留空=功能关闭 503）；b64 直接落盘，仅给 url 时服务端拉取缓存
  - `work/stage5-files-test.mjs`：29 项（含 12MB 大文件不限、415、越权 404、级联删除、生图全链路）
- **数据库**：新增 `attachments`（会话级联）与 `generated_images` 两表
- **聊天上下文**：附件抽取文本拼入 system/instructions（每附件 ≤8000 字符）；
  图片附件仅预览不进上下文（v1 不做 OCR / 视觉，已知限制）
- **前端**：输入框回形针上传 + 附件条（缩略图/大小/移除）；顶栏「生图」按钮 + 弹窗（提示词/历史/下载）
- **文档**：`.env.example` 增加 `AI_IMAGE_MODEL`、`UPLOAD_MAX_MB`（注释）；README 增加 14.5 节
- **行为变化（有意）**：挂载 `/api` 级路由后，未登录访问未知 `/api/*` 先经 requireAuth 返回 401
  （原先 404）；已登录仍为 404。stage4 对应断言已更新
- **测试事故修复**：e2e 打桩补上附件/生图接口，避免 `refreshAttachments()` 穿透到真实服务触发 401 级联登出
- 回归：23 + 110 + 20 + 29 + 10 + 52 = **244 项全绿**；服务已重启（归档时 PID 19864）

### 2026-09-20（六）：第六阶段 - 联网搜索（网页检索 + [编号] 引用）

- **新增文件**：
  - `services/search.js`：搜索服务层。提供商 `duckduckgo`（默认，**免 Key**，
    抓取 `html.duckduckgo.com/html/` 解析 `result__a` / `result__snippet`，
    并把 `uddg=` 跳转参数还原成真实 URL）/ `tavily`（`TAVILY_API_KEY`）/
    `bing`（`BING_SEARCH_KEY`）；单次超时 `SEARCH_TIMEOUT_MS=8000`，默认取 5 条
  - `work/stage6-search-test.mjs`：**39 项**集成测试（fetch 全程打桩 + 599 安全闸，
    不打真实外网、不消耗任何 AI 额度）
  - `work/live-search-probe.mjs`：真实网络探针（只读导入生产 search.js，
    用于验证 DuckDuckGo 现行页面结构解析是否仍有效）
- **改造 `routes/chat.js`**：
  - `readSearchFlag(req)`：仅当请求体 `search === true` **且** 服务端
    `WEB_SEARCH_ENABLED !== false` 时才生效（开关权威在服务端，前端无法强开）
  - `buildContextDocuments(conversationId, userId, query, wantSearch)`：文档上下文 =
    会话附件抽取文本 + 带编号的搜索摘要块；**搜索失败/超时只记日志并降级为「无搜索回答」**，
    绝不让搜索拖垮对话（前端仍收到 `done`，不会看到报错）
  - 流式与非流式两个接口都传 `wantSearch`；SSE `start` 事件新增 `search: boolean`
- **搜索结果只进上下文、不进数据库**：`messages` 表仍只有 `user` / `assistant`，
  摘要与链接不写库（用例 7 专门断言）；发给模型的请求体不含任何密钥（用例 10）
- **前端**：输入框左侧新增「🌐 联网」按钮（`#searchToggle`，`aria-pressed` + `.is-on` 高亮），
  `app.js` 用 `webSearchOn` 状态随每次提问提交 `{ message, search }`；**未重写任何既有 UI**
- **环境变量**（`.env.example` 与 README §14.6 已同步）：`WEB_SEARCH_ENABLED`（默认 true）、
  `WEB_SEARCH_PROVIDER`（默认 duckduckgo）、可选 `TAVILY_API_KEY` / `BING_SEARCH_KEY`。
  **当前 `.env` 无需改动即可使用**（走默认免 Key 方案）
- **测试**：
  - 本轮实跑全绿：`auth-test` 23 + `stage4-api-test` 110 + `ai-provider-test` 20 +
    `stage6-search-test` **39** = **192 项**
  - `stage5-files-test`(29) 与 `e2e-*-ui`(10+52) 本轮因沙箱限制未复跑：前者需要写
    `D:\feishu-ai\data\uploads`（EPERM），后者需要 spawn Chrome（EPERM）；二者覆盖的代码路径本阶段未改动
  - 真实网络探针：中/英文各检索 4 条，标题 + 真实链接 + 摘要解析全部正确（约 0.7~1.5s）
- **修复的测试缺陷**：stage6 打桩原先对所有中转站请求都返回 SSE，导致非流式
  `POST /:id/chat` 被 SDK 当流解析报 `Cannot use 'in' operator to search for 'object' in event`；
  已改为 `body.stream !== true` 时返回标准 JSON 响应
- **已知限制**：图片附件仍不做 OCR；搜索只取前 5 条摘要，不抓取网页全文（省 token、省时延）

### 2026-09-20（六）：生图改造 - 多服务商支持 + 中转站生图能力实测

- **背景**：用户希望「直接用对话模型 kimi-k3 生图」。实测证明不可行，于是把生图做成
  **可独立指定服务商**，并把失败原因翻译成可操作的中文提示。
- **实测结论（全部有脚本可复现，见 README §14.7）**：
  - 中转站 `api.tokendancelab.com` 的 `/v1/models` 列了 88 个模型，但 `/v1/images/generations` 上
    **80 个「无可用渠道」**；仅 8 个 `minimax-*` 能路由到 MiniMax 图像上游，
    上游却回 `unsupported model: minimax-m2`（`minimax_image_error` code 2013）→ 等于不可用
  - `gpt-6-astra` 虽在模型列表里，但连 `/chat/completions` 都「无可用渠道」→ **列表不可信**
  - `kimi-k3` 走 chat/completions、responses、responses+image_generation 工具三条路都不能出图，
    模型自述 `"I am not able to generate images—I am a text-based AI"`
  - 官方 `OPENAI_API_KEY` 有效（/models 200，含 gpt-image-1/1-mini/2、chatgpt-image-latest），
    但生图返回 **429 `credit_balance_exhausted`（账户无余额）**
  - 免 Key 的 Pollinations 已改收费（`Insufficient balance ... ~0.0001 pollen`）
  - 结论：**当前没有任何可用的生图后端**；代码侧已就绪，只差一个能出图的 Key
- **新增探测脚本（都在 work/，零计费或单次文本调用）**：
  `relay-probe.mjs`、`relay-probe2.mjs`、`relay-probe3.mjs`、`relay-image-sweep.mjs`、
  `relay-image-names.mjs`、`relay-image-probe.mjs`、`openai-key-probe.mjs`、
  `openai-image-probe.mjs`、`pollinations-probe.mjs`、`live-search-probe.mjs`
- **services/openai.js**：
  - `getImageModel()` 语义升级：显式配置优先；**留空 = 回落对话模型 `AI_MODEL`**；
    `off/none/false/disabled/0`（大小写不敏感）= 关闭功能
  - 新增 `getImageConfig()` / `isImageGenerationEnabled()` / `getImageClient()`：
    `AI_IMAGE_API_KEY` / `AI_IMAGE_BASE_URL` 留空则复用对话配置，
    因此「对话走中转站、生图走官方或另一家」成为受支持的组合；客户端独立缓存、配置变了自动重建
  - 新增 `describeImageError(err, model)`：把 `get_channel_failed` / `No available channel` /
    `可用渠道不存在` / `model_not_found` / `insufficient_quota` / `credit_balance_exhausted` /
    `no credits remaining` / `insufficient balance` / `余额不足` / `账户欠费` / 「模型不支持生图」
    各自映射成**带修法**的中文提示，其余回落 `describeOpenAIError`；绝不回传 Key
- **routes/images.js**：改用 `getImageClient()`；503 文案更新为「生图功能未启用…」；
  兼容多种上游返回结构 `{data:[{b64_json|url}]}`（OpenAI/智谱）、
  `{images:[{b64_image|url|image_url}]}`（SiliconFlow）、直接数组；
  `b64_json` 允许带 `data:image/png;base64,` 前缀；远程图下载加 60s 超时
- **文档**：README 新增 §14.7（实测记录 + 三条合法可用配置 + 排查脚本清单），
  §14.5 重写生图部分；`.env.example` 增加 `AI_IMAGE_API_KEY` / `AI_IMAGE_BASE_URL` 与 off 开关说明
- **测试**：新增 `work/image-provider-test.mjs` **36 项**（配置回落 / 关闭态 / 客户端缓存 /
  7 种错误映射 / 生图与对话分流到不同服务商 / 用的是生图那把 Key / 返回结构兼容 /
  400·401·503 / 响应零密钥泄露）；`stage5-files-test.mjs` 生图断言改为新语义（29 → **31** 项）
- **全量回归**：23 + 20 + 110 + 31 + 39 + 36 + 10 + 52 = **321 项全绿**（含两个 e2e 浏览器套件）
- **拒绝的做法（已明确告知用户）**：抓 ChatGPT 网页版 cookie / session token 打私有接口、
  共享个人 Plus 登录态给组员 —— 违反 OpenAI 使用条款、会导致封号，且极不稳定，未实现
- **运维**：本轮发现生产服务此前已意外退出（3000 端口无监听、公网 502），已重启并验证
  本地与 `https://ai.wzyiloveu.kdns.fr` 均 200；`work/restart-feishu-ai.ps1` 为一键重启脚本

### 2026-09-20（六）：生图 Provider 化 - 新增 browser 模式（本机 ChatGPT 网页自动化）

- **新增文件**：
  - `services/image-browser.js`：playwright-core + CDP（`connectOverCDP`，不下载浏览器）
    驱动本机已登录 ChatGPT 的独立 Chrome 生图。连接缓存 + 断线重连；并发=1 复用同一标签页，
    并发>1 每任务独立标签页用后关闭；自研 FIFO 串行队列（`AI_IMAGE_BROWSER_CONCURRENCY`，
    默认 1、上限 3）；输入选择器集中管理；等待新图出现且连续两轮稳定才提取；
    图片提取统一走「页面内 fetch -> FileReader -> base64」（真实验收发现生成图是同源后台接口，
    Node 直连 403），失败时退化为元素截图保底；
    四个自定义错误类（NotConnected / LoginRequired / GenerationTimeout / DomChanged）；
    日志只记 prompt 前 50 字 + 长度；失败绝不回退 api、绝不静默重试
  - `work/image-browser-test.mjs`：**37 项**（mock connectOverCDP + fetch 打桩 + 599 安全闸零触发）
  - `work/start-debug-chrome.ps1`：一键启动调试 Chrome（独立 user-data-dir，幂等）
- **修改**：
  - `services/openai.js`：新增 `getImageProvider()`（`AI_IMAGE_PROVIDER`，默认 api，未知值回落 api）；
    `getImageConfig()` 带 provider 字段；browser 模式 `AI_IMAGE_MODEL` 留空=`chatgpt-web` 标签、off=关闭；
    `isImageGenerationEnabled()` 的 browser 分支不要求任何 Key；
    `describeImageError()` 按错误 name 映射 4 条浏览器中文提示（name 识别，无模块环依赖）
  - `routes/images.js`：按 provider 分流，browser 懒加载 image-browser.js（api 模式零引入）；
    `BrowserNotConnectedError` 返回 503（环境未就绪）与 502（生成失败）区分；
    魔数识别失败时可信回退 Provider 附带的 MIME；api 分支逻辑一行未改
  - `.env.example` / README §14.8（启动命令、首次登录、配置、风险、错误对照、切换方式）
  - `package.json`：新增依赖 `playwright-core`（仅此一个，不下载浏览器）
  - `work/restart-feishu-ai.ps1`：头部注释补充 browser 模式前置步骤（脚本不会自动拉起 Chrome）
- **红线**（写进代码注释与 README）：不抓 cookie、不读浏览器凭证文件、不碰私有接口 token、
  不自动登录；自动化使用 ChatGPT 网页版违反 OpenAI 服务条款，仅建议小号，并发 ≤3
- **测试**：原 321 项断言零改动（503 文案为新增分支而非修改）；新增 38 项；全量 **359 项全绿**
- **真实验收**：调试 Chrome + 已登录 ChatGPT Plus 实际出图成功（1254x1254 PNG，约 39s）；
  期间修复两个真实环境才发现的缺陷：① composer 探测需校验可见性（页面有 display:none 的兜底 textarea）；
  ② 生成图 src 是同源 estuary 接口需页面内下载；③ 并发/排队的超时从「拿到执行位」起算而非入队时起算

### 2026-09-20（七）：移除 API 生图模式 + 前端科技感升级 + 弹窗隐藏 bug 修复

- **移除 API 生图模式**（应用户要求，生图只保留浏览器自动化）：
  - `services/openai.js`：整段删除 `getImageProvider` / `getImageModel` / `getImageConfig` /
    `isImageGenerationEnabled` / `getImageClient` / `describeImageError` / `IMAGE_DISABLED_VALUES`；
    openai.js 回归纯对话职责
  - `services/image-browser.js`：收编 `isImageGenerationEnabled()`（AI_IMAGE_MODEL=off 即停用）、
    `getImageModelLabel()`（chatgpt-web）、`describeBrowserImageError()`（4 个浏览器错误 + 兜底）；
    与 openai.js 彻底解耦（不再 import）
  - `routes/images.js` 重写：单一路径走 `generateImageViaBrowser`，无 provider 分支；
    停用文案改为「生图功能已停用：.env 中 AI_IMAGE_MODEL=off…」
  - `.env` 删除 `AI_IMAGE_PROVIDER=browser`（已无意义）；`.env.example` 精简为 browser-only
  - 测试：删除 `work/image-provider-test.mjs`（36 项，整体作废）；
    `image-browser-test.mjs` 重写单元层并补 400/401/越权 404（38→35 项）；
    `stage5-files-test.mjs` 摘除生图段（31→23 项，生图归 image-browser-test 管）
- **修复真实存在的 UI bug（Playwright 真实鼠标命中检测发现，JS .click() 类测试此前完全测不出）**：
  - `.modal-mask` 的 `display:grid` 覆盖了 `[hidden]` 的 UA 样式 → 生图弹窗**永远开着**、× 按钮「点了没反应」；
    `.attach-chips` 同样问题。修复：`.modal-mask[hidden], .attach-chips[hidden] { display:none !important }`
  - 顺手补上 Esc 键关闭生图弹窗（原来只能点 × / 遮罩）
  - 新增 `work/verify-modal.mjs`：6 项真实点击验证（加载隐藏 / 打开 / × / 遮罩 / Esc / 关闭后可交互）全绿
- **前端科技感升级**（纯 CSS，不动 DOM/类名，e2e 断言零影响；全部动画遵守 prefers-reduced-motion）：
  - 品牌渐变体系：靛蓝→紫→青（--gradient-brand / --glow-brand / 弹簧与缓出曲线 token）
  - 欢迎页：旋转渐变光环 + 悬浮动画的 Logo、渐变标题文字、极光底色、卡片错峰入场
  - 快捷卡片：悬浮上浮 + 渐变描边（padding-box/border-box 技巧）
  - 消息：fade+rise 入场；用户气泡淡品牌渐变；AI 头像流式时呼吸辉光；流式光标方块→呼吸圆点
  - 顶栏玻璃拟态增强；模型状态点脉冲；「生图」按钮与发送按钮改品牌渐变 + 弹簧微交互
  - 输入框聚焦渐变环；联网开关开启态辉光；弹窗弹簧入场；历史选中态左侧品牌色指示条；滚动条细化
- **文档**：README §14.5 生图段重写（指向 §14.8）、§14.7 改为「API 生图模式已移除」说明、
  §14.8 配置示例去掉 AI_IMAGE_PROVIDER、修正 PowerShell 双反引号残留
- **测试**：全量 8 套件 **312 项全绿**（23+20+110+23+39+35+10+52）

---

## 第七阶段 - 浏览器对话 + ChatGPT 项目归档（2026-09-20）

**需求**：
1. 网页无法下滚查看后续对话（布局 bug）
2. 生图自动归档到 ChatGPT「图片生成档」项目
3. 对话框不走中转站 API，直接用本机已登录的 ChatGPT Plus 网页回答，同样归档进项目

**改动**：
- 修复滚动 bug：`.app` 隐式 grid 行是 auto，`main` 随内容膨胀超 100vh 导致 `.chat` 永不滚动；
  改为 `grid-template-rows: minmax(0, 1fr)`（public/style.css）
- 新增 services/browser-core.js：CDP 连接缓存、全局串行队列（AI_BROWSER_CONCURRENCY，默认 1 最大 3）、
  共享/独立标签页、可见性过滤后的 composer 探测、4 个浏览器错误类；image-browser.js 重构架在 core 上
- 新增 services/chat-browser.js：AI_CHAT_PROVIDER=browser 启用；伪流式（innerText 前缀差量）+
  完成判定（无停止按钮 + 文本稳定两轮）+ 页面内 DOM->Markdown 转换器；/c/<id> 与项目内 /g/<slug>/c/<id> 地址提取
- database/db.js：conversations.external_url 列（幂等迁移）+ setConversationExternalUrl()（不动 updated_at）
- routes/chat.js：browser 分流（流式/非流式）、external_url 回写、Browser* 错误 -> 中文提示、503/502 区分
- public/app.js：done 事件接收 fullText，流式结束后用 Markdown 全文替换纯文本累积
- .env：AI_CHAT_PROVIDER=browser、AI_BROWSER_PROJECT_URL=<图片生成档项目地址>

**关键事实**：
- ChatGPT 项目内会话地址是 /g/<slug>/c/<id> 而非 /c/<id>（正则已兼容，真实探测得出）
- 可见输入框是 div#prompt-textarea（ProseMirror）；页面另有 display:none 的兜底 textarea，必须查 isVisible
- 生图同源 estuary 地址 Node 直连 403，必须页面内 fetch->FileReader->base64
- 思考占位文本（正在思考）不作为最终内容，done.fullText 会整段修正

**测试**：新增 work/chat-browser-test.mjs 40 项（全打桩 + 599 安全闸零触发）；
全量回归 312 + 40 = 352 项全绿；真实验收：项目内新会话/续聊/生图归档均通过

---

## 第八阶段 - 联网搜索多提供商 + 失败转移链（2026-09-20）

**需求**：对话保留中转站 API（kimi-k3）；生图保留 ChatGPT Plus 网页模式；
GitHub 调研更好的联网搜索接入方式；确保一个对话里模型能记住上下文。

**GitHub 调研结论**（agent-reach）：
- SearXNG（searxng/searxng，37k★）元搜索是免 Key 的主流方案，但公共实例 JSON 接口不稳
  （实测 8 个低延迟实例仅 2 个可用：etsi.me 正常、dresden 空结果，其余 403/418/202）
- Brave Search API 免费 2000 次/月、Tavily 免费 1000 次/月（专为 LLM 设计）是免自建的最稳方案
- 上下文记忆：本项目已由数据库重建历史（30 条/16000 字符），真实双轮测试通过
  （代号「蓝鲸7274」+宠物「电路板」均正确回忆，kimi-k3 responses 模式多轮正常）

**改动**：
- services/search.js：新增 brave（api.search.brave.com/res/v1/web/search）与
  searxng（format=json，SEARXNG_BASE_URL 逗号分隔多实例做实例级转移，默认 etsi.me）提供商；
  searchWeb 改为失败转移链：主提供商 -> 其余已配置 Key 的提供商 -> duckduckgo 垫底；
  空结果视为失败；缺 Key 等 configError 不触发转移（保持 stage6 用例6 语义）
- .env.example / README §14.6 同步更新

**测试**：新增 work/search-providers-test.mjs 22 项（全打桩 + 599 安全闸零触发）；
全量回归 312 + 22 = 334 项全绿

**真实验收**：
- searxng（etsi.me）被 429 限流 -> 自动转移 duckduckgo -> 3 条真实结果（转移链实战生效）
- duckduckgo 真实搜索「2026年9月 最新科技新闻」1.3s 出 5 条当日新闻，kimi-k3 带 [编号] 引用回答
**后续（同日）**：已通过调试 Chrome 里的 Google 登录一键注册 Tavily（免费 1000 次/月），
.env 设 WEB_SEARCH_PROVIDER=tavily + TAVILY_API_KEY（Key 从控制台 DOM 提取并真实验证 200）；
DuckDuckGo 由转移链自动兜底。实测今日新闻 2.7s 出 5 条当日结果。


---

## 第九阶段 - 附件体系升级：格式对齐 ChatGPT + 在线预览 + 随消息发送 + 图片视觉（2026-09-20）

**需求**：上传格式与 ChatGPT 一致；上传后可打开预览；附件随消息一起发出（不停留在输入框）。

**关键发现**：kimi-k3 实为多模态（responses input_image / chat_completions image_url 均实测 200，
  能准确描述截图内容），推翻了此前「纯文本」的结论——图片附件可直接内联发给模型。

**改动**：
- services/files.js：白名单扩到 46 种（+doc/pptx/json/xml/html/代码类）；pptx 用 jszip 解 slideN.xml 抽 <a:t>；
  新增 UPLOAD_ROOT / readStoredFile（防路径穿越）/ loadImagesAsBase64（单图 8MB 上限）
- services/openai.js：buildInput 透传 images；toMultimodalMessage 仅对最后一条 user 消息内联图片
  （responses: input_image；chat_completions: image_url），无图消息键都不带（旧断言不破）
- database/db.js：attachments.message_id 幂等迁移；待发(pending)=NULL；bindPendingAttachments /
  listBoundAttachments / listImagesForMessage；listAttachments 只回 pending 且 SQL 直算 hasText
- routes/chat.js：保存用户消息后绑定待发附件 + 收集图片挂到该消息；AI_VISION=false 可关
- routes/uploads.js：GET /:id/preview（inlineOpen + previewText 3000 字）；file 端点对
  image/pdf/text/csv 改 inline（浏览器直接预览），Office 二进制仍 attachment 下载
- routes/conversations.js：messages 端点按消息带 attachments（url/previewUrl/isImage/hasText）
- public：消息气泡渲染附件 chips（图片缩略图）；发送后 composer chips 自动清空；
  新增附件预览弹窗（图片大图 / PDF iframe / 文档抽取文本 / 下载原文件）；chips 点击可预览
- server.js：public 静态 HTML/JS/CSS 改 no-cache（修 Cloudflare 4h 缓存导致发版不生效）；
  index.html 资源引用加 ?v= 版本号（CF 不缓存 HTML，版本号一变 js/css 必拉新）
- work/restart-feishu-ai.ps1：自检改 15s 轮询（修冷启动误报）；修重复 BOM

**测试**：新增 work/stage8-attachments-test.mjs 26 项（含 input_image 打桩验证、绑定清空、
  预览端点、越权 404、599 闸）；stage5 两处断言随新行为同步（txt inline、级联段用例）；
  全量回归 338 项全绿

**真实验收**：新会话上传截图提问 -> kimi-k3 准确描述顶栏/侧栏内容；附件 chip 随气泡展示；
  composer 发送后清空；预览弹窗正常；刷新后历史附件仍在

---

## 运维 - 502 故障恢复与进程韧性（2026-09-20 深夜）

**故障**：公网 502 Bad Gateway。原因：feishu-ai 的 node 进程与调试 Chrome 都已退出
（机器睡眠/手动关窗所致），cloudflared 作为 Windows 服务存活但后端无人应答。

**修复与加固**：
- 新增 D:/feishu-ai/supervisor.mjs：spawn server.js，崩溃自动重启（5 分钟最多 5 次，写守护日志）
- work/restart-feishu-ai.ps1 改经 supervisor 启动
- work/start-at-logon.ps1 + 启动文件夹 feishu-ai.vbs：登录时自动拉起 supervisor 与调试 Chrome
  （schtasks 注册被权限拒绝，改用 Startup 文件夹，免管理员）
- cloudflared 本来就是 Automatic 服务，无需处理
- 实测：强杀 3000 端口子进程，supervisor 1s 内重启成功，服务恢复 200

---

## 运维 - Error 1033 Cloudflare Tunnel 掉线（2026-09-21 凌晨）

**现象**：公网 Error 1033 / 530（tunnel 无法解析），本地 3000 正常。
**原因**：cloudflared 系统服务进程活着但隧道断开挂起约 40 分钟（事件日志显示开机时还曾 2 分钟内重启 5 次）；
  之后服务自行重连恢复。
**尝试过的**：用户态起第二个 connector 副本 -> 失败（C:\ProgramData\cloudflared\token 仅 SYSTEM 可读）；
  Restart-Service / 杀进程 -> 沙箱无权限。
**结论与待办**：服务已自愈；tunnel 级故障的根治 = sc.exe failure 自愈配置（需管理员）或上云。

**同日补充**：1033 当天 09:24 再次发作后自愈。cloudflared 版本 2026.9.1（很新）。
根治手段：work/fix-cloudflared-service.ps1（自提权）——协议 QUIC->http2（UDP 被校园网限流是主因）
+ sc failure 崩溃自愈。需用户双击运行一次（UAC）。

**教训（同日）**：cloudflared 2026.9.1 已删除 --protocol flag（help 里无此项），
强行加 http2 导致隧道起不来（进程不报错、~100s 自动优雅退出再被拉起，循环）。
已把 fix-cloudflared-service.ps1 改为还原版（同一文件，用户再双击一次即可恢复）；崩溃自愈策略保留。

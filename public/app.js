/**
 * 组内 AI（feishu-ai）前端逻辑 - 第四阶段
 * -------------------------------------------------------------
 * 说明：
 *   - 纯原生 JavaScript，不依赖任何前端框架 / UI 组件库
 *   - 安全渲染（关键）：
 *       用户消息  -> 一律 textContent，绝不 innerHTML
 *       AI 消息   -> marked 解析 Markdown 后，必须再经 DOMPurify 清理才写入 innerHTML
 *   - 会话列表 / 消息 / AI 回复全部来自后端接口，按登录用户隔离；刷新页面后聊天记录仍然存在
 *   - AI 回复使用 SSE 流式输出，逐段渲染（打字机效果），流结束后后端一次性落库
 *   - 不提交任何 user_id：身份完全由服务端 session 决定
 */

(function () {
  'use strict';

  /* ========================= 常量配置 ========================= */

  var API_ME            = '/api/me';
  var API_TEST          = '/api/test';
  var API_LOGOUT        = '/auth/logout';
  var API_CONVERSATIONS = '/api/conversations';

  var LOADING_TEXT               = 'AI 正在思考...';
  var STREAM_ERROR_TEXT          = 'AI 回复失败，请重试。';
  var NETWORK_ERROR_TEXT         = '请求失败，请检查服务器状态。';
  var NORMAL_PLACEHOLDER         = '给 AI 发送消息...';
  var LOGIN_REQUIRED_PLACEHOLDER = '使用飞书登录后开始对话';
  var DEFAULT_TITLE              = '新对话';
  var TITLE_MAX_LENGTH           = 100;
  var INPUT_MAX_HEIGHT           = 180;   // 输入框自动增高的上限（与 CSS 保持一致）
  var NARROW_QUERY               = '(max-width: 900px)'; // 与 CSS 断点保持一致

  var JSON_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json' };

  /* ========================= DOM 引用 ========================= */

  var appRoot         = document.querySelector('.app');
  var sidebar         = document.getElementById('sidebar');
  var sidebarMask     = document.getElementById('sidebarMask');
  var menuBtn         = document.getElementById('menuBtn');
  var newChatBtn      = document.getElementById('newChatBtn');
  var historyList     = document.getElementById('historyList');
  var historyTip      = document.getElementById('historyTip');
  var welcomeBox      = document.getElementById('welcome');
  var suggestions     = document.getElementById('suggestions');
  var messageList     = document.getElementById('messageList');
  var chatScroll      = document.getElementById('chatScroll');
  var chatForm        = document.getElementById('chatForm');
  var messageInput    = document.getElementById('messageInput');
  var sendBtn         = document.getElementById('sendBtn');
  var backendState    = document.getElementById('backendState');
  var modelChip       = document.getElementById('modelChip');
  var modelChipText   = document.getElementById('modelChipText');
  var authArea        = document.getElementById('authArea');
  var logoutBtn       = document.getElementById('logoutBtn');
  var userStatus      = document.getElementById('userStatus');
  var sidebarAvatar   = document.getElementById('sidebarAvatar');
  var sidebarUserName = document.getElementById('sidebarUserName');
  var attachBtn       = document.getElementById('attachBtn');
  var searchToggle    = document.getElementById('searchToggle');
  var fileInput       = document.getElementById('fileInput');
  var attachChips     = document.getElementById('attachChips');
  var imageGenBtn     = document.getElementById('imageGenBtn');
  var imageModalMask  = document.getElementById('imageModalMask');
  var imageModalClose = document.getElementById('imageModalClose');
  var imagePrompt     = document.getElementById('imagePrompt');
  var imageGenSubmit  = document.getElementById('imageGenSubmit');
  var imageModalHint  = document.getElementById('imageModalHint');
  var previewModalMask  = document.getElementById('previewModalMask');
  var previewModalClose = document.getElementById('previewModalClose');
  var previewTitle    = document.getElementById('previewTitle');
  var previewBody     = document.getElementById('previewBody');
  var previewHint     = document.getElementById('previewHint');
  var previewDownload = document.getElementById('previewDownload');
  var imageGrid       = document.getElementById('imageGrid');

  /* ========================= 运行时状态 ========================= */

  var currentUser             = null;  // GET /api/me 返回的登录用户（仅展示用，不作为身份凭据）
  var conversations           = [];    // 当前用户自己的会话列表
  var currentConversationId   = null;  // 当前打开的会话；null 表示停留在欢迎页
  var isSending               = false; // 是否正在生成 AI 回复（防止重复发送）
  var maskTimer               = null;  // 侧边栏遮罩隐藏定时器
  var openMenuEl              = null;  // 当前展开的「⋯」菜单
  var streamTarget            = null;  // 正在流式渲染的 .msg-text 元素
  var streamBuffer            = '';    // 流式累积的完整文本（内存中）
  var streamRenderPending     = false; // rAF 节流标记
  var currentAttachments      = [];    // 当前会话的附件列表
  var webSearchOn             = false; // 联网搜索开关（每次提问生效）

  /* ========================= 通用工具 ========================= */

  /** 当前是否为窄屏（侧边栏以覆盖层形式展示） */
  function isNarrow() {
    return window.matchMedia(NARROW_QUERY).matches;
  }

  /** 清空一个元素的所有子节点（不使用 innerHTML） */
  function clearChildren(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** 创建元素的小工具：createEl('div', 'msg-body', '文本')，文本一律走 textContent */
  function createEl(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined && text !== null) el.textContent = text; // 安全写入
    return el;
  }

  /** 滚动聊天区域到底部 */
  function scrollToBottom() {
    window.requestAnimationFrame(function () {
      chatScroll.scrollTop = chatScroll.scrollHeight;
    });
  }

  /** 统一 JSON 请求：永远返回 { ok, status, data }，不抛异常 */
  async function fetchJson(url, options) {
    try {
      var res = await fetch(url, options);
      var data = null;
      try { data = await res.json(); } catch (parseError) { data = null; }
      return { ok: res.ok, status: res.status, data: data };
    } catch (networkError) {
      console.warn('[组内 AI] 请求失败：', url, networkError);
      return { ok: false, status: 0, data: null };
    }
  }

  /**
   * SQLite 里的时间文本是 UTC（形如 2026-09-18 15:20:31 或带毫秒），
   * 直接 new Date() 会被当成本地时间，这里显式按 UTC 解析。
   */
  function parseDbTime(value) {
    if (!value) return null;
    var text = String(value).trim();
    if (!text) return null;
    var iso = text.replace(' ', 'T');
    if (iso.slice(-1) !== 'Z') iso += 'Z';
    var date = new Date(iso);
    return isNaN(date.getTime()) ? null : date;
  }

  /** 会话列表里的相对时间 */
  function formatRelativeTime(value) {
    var date = parseDbTime(value);
    if (!date) return '';
    var diff = Date.now() - date.getTime();
    if (diff < 0) diff = 0;
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
    if (diff < 604800000) return Math.floor(diff / 86400000) + ' 天前';
    return (date.getMonth() + 1) + '月' + date.getDate() + '日';
  }

  /* ========================= Markdown 安全渲染 ========================= */

  /**
   * 只用于 AI 回复：marked 解析 + DOMPurify 清理后才写入 innerHTML。
   * 任一环节不可用时退化为 textContent，绝不把原始内容直接注入 DOM。
   */
  function renderMarkdown(el, text) {
    var value = text === undefined || text === null ? '' : String(text);
    if (!value) {
      el.textContent = '';
      return;
    }

    var markedLib = window.marked;
    var purifyLib = window.DOMPurify;
    var canRender = markedLib && typeof markedLib.parse === 'function' &&
                    purifyLib && typeof purifyLib.sanitize === 'function';

    if (!canRender) {
      el.textContent = value; // 兜底：纯文本
      return;
    }

    var html;
    try {
      html = markedLib.parse(value, { gfm: true, breaks: true });
    } catch (parseError) {
      console.warn('[组内 AI] Markdown 解析失败，改用纯文本：', parseError);
      el.textContent = value;
      return;
    }

    if (typeof html !== 'string') { // 理论上不会发生（未开启 async）
      el.textContent = value;
      return;
    }

    el.innerHTML = purifyLib.sanitize(html, { USE_PROFILES: { html: true } });
  }

  /* ========================= 侧边栏开关 ========================= */

  function openSidebar() {
    if (isNarrow()) {
      appRoot.classList.add('sidebar-open');
      sidebarMask.hidden = false;
      window.requestAnimationFrame(function () { sidebarMask.classList.add('show'); });
    } else {
      appRoot.classList.remove('sidebar-collapsed');
    }
    menuBtn.setAttribute('aria-expanded', 'true');
  }

  function closeSidebar() {
    if (isNarrow()) {
      appRoot.classList.remove('sidebar-open');
      sidebarMask.classList.remove('show');
      if (maskTimer) window.clearTimeout(maskTimer);
      maskTimer = window.setTimeout(function () { sidebarMask.hidden = true; }, 220);
    } else {
      appRoot.classList.add('sidebar-collapsed');
    }
    menuBtn.setAttribute('aria-expanded', 'false');
  }

  function toggleSidebar() {
    var opened = isNarrow()
      ? appRoot.classList.contains('sidebar-open')
      : !appRoot.classList.contains('sidebar-collapsed');
    if (opened) closeSidebar(); else openSidebar();
  }

  /* ========================= 会话列表 ========================= */

  function setHistoryTip(text) {
    if (historyTip) historyTip.textContent = text;
  }

  function findConversation(id) {
    for (var i = 0; i < conversations.length; i++) {
      if (conversations[i].id === id) return conversations[i];
    }
    return null;
  }
  /** 渲染左侧会话列表（数据来自 GET /api/conversations，只有自己的） */
  function renderConversations() {
    closeConvMenu();
    clearChildren(historyList);

    if (!currentUser) {
      setHistoryTip('登录飞书后，你的对话会保存在这里');
      return;
    }
    if (!conversations.length) {
      setHistoryTip('还没有对话，点击「新建对话」开始');
      return;
    }
    setHistoryTip('共 ' + conversations.length + ' 个对话 · 仅自己可见');

    conversations.forEach(function (conv) {
      var li = document.createElement('li');
      li.className = 'history-row';

      var item = createEl('button', 'history-item');
      item.type = 'button';
      item.dataset.id = String(conv.id);
      item.title = conv.title || DEFAULT_TITLE;
      if (conv.id === currentConversationId) {
        item.classList.add('active');
        item.setAttribute('aria-current', 'true');
      }

      var icon = createEl('span', 'history-icon', String(conv.title || '新').slice(0, 1).toUpperCase());
      icon.setAttribute('aria-hidden', 'true');

      var textBox = createEl('span', 'history-text');
      textBox.appendChild(createEl('span', 'history-title', conv.title || DEFAULT_TITLE));
      textBox.appendChild(createEl('span', 'history-meta', formatRelativeTime(conv.updatedAt)));

      item.appendChild(icon);
      item.appendChild(textBox);

      // 「⋯」菜单按钮（重命名 / 删除）
      var more = createEl('button', 'conv-more', '⋯');
      more.type = 'button';
      more.dataset.id = String(conv.id);
      more.title = '对话操作';
      more.setAttribute('aria-label', '对话操作：' + (conv.title || DEFAULT_TITLE));
      more.setAttribute('aria-haspopup', 'menu');

      li.appendChild(item);
      li.appendChild(more);
      historyList.appendChild(li);
    });
  }

  /** 拉取当前用户的会话列表 */
  async function refreshConversations() {
    if (!currentUser) {
      conversations = [];
      renderConversations();
      return;
    }
    var r = await fetchJson(API_CONVERSATIONS, { headers: JSON_HEADERS });
    if (r.status === 401) return handleSessionExpired();
    if (!r.ok || !r.data || r.data.success !== true) {
      if (r.status === 0) setBackendState(false);
      setHistoryTip('历史会话加载失败，请稍后重试');
      return;
    }
    conversations = Array.isArray(r.data.conversations) ? r.data.conversations : [];
    renderConversations();
  }

  /** 回到欢迎页（清空当前会话） */
  function resetToWelcome() {
    currentConversationId = null;
    clearChildren(messageList);
    updateWelcomeVisibility();
    renderConversations();
    scrollToBottom();
    refreshAttachments();
  }

  /** 新建对话：POST /api/conversations */
  async function newConversation() {
    if (!currentUser) { flashLoginHint(); return; }
    if (isSending) return;

    var r = await fetchJson(API_CONVERSATIONS, { method: 'POST', headers: JSON_HEADERS });
    if (r.status === 401) return handleSessionExpired();
    if (!r.ok || !r.data || !r.data.conversation) {
      setHistoryTip('新建对话失败，请稍后重试');
      return;
    }

    currentConversationId = r.data.conversation.id;
    clearChildren(messageList);
    updateWelcomeVisibility();
    await refreshConversations();
    refreshAttachments();
    if (isNarrow()) closeSidebar();
    messageInput.focus();
  }

  /** 打开某个会话并加载历史消息 */
  async function selectConversation(id) {
    if (isSending) return;             // 生成中不切换，避免流式内容写进气泡错误
    if (id === currentConversationId && messageList.childElementCount > 0) {
      if (isNarrow()) closeSidebar();
      return;
    }

    var r = await fetchJson(API_CONVERSATIONS + '/' + id + '/messages', { headers: JSON_HEADERS });
    if (r.status === 401) return handleSessionExpired();
    if (r.status === 404) {
      // 已被删除或不属于当前用户：刷新列表并回到欢迎页
      if (currentConversationId === id) resetToWelcome();
      await refreshConversations();
      setHistoryTip('对话不存在或已被删除');
      return;
    }
    if (!r.ok || !r.data || r.data.success !== true) {
      setHistoryTip('消息加载失败，请稍后重试');
      return;
    }

    currentConversationId = id;
    clearChildren(messageList);
    (Array.isArray(r.data.messages) ? r.data.messages : []).forEach(function (m) {
      appendMessage(m.role === 'user' ? 'user' : 'ai', m.content, m.attachments);
    });
    renderConversations();
    updateWelcomeVisibility();
    scrollToBottom();
    refreshAttachments();
    if (isNarrow()) closeSidebar();
  }

  /* ========================= 「⋯」菜单 ========================= */

  function closeConvMenu() {
    if (openMenuEl && openMenuEl.parentNode) openMenuEl.parentNode.removeChild(openMenuEl);
    openMenuEl = null;
  }

  function openConvMenu(anchorBtn) {
    var id = Number(anchorBtn.dataset.id);
    var conv = findConversation(id);
    if (!conv) return;

    closeConvMenu();

    var menu = createEl('div', 'conv-menu');
    menu.setAttribute('role', 'menu');

    var renameBtn = createEl('button', 'conv-menu-item', '重命名');
    renameBtn.type = 'button';
    renameBtn.setAttribute('role', 'menuitem');
    renameBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      closeConvMenu();
      renameConversation(conv);
    });

    var deleteBtn = createEl('button', 'conv-menu-item conv-menu-danger', '删除');
    deleteBtn.type = 'button';
    deleteBtn.setAttribute('role', 'menuitem');
    deleteBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      closeConvMenu();
      deleteConversation(conv);
    });

    menu.appendChild(renameBtn);
    menu.appendChild(deleteBtn);
    document.body.appendChild(menu);

    // 依据按钮位置定位（fixed），并做视口边界收敛
    var rect = anchorBtn.getBoundingClientRect();
    var menuWidth = menu.offsetWidth || 120;
    var menuHeight = menu.offsetHeight || 76;
    var left = Math.min(Math.max(8, rect.right - menuWidth), window.innerWidth - menuWidth - 8);
    var top = rect.bottom + 4;
    if (top + menuHeight > window.innerHeight - 8) top = Math.max(8, rect.top - menuHeight - 4);
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.classList.add('show');
    openMenuEl = menu;
  }

  /** 重命名：PATCH /api/conversations/:id */
  async function renameConversation(conv) {
    var input = window.prompt('重命名对话', conv.title || '');
    if (input === null) return;

    var title = String(input).trim();
    if (!title) { window.alert('标题不能为空'); return; }
    if (title.length > TITLE_MAX_LENGTH) {
      window.alert('标题过长（最多 ' + TITLE_MAX_LENGTH + ' 个字符）');
      return;
    }

    var r = await fetchJson(API_CONVERSATIONS + '/' + conv.id, {
      method: 'PATCH',
      headers: JSON_HEADERS,
      body: JSON.stringify({ title: title })
    });
    if (r.status === 401) return handleSessionExpired();
    if (r.status === 404) {
      if (currentConversationId === conv.id) resetToWelcome();
      await refreshConversations();
      return;
    }
    if (!r.ok) {
      window.alert((r.data && r.data.message) || '重命名失败，请稍后重试');
      return;
    }
    await refreshConversations();
  }

  /** 删除：DELETE /api/conversations/:id（消息由外键级联删除） */
  async function deleteConversation(conv) {
    var ok = window.confirm('确定删除「' + (conv.title || DEFAULT_TITLE) + '」吗？\n删除后该对话的聊天记录无法恢复。');
    if (!ok) return;

    var r = await fetchJson(API_CONVERSATIONS + '/' + conv.id, { method: 'DELETE', headers: JSON_HEADERS });
    if (r.status === 401) return handleSessionExpired();
    if (!r.ok && r.status !== 404) {
      window.alert((r.data && r.data.message) || '删除失败，请稍后重试');
      return;
    }
    if (currentConversationId === conv.id) resetToWelcome();
    await refreshConversations();
  }
  /* ========================= 消息渲染 ========================= */

  /**
   * 追加一条消息气泡
   * @param {'user'|'ai'} role
   * @param {string} text
   * @returns {{root: HTMLElement, textEl: HTMLElement}}
   */
  function appendMessage(role, text, attachments) {
    var isUser = role === 'user';
    var root = createEl('div', 'msg ' + (isUser ? 'msg-user' : 'msg-ai'));

    if (!isUser) {
      var avatar = createEl('span', 'msg-avatar', 'AI');
      avatar.setAttribute('aria-hidden', 'true');
      root.appendChild(avatar);
    }

    var body = createEl('div', 'msg-body');
    if (!isUser) body.appendChild(createEl('span', 'msg-role', 'AI'));

    // 附件随消息展示（用户气泡）：图片缩略图 + 文件名，点击开预览
    if (isUser && Array.isArray(attachments) && attachments.length) {
      body.appendChild(buildMsgAttachments(attachments));
    }

    var textEl = createEl('span', 'msg-text');
    if (isUser) {
      // 关键安全点：用户内容只通过 textContent 写入，杜绝 XSS
      textEl.textContent = text === undefined || text === null ? '' : String(text);
    } else {
      renderMarkdown(textEl, text);
    }

    body.appendChild(textEl);
    root.appendChild(body);
    messageList.appendChild(root);

    updateWelcomeVisibility();
    scrollToBottom();

    return { root: root, textEl: textEl };
  }

  /** 消息气泡里的附件列表（只读，无删除按钮；点击开预览） */
  function buildMsgAttachments(attachments) {
    var row = createEl('span', 'msg-atts');
    attachments.forEach(function (att) {
      var chip = createEl('button', 'msg-att');
      chip.type = 'button';
      chip.title = '预览 ' + att.filename;
      if (att.isImage || att.kind === 'image') {
        var img = createEl('img', 'msg-att-thumb');
        img.src = att.url;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        chip.appendChild(img);
      } else {
        chip.appendChild(createEl('span', 'msg-att-icon', '📄'));
      }
      chip.appendChild(createEl('span', 'msg-att-name', att.filename));
      chip.addEventListener('click', function () { openAttachmentPreview(att); });
      row.appendChild(chip);
    });
    return row;
  }

  /** 追加一个「AI 正在思考...」占位气泡（流式内容到达后被替换） */
  function appendAssistantPlaceholder() {
    var parts = appendMessage('ai', '');
    parts.root.classList.add('msg-loading');
    parts.root.setAttribute('aria-busy', 'true');
    parts.textEl.textContent = LOADING_TEXT;

    var dots = createEl('span', 'typing-dots');
    dots.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < 3; i++) dots.appendChild(document.createElement('i'));
    parts.textEl.appendChild(dots);

    return parts;
  }

  /** 流式失败：气泡显示错误提示（textContent，不做 Markdown 渲染） */
  function failAssistant(parts, text) {
    parts.root.classList.remove('msg-loading', 'is-streaming');
    parts.root.removeAttribute('aria-busy');
    parts.root.classList.add('msg-error');
    parts.textEl.textContent = text || STREAM_ERROR_TEXT;
    scrollToBottom();
  }

  /** 有消息时隐藏欢迎页，清空后重新显示 */
  function updateWelcomeVisibility() {
    var hasMessages = messageList.childElementCount > 0;
    welcomeBox.classList.toggle('hidden', hasMessages);
  }

  /* ========================= 流式渲染节流 ========================= */

  function scheduleStreamRender() {
    if (streamRenderPending || !streamTarget) return;
    streamRenderPending = true;
    window.requestAnimationFrame(function () {
      streamRenderPending = false;
      if (!streamTarget) return;
      renderMarkdown(streamTarget, streamBuffer);
      scrollToBottom();
    });
  }

  function flushStreamRender() {
    streamRenderPending = false;
    if (streamTarget) renderMarkdown(streamTarget, streamBuffer);
    streamTarget = null;
    streamBuffer = '';
  }

  /** 解析一个 SSE 事件块（可能包含注释帧、多行 data） */
  function parseSseEvent(rawEvent) {
    var lines = String(rawEvent).split('\n');
    var dataLines = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line || line.charAt(0) === ':') continue;   // 注释 / 保活帧
      if (line.indexOf('data:') === 0) {
        dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    if (!dataLines.length) return null;
    try {
      return JSON.parse(dataLines.join('\n'));
    } catch (parseError) {
      return null;
    }
  }

  /* ========================= 发送消息 ========================= */

  /** 确保已有 conversation（欢迎页 / 快捷卡片场景下自动创建） */
  async function ensureConversation() {
    if (currentConversationId) return currentConversationId;
    var r = await fetchJson(API_CONVERSATIONS, { method: 'POST', headers: JSON_HEADERS });
    if (r.status === 401) { handleSessionExpired(); throw new Error('unauthorized'); }
    if (!r.ok || !r.data || !r.data.conversation) throw new Error('create-failed');
    currentConversationId = r.data.conversation.id;
    return currentConversationId;
  }

  /**
   * 发送消息（流式）
   * @param {string} [presetText] 传入时忽略输入框内容（快捷卡片使用）
   */
  async function sendMessage(presetText) {
    if (isSending) return;               // 防止重复发送
    if (!currentUser) { flashLoginHint(); return; }

    var fromPreset = typeof presetText === 'string';
    var text = (fromPreset ? presetText : messageInput.value).trim();
    if (!text) return;                   // 空消息不发送

    var convId;
    try {
      convId = await ensureConversation();
    } catch (err) {
      if (String(err && err.message) !== 'unauthorized') setHistoryTip('新建对话失败，请稍后重试');
      return;
    }

    isSending = true;
    refreshSendButton();

    // 1. 立即显示用户消息（连同待发附件一起进气泡），并清空输入框
    var sentAttachments = currentAttachments.slice();
    appendMessage('user', text, sentAttachments);
    if (!fromPreset) {
      messageInput.value = '';
      autoResize();
    }

    // 2. 创建空的 AI 气泡
    var parts = appendAssistantPlaceholder();

    // 3. 连接流式接口，逐段渲染
    try {
      await streamReply(convId, text, parts);
    } finally {
      isSending = false;
      refreshSendButton();
      messageInput.focus();
    }

    // 4. 首条消息会自动生成标题，刷新左侧列表；附件已随消息绑定，清空输入框 chips
    await refreshAttachments();
    await refreshConversations();
  }

  /**
   * 调用 POST /api/conversations/:id/chat/stream 并按 SSE 增量渲染。
   * 后端只在流结束后一次性写库，前端同样只在内存里累积。
   */
  async function streamReply(convId, text, parts) {
    streamBuffer = '';
    streamTarget = parts.textEl;

    var res;
    try {
      res = await fetch(API_CONVERSATIONS + '/' + convId + '/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({ message: text, search: webSearchOn })
      });
    } catch (networkError) {
      flushStreamRender();
      failAssistant(parts, NETWORK_ERROR_TEXT);
      setBackendState(false);
      return;
    }

    // 出错时后端在写 SSE 头之前就返回了 JSON（400 / 401 / 404 / 503 ...）
    var contentType = res.headers.get('content-type') || '';
    if (!res.ok || contentType.indexOf('text/event-stream') === -1) {
      var message = STREAM_ERROR_TEXT;
      try {
        var errData = await res.json();
        if (errData && errData.message) message = errData.message;
      } catch (parseError) { /* 保持默认提示 */ }

      flushStreamRender();
      failAssistant(parts, message);
      if (res.status === 401) handleSessionExpired();
      return;
    }

    parts.root.classList.add('is-streaming');

    var gotDelta = false;
    var errorMessage = null;
    var finalFullText = '';
    var pending = '';

    try {
      var reader = res.body.getReader();
      var decoder = new TextDecoder('utf-8');

      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;

        pending += decoder.decode(chunk.value, { stream: true }).replace(/\r\n/g, '\n');

        var idx;
        while ((idx = pending.indexOf('\n\n')) > -1) {
          var rawEvent = pending.slice(0, idx);
          pending = pending.slice(idx + 2);

          var evt = parseSseEvent(rawEvent);
          if (!evt || !evt.type) continue;

          if (evt.type === 'delta' && typeof evt.text === 'string') {
            if (!gotDelta) {
              gotDelta = true;
              parts.root.classList.remove('msg-loading');
              parts.root.removeAttribute('aria-busy');
            }
            streamBuffer += evt.text;      // 内存累积，不逐 token 写库
            scheduleStreamRender();
          } else if (evt.type === 'error') {
            errorMessage = evt.message || STREAM_ERROR_TEXT;
          } else if (evt.type === 'done' && typeof evt.fullText === 'string' && evt.fullText) {
            // browser 对话模式：增量是纯文本伪流式，最终排版以 done 携带的 Markdown 全文为准
            finalFullText = evt.fullText;
          }
          // type=start 仅作流程标记，无需额外处理
        }
      }
    } catch (streamError) {
      console.warn('[组内 AI] 流式接收中断：', streamError);
      errorMessage = errorMessage || STREAM_ERROR_TEXT;
    }

    parts.root.classList.remove('is-streaming');
    if (finalFullText) streamBuffer = finalFullText; // 用 Markdown 全文替换纯文本累积
    flushStreamRender();

    if (errorMessage) {
      // 失败时后端不会保存半截 assistant 消息，前端同样只显示错误提示
      failAssistant(parts, errorMessage);
      return;
    }
    if (!gotDelta) {
      failAssistant(parts, STREAM_ERROR_TEXT);
      return;
    }
    setBackendState(true);
  }

  /* ========================= 输入框 ========================= */

  /** textarea 自动增高（有最大高度限制） */
  function autoResize() {
    messageInput.style.height = 'auto';
    var next = Math.min(messageInput.scrollHeight, INPUT_MAX_HEIGHT);
    messageInput.style.height = next + 'px';
    messageInput.style.overflowY = messageInput.scrollHeight > INPUT_MAX_HEIGHT ? 'auto' : 'hidden';
  }

  /** 未登录 / 内容为空 / 正在生成时，禁用发送按钮 */
  function refreshSendButton() {
    sendBtn.disabled = isSending || !currentUser || messageInput.value.trim() === '';
  }

  /** 根据登录态切换输入区可用性 */
  function applyComposerState() {
    var loggedIn = !!currentUser;
    messageInput.disabled = !loggedIn;
    messageInput.placeholder = loggedIn ? NORMAL_PLACEHOLDER : LOGIN_REQUIRED_PLACEHOLDER;
    chatForm.classList.toggle('is-locked', !loggedIn);
    newChatBtn.disabled = !loggedIn;
    newChatBtn.classList.toggle('is-disabled', !loggedIn);
    refreshSendButton();
  }

  /** 未登录时点击快捷卡片：提示去登录，而不是静默无反应 */
  function flashLoginHint() {
    if (userStatus) userStatus.textContent = '请先使用飞书登录';
    var link = authArea.querySelector('.btn-feishu-login');
    if (!link) return;
    link.classList.remove('pulse');
    void link.offsetWidth; // 强制重排，让动画可以重复触发
    link.classList.add('pulse');
    window.setTimeout(function () { link.classList.remove('pulse'); }, 1400);
  }

  /* ========================= 后端状态 ========================= */

  function setBackendState(online) {
    if (!backendState) return;
    backendState.classList.toggle('online', !!online);
    backendState.classList.toggle('offline', !online);
    backendState.textContent = online ? '后端已连接' : '后端未连接';
  }

  /** 启动时自检一次 GET /api/test，并同步模型状态提示 */
  async function checkBackend() {
    var r = await fetchJson(API_TEST, { headers: JSON_HEADERS });
    var ok = r.ok && r.data && r.data.success === true;
    setBackendState(ok);

    if (!modelChipText) return;
    if (!ok) {
      modelChipText.textContent = '后端未连接';
      if (modelChip) modelChip.classList.remove('ready');
      return;
    }
    if (r.data.aiReady) {
      modelChipText.textContent = 'AI 已接入 · 流式输出';
      if (modelChip) modelChip.classList.add('ready');
    } else {
      modelChipText.textContent = '未配置 AI 模型';
      if (modelChip) modelChip.classList.remove('ready');
    }
  }
  /* ========================= 飞书登录态 ========================= */

  /** 构造头像节点：优先飞书头像图片，加载失败自动回退为首字母头像 */
  function buildAvatarNode(user) {
    if (user && user.avatar) {
      var img = createEl('img', 'avatar avatar-sm avatar-img');
      img.src = user.avatar;
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.addEventListener('error', function () {
        var fallback = createEl('span', 'avatar avatar-sm', (user.name || 'U').slice(0, 1));
        if (img.parentNode) img.parentNode.replaceChild(fallback, img);
      });
      return img;
    }
    var letter = (user && user.name ? user.name : 'U').slice(0, 1);
    return createEl('span', 'avatar avatar-sm', letter);
  }

  /** 同步侧边栏底部用户区 */
  function renderSidebarUser(user) {
    var newNode = buildAvatarNode(user);
    newNode.id = 'sidebarAvatar';
    newNode.setAttribute('aria-hidden', 'true');
    if (sidebarAvatar && sidebarAvatar.parentNode) {
      sidebarAvatar.parentNode.replaceChild(newNode, sidebarAvatar);
    }
    sidebarAvatar = newNode;
    sidebarUserName.textContent = user ? user.name : '当前用户';
  }

  /** 未登录：右上角显示「使用飞书登录」按钮 */
  function renderLoggedOut(hint) {
    clearChildren(authArea);
    var link = createEl('a', 'btn-feishu-login', '使用飞书登录');
    link.href = '/auth/feishu';
    link.title = '通过飞书 OAuth 登录以识别组内成员';
    authArea.appendChild(link);

    renderSidebarUser(null);
    userStatus.textContent = hint || '未登录飞书';
    logoutBtn.hidden = true;
  }

  /** 已登录：右上角显示头像 + 姓名 */
  function renderLoggedIn(user) {
    clearChildren(authArea);
    var chip = createEl('span', 'current-user');
    chip.appendChild(buildAvatarNode(user));
    chip.appendChild(createEl('span', 'current-user-name', user.name || '飞书用户'));
    chip.title = '飞书 ID：' + (user.feishuUserId || '');
    authArea.appendChild(chip);

    renderSidebarUser(user);
    userStatus.textContent = '已登录飞书';
    logoutBtn.hidden = false;
  }

  /** 读取并清理 URL 上的登录结果提示（?login=denied / ?login=error） */
  function consumeLoginHint() {
    var params = new URLSearchParams(window.location.search);
    var flag = params.get('login');
    if (!flag) return '';
    params.delete('login');
    var rest = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? '?' + rest : ''));
    if (flag === 'denied') return '已取消授权，未登录';
    if (flag === 'error') return '登录失败，请重试';
    return '';
  }

  /** 会话过期 / 在别处登出：清空本地状态，回到未登录界面 */
  function handleSessionExpired() {
    currentUser = null;
    conversations = [];
    resetToWelcome();
    renderLoggedOut('登录已过期，请重新登录');
    applyComposerState();
  }

  /** 页面加载时获取当前登录态：GET /api/me */
  async function loadMe() {
    var hint = consumeLoginHint();
    var r = await fetchJson(API_ME, { headers: JSON_HEADERS });

    if (r.status === 0) {
      currentUser = null;
      renderLoggedOut(hint || NETWORK_ERROR_TEXT);
      applyComposerState();
      renderConversations();
      return;
    }
    if (r.status === 401 || !r.data || r.data.loggedIn !== true || !r.data.user) {
      currentUser = null;
      conversations = [];
      renderLoggedOut(hint);
      applyComposerState();
      renderConversations();
      return;
    }

    currentUser = r.data.user;
    renderLoggedIn(currentUser);
    applyComposerState();
    await refreshConversations();
    refreshAttachments();
    if (!isNarrow()) messageInput.focus();
  }

  /** 退出登录：清除服务端 session，界面回到未登录 */
  async function logout() {
    logoutBtn.disabled = true;
    try {
      await fetch(API_LOGOUT, { method: 'POST' });
    } catch (err) {
      console.warn('[组内 AI] 退出请求失败：', err);
    }
    logoutBtn.disabled = false;

    currentUser = null;
    conversations = [];
    currentConversationId = null;
    clearChildren(messageList);
    updateWelcomeVisibility();
    renderLoggedOut('');
    applyComposerState();
    renderConversations();
    refreshAttachments();
  }

  /* ========================= 文件附件 ========================= */

  function formatSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  }

  /** 拉取当前会话的附件列表 */
  async function refreshAttachments() {
    if (!currentUser || !currentConversationId) {
      currentAttachments = [];
      renderAttachChips();
      return;
    }
    var r = await fetchJson('/api/conversations/' + currentConversationId + '/uploads', { headers: JSON_HEADERS });
    if (r.status === 401) return handleSessionExpired();
    currentAttachments = (r.ok && r.data && r.data.success === true) ? (r.data.attachments || []) : [];
    renderAttachChips();
  }

  function renderAttachChips() {
    clearChildren(attachChips);
    if (!currentAttachments.length) {
      attachChips.hidden = true;
      return;
    }
    attachChips.hidden = false;
    currentAttachments.forEach(function (att) {
      var chip = createEl('span', 'attach-chip');
      if (att.kind === 'image') {
        var img = createEl('img', 'attach-chip-thumb');
        img.src = att.url;
        img.alt = '';
        img.referrerPolicy = 'no-referrer';
        chip.appendChild(img);
      } else {
        chip.appendChild(createEl('span', 'attach-chip-icon', '📄'));
      }
      var textBox = createEl('span', 'attach-chip-text');
      textBox.appendChild(createEl('span', 'attach-chip-name', att.filename));
      textBox.appendChild(createEl('span', 'attach-chip-meta',
        formatSize(att.size) + (att.hasText ? ' · 已解析进上下文' : ' · 仅预览')));
      chip.appendChild(textBox);

      var del = createEl('button', 'attach-chip-del', '×');
      del.type = 'button';
      del.dataset.id = String(att.id);
      del.title = '移除附件';
      del.setAttribute('aria-label', '移除附件 ' + att.filename);
      chip.appendChild(del);

      attachChips.appendChild(chip);
    });
  }

  /** 上传一个或多个文件到当前会话（没有会话时先自动创建） */
  async function uploadFiles(fileList) {
    if (!currentUser) { flashLoginHint(); return; }
    var convId = currentConversationId;
    if (!convId) {
      try {
        convId = await ensureConversation();
      } catch (err) {
        setHistoryTip('新建对话失败，请稍后重试');
        return;
      }
      await refreshConversations();
    }

    var files = Array.prototype.slice.call(fileList);
    for (var i = 0; i < files.length; i++) {
      var form = new FormData();
      form.append('file', files[i]);
      setHistoryTip('正在上传 ' + files[i].name + ' …');
      var r = await fetchJson('/api/conversations/' + convId + '/uploads', { method: 'POST', body: form });
      if (r.status === 401) { handleSessionExpired(); return; }
      if (!r.ok || !r.data || r.data.success !== true) {
        window.alert((r.data && r.data.message) || ('上传失败：' + files[i].name));
      }
    }

    currentConversationId = convId;
    setHistoryTip('');
    await refreshAttachments();
    refreshConversations();
  }

  async function deleteAttachment(id) {
    var r = await fetchJson('/api/uploads/' + id, { method: 'DELETE', headers: JSON_HEADERS });
    if (r.status === 401) return handleSessionExpired();
    await refreshAttachments();
  }

  /* ========================= 附件预览 ========================= */

  function closePreviewModal() {
    previewModalMask.hidden = true;
    clearChildren(previewBody);
  }

  /**
   * 附件预览：图片直接看大图；PDF 用浏览器内建渲染（iframe）；
   * 文档/表格显示抽取出的文本预览；都不行的给下载按钮。
   */
  async function openAttachmentPreview(att) {
    previewTitle.textContent = att.filename;
    previewHint.textContent = formatSize(att.size || 0);
    previewDownload.href = att.url;
    clearChildren(previewBody);
    previewModalMask.hidden = false;

    var isImage = att.isImage || att.kind === 'image' || String(att.mime || '').indexOf('image/') === 0;
    if (isImage) {
      var img = createEl('img', 'preview-img');
      img.src = att.url;
      img.alt = att.filename;
      previewBody.appendChild(img);
      return;
    }

    var ext = String(att.filename || '').split('.').pop().toLowerCase();
    if (att.kind === 'pdf' || ext === 'pdf') {
      var frame = createEl('iframe', 'preview-frame');
      frame.src = att.url;
      frame.title = att.filename;
      previewBody.appendChild(frame);
      return;
    }

    // 文本类 / Office 文档：取服务端抽取的文本预览
    try {
      var r = await fetchJson(att.previewUrl || ('/api/uploads/' + att.id + '/preview'), { headers: JSON_HEADERS });
      if (r.status === 401) { closePreviewModal(); return handleSessionExpired(); }
      var data = r.data && r.data.attachment;
      if (r.ok && data && data.previewText) {
        var pre = createEl('pre', 'preview-text');
        pre.textContent = data.previewText;
        previewBody.appendChild(pre);
        previewHint.textContent = formatSize(att.size || 0) + ' · 文本预览';
      } else if (r.ok && data && data.inlineOpen) {
        closePreviewModal();
        window.open(att.url, '_blank', 'noopener');
      } else {
        previewBody.appendChild(createEl('p', 'preview-empty', '该文件类型不支持在线预览，请点击下方按钮下载查看。'));
      }
    } catch (err) {
      previewBody.appendChild(createEl('p', 'preview-empty', '预览加载失败，请下载查看。'));
    }
  }

  /* ========================= AI 生图 ========================= */

  function openImageModal() {
    if (!currentUser) { flashLoginHint(); return; }
    imageModalMask.hidden = false;
    imageModalHint.textContent = '';
    loadImageHistory();
    window.setTimeout(function () { imagePrompt.focus(); }, 50);
  }

  function closeImageModal() {
    imageModalMask.hidden = true;
  }

  async function loadImageHistory() {
    clearChildren(imageGrid);
    var r = await fetchJson('/api/images', { headers: JSON_HEADERS });
    if (r.status === 401) { handleSessionExpired(); return; }
    var images = (r.ok && r.data && r.data.success === true) ? (r.data.images || []) : [];
    images.forEach(function (item) {
      var card = createEl('a', 'image-card');
      card.href = item.url;
      card.target = '_blank';
      card.rel = 'noopener';
      card.title = item.prompt;
      var img = createEl('img', 'image-card-img');
      img.src = item.url;
      img.alt = item.prompt;
      img.loading = 'lazy';
      card.appendChild(img);
      card.appendChild(createEl('span', 'image-card-prompt', item.prompt));
      imageGrid.appendChild(card);
    });
    if (!images.length) {
      imageGrid.appendChild(createEl('p', 'image-grid-empty', '还没有生成记录'));
    }
  }

  async function generateImage() {
    var prompt = imagePrompt.value.trim();
    if (!prompt) {
      imageModalHint.textContent = '请先输入描述';
      return;
    }
    imageGenSubmit.disabled = true;
    imageModalHint.textContent = '生成中…（可能需要几十秒）';
    var r = await fetchJson('/api/images/generate', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ prompt: prompt })
    });
    imageGenSubmit.disabled = false;
    if (r.status === 401) { handleSessionExpired(); return; }
    if (!r.ok || !r.data || r.data.success !== true) {
      imageModalHint.textContent = (r.data && r.data.message) || '图片生成失败，请重试。';
      return;
    }
    imageModalHint.textContent = '生成完成';
    imagePrompt.value = '';
    await loadImageHistory();
  }

  /* ========================= 事件绑定 ========================= */

  function bindEvents() {
    // 表单提交（点击发送按钮）
    chatForm.addEventListener('submit', function (event) {
      event.preventDefault();
      sendMessage();
    });

    // 输入时：自动增高 + 刷新发送按钮状态
    messageInput.addEventListener('input', function () {
      autoResize();
      refreshSendButton();
    });

    // 键盘：Enter 发送，Shift + Enter 换行
    messageInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        sendMessage();
      }
    });

    // 新建对话
    newChatBtn.addEventListener('click', newConversation);

    // 退出登录
    logoutBtn.addEventListener('click', logout);

    // 侧边栏开关
    menuBtn.addEventListener('click', toggleSidebar);
    sidebarMask.addEventListener('click', closeSidebar);

    // 历史对话：点击选中；点击「⋯」弹出菜单（事件委托）
    historyList.addEventListener('click', function (event) {
      var moreBtn = event.target.closest('.conv-more');
      if (moreBtn) {
        event.stopPropagation();
        if (openMenuEl) closeConvMenu(); else openConvMenu(moreBtn);
        return;
      }
      var itemBtn = event.target.closest('.history-item');
      if (!itemBtn) return;
      selectConversation(Number(itemBtn.dataset.id));
    });

    // 快捷问题卡片：登录后自动创建会话并直接发送；未登录则提示登录
    suggestions.addEventListener('click', function (event) {
      var card = event.target.closest('.suggestion-card');
      if (!card) return;
      var text = card.dataset.text || '';
      if (!text || isSending) return;
      if (!currentUser) { flashLoginHint(); return; }
      sendMessage(text);
    });

    // 点击页面其它位置 / 滚动 / 尺寸变化时收起「⋯」菜单
    document.addEventListener('click', function (event) {
      if (!openMenuEl) return;
      if (openMenuEl.contains(event.target)) return;
      closeConvMenu();
    });
    chatScroll.addEventListener('scroll', closeConvMenu, { passive: true });
    historyList.addEventListener('scroll', closeConvMenu, { passive: true });
    window.addEventListener('resize', closeConvMenu);

    // Esc：先关菜单，再关侧边栏
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (!imageModalMask.hidden) { closeImageModal(); return; }
      if (openMenuEl) { closeConvMenu(); return; }
      closeSidebar();
    });

    // 联网搜索开关
    searchToggle.addEventListener('click', function () {
      webSearchOn = !webSearchOn;
      searchToggle.classList.toggle('is-on', webSearchOn);
      searchToggle.setAttribute('aria-pressed', webSearchOn ? 'true' : 'false');
      searchToggle.title = webSearchOn
        ? '联网搜索：已开启（每次提问先检索网页）'
        : '联网搜索：开启后每次提问先检索网页，回答带 [编号] 来源';
    });

    // 文件上传
    attachBtn.addEventListener('click', function () { fileInput.click(); });
    fileInput.addEventListener('change', function () {
      if (fileInput.files && fileInput.files.length) uploadFiles(fileInput.files);
      fileInput.value = '';
    });
    attachChips.addEventListener('click', function (event) {
      var del = event.target.closest('.attach-chip-del');
      if (del) { deleteAttachment(Number(del.dataset.id)); return; }
      // 点击 chip 本体 -> 预览
      var chip = event.target.closest('.attach-chip');
      if (!chip) return;
      var idx = Array.prototype.indexOf.call(attachChips.children, chip);
      if (idx > -1 && currentAttachments[idx]) openAttachmentPreview(currentAttachments[idx]);
    });

    // 附件预览弹窗
    previewModalClose.addEventListener('click', closePreviewModal);
    previewModalMask.addEventListener('click', function (event) {
      if (event.target === previewModalMask) closePreviewModal();
    });

    // AI 生图
    imageGenBtn.addEventListener('click', openImageModal);
    imageModalClose.addEventListener('click', closeImageModal);
    imageModalMask.addEventListener('click', function (event) {
      if (event.target === imageModalMask) closeImageModal();
    });
    imageGenSubmit.addEventListener('click', generateImage);

    // 窗口尺寸变化时同步侧边栏形态
    window.addEventListener('resize', function () {
      if (isNarrow()) {
        appRoot.classList.remove('sidebar-collapsed');
        if (!appRoot.classList.contains('sidebar-open')) {
          sidebarMask.classList.remove('show');
          sidebarMask.hidden = true;
        }
      } else {
        appRoot.classList.remove('sidebar-open');
        sidebarMask.classList.remove('show');
        sidebarMask.hidden = true;
      }
      autoResize();
    });
  }

  /* ========================= 初始化 ========================= */

  function init() {
    bindEvents();
    autoResize();
    applyComposerState();
    renderConversations();
    updateWelcomeVisibility();
    checkBackend();
    loadMe();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
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
  var LOGIN_REQUIRED_PLACEHOLDER = '登录后开始对话';
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
  var modelMenu       = document.getElementById('modelMenu');
  var authArea        = document.getElementById('authArea');
  var logoutBtn       = document.getElementById('logoutBtn');
  var themeToggle     = document.getElementById('themeToggle');
  var chatSearchInput = document.getElementById('chatSearch');
  var authPanel       = document.getElementById('authPanel');
  var authTabLogin    = document.getElementById('tabLogin');
  var authTabRegister = document.getElementById('tabRegister');
  var authUsername    = document.getElementById('authUsername');
  var authPassword    = document.getElementById('authPassword');
  var authSubmit      = document.getElementById('authSubmit');
  var authError       = document.getElementById('authError');
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
  var isUploading             = false; // 是否有附件正在上传（上传完成前禁止发送，避免消息漏掉附件）
  var availableModels         = [];    // 服务端允许的模型列表（GET /api/models）
  var selectedModel           = '';    // 当前选择的模型（localStorage 持久化）
  var activeStream            = null;  // 正在进行的流式请求 { controller }，用于「停止生成」
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
      setHistoryTip('登录后，你的对话会保存在这里');
      return;
    }
    if (!conversations.length) {
      setHistoryTip('还没有对话，点击「新建对话」开始');
      return;
    }

    var visible = conversations.filter(matchesSearch);
    var kwNow = chatSearchKeyword();
    if (!visible.length) {
      setHistoryTip('没有匹配「' + String(chatSearchInput.value || '').trim() + '」的对话');
      return;
    }
    setHistoryTip(kwNow
      ? '找到 ' + visible.length + ' 个匹配的对话'
      : '共 ' + conversations.length + ' 个对话 · 仅自己可见');

    visible.forEach(function (conv) {
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
  async function selectConversation(id, opts) {
    var force = Boolean(opts && opts.force);
    if (isSending) return;             // 生成中不切换，避免流式内容写进气泡错误
    if (!force && id === currentConversationId && messageList.childElementCount > 0) {
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
      appendMessage(m.role === 'user' ? 'user' : 'ai', m.content, m.attachments, { id: m.id, model: m.model });
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

  /** 导出会话为 Markdown 文件（Open WebUI 的导出能力） */
  async function exportConversation(conv) {
    var r = await fetchJson(API_CONVERSATIONS + '/' + conv.id + '/messages', { headers: JSON_HEADERS });
    if (r.status === 401) return handleSessionExpired();
    if (!r.ok || !r.data || !Array.isArray(r.data.messages)) {
      setHistoryTip('导出失败，请稍后重试');
      return;
    }
    var lines = ['# ' + (conv.title || DEFAULT_TITLE), ''];
    r.data.messages.forEach(function (m) {
      lines.push('## ' + (m.role === 'user' ? '我' : ('AI' + (m.model ? '（' + m.model + '）' : ''))));
      lines.push('');
      lines.push(String(m.content || ''));
      if (Array.isArray(m.attachments) && m.attachments.length) {
        lines.push('');
        lines.push('附件：' + m.attachments.map(function (a) { return a.filename; }).join('、'));
      }
      lines.push('');
    });

    var blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = String(conv.title || DEFAULT_TITLE).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) + '.md';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    setHistoryTip('已导出「' + (conv.title || DEFAULT_TITLE) + '」');
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

    var exportBtn = createEl('button', 'conv-menu-item', '导出 Markdown');
    exportBtn.type = 'button';
    exportBtn.setAttribute('role', 'menuitem');
    exportBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      closeConvMenu();
      exportConversation(conv);
    });

    menu.appendChild(renameBtn);
    menu.appendChild(exportBtn);
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
  function appendMessage(role, text, attachments, meta) {
    var info = meta || {};
    var isUser = role === 'user';
    var root = createEl('div', 'msg ' + (isUser ? 'msg-user' : 'msg-ai'));
    if (info.id) root.dataset.messageId = String(info.id);

    if (!isUser) {
      var avatar = createEl('span', 'msg-avatar', 'AI');
      avatar.setAttribute('aria-hidden', 'true');
      root.appendChild(avatar);
    }

    var body = createEl('div', 'msg-body');
    if (!isUser) {
      var roleEl = createEl('span', 'msg-role', 'AI');
      // 回答下方的模型标签（类似 Open WebUI 显示由哪个模型回答）
      if (info.model) roleEl.appendChild(createEl('span', 'msg-model-tag', info.model));
      body.appendChild(roleEl);
    }

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
      enhanceCodeBlocks(textEl);
    }

    body.appendChild(textEl);
    body.appendChild(buildMsgActions(isUser));
    root.appendChild(body);
    messageList.appendChild(root);

    updateWelcomeVisibility();
    scrollToBottom();

    return { root: root, textEl: textEl };
  }

  /** 消息操作条：用户消息 = 复制/编辑/删除；AI 消息 = 复制/重新生成/删除 */
  function buildMsgActions(isUser) {
    var bar = createEl('div', 'msg-actions');
    var acts = isUser
      ? [['copy', '复制'], ['edit', '编辑'], ['delete', '删除', 'is-danger']]
      : [['copy', '复制'], ['regen', '重新生成'], ['delete', '删除', 'is-danger']];
    acts.forEach(function (a) {
      var btn = createEl('button', 'msg-action' + (a[2] ? ' ' + a[2] : ''), a[1]);
      btn.type = 'button';
      btn.dataset.act = a[0];
      btn.title = a[1];
      bar.appendChild(btn);
    });
    return bar;
  }

  /** 给 Markdown 代码块加「复制」按钮（Open WebUI 同款交互） */
  function enhanceCodeBlocks(container) {
    if (!container) return;
    Array.prototype.forEach.call(container.querySelectorAll('pre'), function (pre) {
      if (pre.querySelector('.code-copy')) return;
      var btn = createEl('button', 'code-copy', '复制');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        var codeEl = pre.querySelector('code') || pre;
        var codeText = codeEl ? codeEl.textContent : '';
        copyText(codeText).then(function () {
          btn.textContent = '已复制';
          btn.classList.add('is-done');
          window.setTimeout(function () {
            btn.textContent = '复制';
            btn.classList.remove('is-done');
          }, 1600);
        });
      });
      pre.appendChild(btn);
    });
  }

  /** 复制文本到剪贴板（兼容 http / 旧浏览器） */
  function copyText(text) {
    var value = String(text || '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).catch(function () { return legacyCopy(value); });
    }
    return Promise.resolve(legacyCopy(value));
  }

  function legacyCopy(value) {
    try {
      var ta = document.createElement('textarea');
      ta.value = value;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { /* 忽略 */ }
    return undefined;
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
    // 生成中再点发送 = 停止生成（Open WebUI 同款交互）
    if (activeStream) { activeStream.controller.abort(); return; }
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
    var userParts = appendMessage('user', text, sentAttachments, {});
    if (!fromPreset) {
      messageInput.value = '';
      autoResize();
    }

    // 2. 创建空的 AI 气泡
    var parts = appendAssistantPlaceholder();

    // 3. 连接流式接口，逐段渲染
    try {
      await streamReply(convId, text, parts, { userRoot: userParts.root });
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
  async function streamReply(convId, text, parts, options) {
    var opts = options || {};
    streamBuffer = '';
    streamTarget = parts.textEl;

    // 请求体：regenerate 模式不带 message；始终带上当前选择的模型（服务端会做白名单校验）
    var payload = opts.regenerate ? { regenerate: true } : { message: text, search: webSearchOn };
    if (selectedModel) payload.model = selectedModel;

    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    activeStream = controller ? { controller: controller } : null;
    refreshSendButton();

    var res;
    try {
      res = await fetch(API_CONVERSATIONS + '/' + convId + '/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined
      });
    } catch (networkError) {
      activeStream = null;
      refreshSendButton();
      flushStreamRender();
      if (networkError && networkError.name === 'AbortError') {
        // 用户点「停止生成」：后端检测到客户端断开后不会保存半截回答
        parts.root.parentNode && parts.root.parentNode.removeChild(parts.root);
        updateWelcomeVisibility();
        return;
      }
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
          } else if (evt.type === 'done') {
            // browser 对话模式：增量是纯文本伪流式，最终排版以 done 携带的 Markdown 全文为准
            if (typeof evt.fullText === 'string' && evt.fullText) finalFullText = evt.fullText;
            if (evt.messageId) parts.root.dataset.messageId = String(evt.messageId);
            if (evt.model) {
              var roleEl = parts.root.querySelector('.msg-role');
              if (roleEl && !roleEl.querySelector('.msg-model-tag')) {
                roleEl.appendChild(createEl('span', 'msg-model-tag', evt.model));
              }
            }
          } else if (evt.type === 'start') {
            // 记录用户消息 id（编辑 / 删除需要）
            if (evt.userMessageId && opts.userRoot) opts.userRoot.dataset.messageId = String(evt.userMessageId);
          }
        }
      }
    } catch (streamError) {
      if (streamError && streamError.name === 'AbortError') {
        // 用户点了「停止生成」：丢弃半截内容（服务端检测到断连也不会落库）
        activeStream = null;
        refreshSendButton();
        streamTarget = null;
        streamBuffer = '';
        if (parts.root.parentNode) parts.root.parentNode.removeChild(parts.root);
        updateWelcomeVisibility();
        return;
      }
      console.warn('[组内 AI] 流式接收中断：', streamError);
      errorMessage = errorMessage || STREAM_ERROR_TEXT;
    }

    activeStream = null;
    refreshSendButton();

    parts.root.classList.remove('is-streaming');
    if (finalFullText) streamBuffer = finalFullText; // 用 Markdown 全文替换纯文本累积
    flushStreamRender();
    enhanceCodeBlocks(parts.textEl);

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

  /* ========================= 消息操作（Open WebUI 风格） ========================= */

  /** 找到消息根节点（从操作按钮向上找 .msg） */
  function msgRootOf(el) {
    while (el && el !== messageList) {
      if (el.classList && el.classList.contains('msg')) return el;
      el = el.parentElement;
    }
    return null;
  }

  /** 是否是该会话最后一条消息（重新生成只支持最后一条 AI 回答） */
  function isLastMessage(root) {
    var msgs = messageList.querySelectorAll('.msg');
    return msgs.length > 0 && msgs[msgs.length - 1] === root;
  }

  async function handleMsgAction(act, root) {
    var textEl = root.querySelector('.msg-text');
    var isUser = root.classList.contains('msg-user');
    var messageId = Number(root.dataset.messageId) || null;

    if (act === 'copy') {
      await copyText(textEl ? textEl.innerText : '');
      return;
    }

    if (act === 'regen') {
      if (!isLastMessage(root)) { setHistoryTip('只能重新生成最后一条回答'); return; }
      await regenerateLastAnswer();
      return;
    }

    if (act === 'edit') {
      if (!isUser || !messageId) return;
      startEditMessage(root, messageId, textEl);
      return;
    }

    if (act === 'delete') {
      if (!messageId) return;
      var ok = window.confirm(isUser
        ? '删除这条消息及其之后的全部对话？此操作不可撤销。'
        : '删除这条回答及其之后的全部对话？此操作不可撤销。');
      if (!ok) return;
      var r = await fetchJson(API_CONVERSATIONS + '/' + currentConversationId + '/messages/' + messageId, {
        method: 'DELETE', headers: JSON_HEADERS
      });
      if (r.status === 401) return handleSessionExpired();
      if (!r.ok) { setHistoryTip('删除失败，请重试'); return; }
      await selectConversation(currentConversationId, { force: true });
      return;
    }
  }

  /** 行内编辑用户消息：保存后自动重新生成回答 */
  function startEditMessage(root, messageId, textEl) {
    if (root.querySelector('.msg-edit-box')) return;
    var original = textEl ? textEl.innerText : '';
    var box = createEl('div', 'msg-edit-box');
    var input = createEl('textarea', 'msg-edit-input');
    input.value = original;
    var row = createEl('div', 'msg-edit-actions');
    var cancel = createEl('button', 'msg-edit-btn', '取消');
    cancel.type = 'button';
    var save = createEl('button', 'msg-edit-btn is-primary', '保存并重新生成');
    save.type = 'button';
    row.appendChild(cancel);
    row.appendChild(save);
    box.appendChild(input);
    box.appendChild(row);

    var body = root.querySelector('.msg-body');
    var actionBar = root.querySelector('.msg-actions');
    if (!body) return;
    body.insertBefore(box, actionBar || null);
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);

    cancel.addEventListener('click', function () { box.remove(); });
    save.addEventListener('click', async function () {
      var content = input.value.trim();
      if (!content) { input.focus(); return; }
      save.disabled = true;
      save.textContent = '保存中…';
      var r = await fetchJson(API_CONVERSATIONS + '/' + currentConversationId + '/messages/' + messageId, {
        method: 'PATCH',
        headers: JSON_HEADERS,
        body: JSON.stringify({ content: content })
      });
      if (r.status === 401) return handleSessionExpired();
      if (!r.ok) {
        save.disabled = false;
        save.textContent = '保存并重新生成';
        setHistoryTip((r.data && r.data.message) || '保存失败，请重试');
        return;
      }
      // 服务端已删除该消息之后的全部内容：重新拉取后触发重答
      await selectConversation(currentConversationId, { force: true });
      await regenerateLastAnswer();
    });
  }

  /** 重新生成最后一条回答：清掉最后的 AI 气泡，重发流式请求（regenerate=true） */
  async function regenerateLastAnswer() {
    if (isSending) return;
    var msgs = Array.prototype.slice.call(messageList.querySelectorAll('.msg'));
    var lastAi = msgs.length ? msgs[msgs.length - 1] : null;
    if (lastAi && lastAi.classList.contains('msg-ai')) {
      lastAi.parentNode.removeChild(lastAi);
    }
    var parts = appendAssistantPlaceholder();
    isSending = true;
    refreshSendButton();
    try {
      await streamReply(currentConversationId, null, parts, { regenerate: true });
    } finally {
      isSending = false;
      refreshSendButton();
    }
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
    var streaming = Boolean(activeStream);
    // 生成中：按钮变「停止」，任何情况下都可点；否则按常规禁用规则
    sendBtn.disabled = streaming ? false : (isSending || isUploading || !currentUser || messageInput.value.trim() === '');
    sendBtn.classList.toggle('is-stop', streaming);
    var wantIcon = streaming ? 'stop' : 'send';
    if (sendBtn.dataset.icon !== wantIcon) {
      sendBtn.dataset.icon = wantIcon;
      sendBtn.innerHTML = streaming
        ? '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="2" fill="currentColor"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>';
    }
    sendBtn.title = streaming ? '停止生成' : (isUploading ? '附件上传中，请稍候…' : '');
    sendBtn.setAttribute('aria-label', streaming ? '停止生成' : '发送消息');
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
    if (userStatus) userStatus.textContent = '请先登录';
    var link = authArea.querySelector('.btn-feishu-login');
    if (!link) return;
    link.classList.remove('pulse');
    void link.offsetWidth; // 强制重排，让动画可以重复触发
    link.classList.add('pulse');
    window.setTimeout(function () { link.classList.remove('pulse'); }, 1400);
  }

  /* ========================= 模型选择器 ========================= */

  var MODEL_KEY = 'feishu_ai_model';

  function readSavedModel() {
    try { return localStorage.getItem(MODEL_KEY) || ''; } catch (e) { return ''; }
  }
  function saveModel(name) {
    try { localStorage.setItem(MODEL_KEY, name); } catch (e) { /* 忽略 */ }
  }

  /** 渲染模型下拉菜单（当前项高亮） */
  function renderModelMenu() {
    if (!modelMenu) return;
    clearChildren(modelMenu);
    availableModels.forEach(function (name) {
      var item = createEl('button', 'model-menu-item' + (name === selectedModel ? ' is-active' : ''), name);
      item.type = 'button';
      item.dataset.model = name;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', name === selectedModel ? 'true' : 'false');
      if (name === selectedModel) item.appendChild(createEl('span', 'check', '✓'));
      modelMenu.appendChild(item);
    });
  }

  function closeModelMenu() {
    if (!modelMenu) return;
    modelMenu.hidden = true;
    if (modelChip) modelChip.setAttribute('aria-expanded', 'false');
  }

  function toggleModelMenu() {
    if (!modelMenu || availableModels.length < 2) return; // 只有一个模型时无需选择
    modelMenu.hidden = !modelMenu.hidden;
    modelChip.setAttribute('aria-expanded', modelMenu.hidden ? 'false' : 'true');
  }

  /** 选择模型：持久化 + 更新 chip + 关菜单 */
  function chooseModel(name) {
    if (availableModels.indexOf(name) === -1) return;
    selectedModel = name;
    saveModel(name);
    if (modelChipText) modelChipText.textContent = name;
    renderModelMenu();
    closeModelMenu();
  }

  /** 启动时拉取可选模型：校验本机保存的选择是否仍在白名单里 */
  async function loadModels(fallbackModel) {
    var saved = readSavedModel();
    try {
      var r = await fetchJson('/api/models', { headers: JSON_HEADERS });
      if (r.ok && r.data && Array.isArray(r.data.models)) availableModels = r.data.models;
    } catch (e) { /* 忽略：退化为单模型 */ }
    if (!availableModels.length && fallbackModel) availableModels = [fallbackModel];

    if (saved && availableModels.indexOf(saved) > -1) selectedModel = saved;
    else selectedModel = (fallbackModel && availableModels.indexOf(fallbackModel) > -1)
      ? fallbackModel
      : (availableModels[0] || '');

    if (modelChipText) modelChipText.textContent = selectedModel || 'AI 已接入 · 流式输出';
    renderModelMenu();
  }

  /* ========================= 主题（深色 / 浅色） ========================= */

  var THEME_KEY = 'feishu_ai_theme';

  /** 初始主题：用户显式选择 > 系统偏好 > 浅色 */
  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function initTheme() {
    var saved = null;
    try { saved = localStorage.getItem(THEME_KEY); } catch (e) { /* 隐私模式忽略 */ }
    if (saved === 'dark' || saved === 'light') { applyTheme(saved); return; }
    var preferDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    applyTheme(preferDark ? 'dark' : 'light');
  }

  function toggleTheme() {
    var next = currentTheme() === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try { localStorage.setItem(THEME_KEY, next); } catch (e) { /* 忽略 */ }
  }

  initTheme();

  /* ========================= 会话搜索（前端过滤） ========================= */

  function chatSearchKeyword() {
    return chatSearchInput ? String(chatSearchInput.value || '').trim().toLowerCase() : '';
  }

  function matchesSearch(conv) {
    var kw = chatSearchKeyword();
    if (!kw) return true;
    return String(conv.title || '').toLowerCase().indexOf(kw) > -1;
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
      if (modelChip) modelChip.classList.add('ready');
      // 拉取可选模型列表并渲染选择器；chip 显示当前模型名
      await loadModels(r.data.model || '');
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

  /** 未登录：主区域显示本地账号 登录/注册 面板，右上角清空 */
  function renderLoggedOut(hint) {
    clearChildren(authArea);
    if (authPanel) authPanel.hidden = false;
    renderSidebarUser(null);
    userStatus.textContent = hint || '未登录';
    logoutBtn.hidden = true;
  }

  /** 已登录：右上角显示头像 + 姓名 */
  function renderLoggedIn(user) {
    clearChildren(authArea);
    var chip = createEl('span', 'current-user');
    chip.appendChild(buildAvatarNode(user));
    chip.appendChild(createEl('span', 'current-user-name', user.name || '飞书用户'));
    chip.title = '账号：' + (user.userId || user.name || '');
    authArea.appendChild(chip);

    if (authPanel) authPanel.hidden = true;
    renderSidebarUser(user);
    userStatus.textContent = '已登录';
    logoutBtn.hidden = false;
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
    var hint = '';
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

  /* ========================= 本地账号 登录/注册 ========================= */

  var authMode = 'login';

  function setAuthMode(mode) {
    authMode = mode;
    authTabLogin.classList.toggle('is-active', mode === 'login');
    authTabRegister.classList.toggle('is-active', mode === 'register');
    authSubmit.textContent = mode === 'login' ? '登 录' : '注册并登录';
    authPassword.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    authError.textContent = '';
  }

  async function submitAuth() {
    var username = authUsername.value.trim();
    var password = authPassword.value;
    if (!username || !password) { authError.textContent = '请填写用户名和密码'; return; }
    authSubmit.disabled = true;
    authError.textContent = '';
    try {
      var r = await fetchJson(authMode === 'login' ? '/auth/login' : '/auth/register', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ username: username, password: password })
      });
      if (r.ok && r.data && r.data.success === true) {
        authPassword.value = '';
        await loadMe();
        return;
      }
      authError.textContent = (r.data && r.data.message) || '操作失败，请重试';
    } catch (err) {
      authError.textContent = '网络错误，请重试';
    } finally {
      authSubmit.disabled = false;
    }
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
    isUploading = true;
    refreshSendButton();
    try {
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
    } finally {
      // 无论成功 / 失败 / 会话过期：都要解除「上传中」锁定，否则发送按钮会一直禁用
      isUploading = false;
      refreshSendButton();
    }
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
        if (activeStream) return; // 生成中：Enter 不打断（要停请点「停止」按钮）
        sendMessage();
      }
    });

    // 新建对话
    newChatBtn.addEventListener('click', newConversation);

    // 退出登录
    logoutBtn.addEventListener('click', logout);
    if (themeToggle) themeToggle.addEventListener('click', toggleTheme);
    if (chatSearchInput) {
      chatSearchInput.addEventListener('input', function () { renderConversations(); });
    }

    // 消息操作条（事件委托，避免给每条消息单独绑定）
    messageList.addEventListener('click', function (event) {
      var btn = event.target.closest('.msg-action');
      if (!btn) return;
      var root = msgRootOf(btn);
      if (!root) return;
      handleMsgAction(btn.dataset.act, root);
    });

    // 模型选择器
    if (modelChip) modelChip.addEventListener('click', function (event) {
      event.stopPropagation();
      toggleModelMenu();
    });
    if (modelMenu) {
      modelMenu.addEventListener('click', function (event) {
        var item = event.target.closest('.model-menu-item');
        if (!item) return;
        chooseModel(item.dataset.model);
      });
    }
    document.addEventListener('click', function (event) {
      if (!modelMenu || modelMenu.hidden) return;
      if (event.target.closest('.model-picker')) return;
      closeModelMenu();
    });

    // 本地账号登录/注册
    authTabLogin.addEventListener('click', function () { setAuthMode('login'); });
    authTabRegister.addEventListener('click', function () { setAuthMode('register'); });
    authSubmit.addEventListener('click', submitAuth);
    authPassword.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitAuth(); });
    authUsername.addEventListener('keydown', function (e) { if (e.key === 'Enter') authPassword.focus(); });

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
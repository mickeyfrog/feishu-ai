/**
 * 文件附件服务层：类型白名单 + 文本抽取
 * -------------------------------------------------------------
 * - 白名单之外的扩展名一律拒绝（415）；文件大小**默认不限制**（可用 UPLOAD_MAX_MB 兜底）
 * - 格式对齐 ChatGPT 上传：文档（pdf/docx/doc/pptx/xlsx/xls/csv/txt/md）、
 *   代码与数据文本（json/xml/html/js/ts/py/java/c/cpp/go/rs/php/sql/yaml 等）、图片（png/jpg/jpeg/gif/webp）
 * - 文档/文本类抽取纯文本进 AI 上下文；图片走多模态视觉（随消息内联 base64 发给模型）
 * - 老二进制 doc 只保存预览，不抽取（mammoth 只认 docx）
 * - 抽取文本按 MAX_ATTACHMENT_CHARS 截断，避免撑爆模型上下文
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import XLSX from 'xlsx';
import JSZip from 'jszip';

/**
 * 单文件大小上限：**默认不限制**（Infinity）。
 * 如确需兜底，可在 .env 设置 UPLOAD_MAX_MB=<数字>（单位 MB）；不设置即无限制。
 */
export function getMaxUploadBytes() {
  const mb = Number(process.env.UPLOAD_MAX_MB);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : Infinity;
}

/** 每个附件进入上下文的字符预算 */
export const MAX_ATTACHMENT_CHARS = 8000;

/** 扩展名白名单：ext -> { mime, kind } */
const TEXT_LIKE = ['txt', 'md', 'json', 'xml', 'html', 'htm',
  'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'cs', 'go', 'rs', 'rb', 'php',
  'sh', 'bat', 'ps1', 'sql', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'log', 'css', 'vue', 'ipynb'];

/** 扩展名白名单：ext -> { mime, kind }（对齐 ChatGPT 上传格式） */
export const FILE_TYPES = {
  pdf:  { mime: 'application/pdf', kind: 'pdf' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'docx' },
  doc:  { mime: 'application/msword', kind: 'doc' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'pptx' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'sheet' },
  xls:  { mime: 'application/vnd.ms-excel', kind: 'sheet' },
  csv:  { mime: 'text/csv', kind: 'sheet' },
  png:  { mime: 'image/png', kind: 'image' },
  jpg:  { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  gif:  { mime: 'image/gif', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' }
};
// 纯文本/代码类统一登记为 kind=text（前端可直接 inline 预览）
TEXT_LIKE.forEach(function (ext) {
  FILE_TYPES[ext] = { mime: 'text/plain; charset=utf-8', kind: 'text' };
});
FILE_TYPES.md = { mime: 'text/markdown; charset=utf-8', kind: 'text' };
FILE_TYPES.json = { mime: 'application/json', kind: 'text' };

export const ALLOWED_EXT_HINT =
  'pdf / docx / doc / pptx / xlsx / xls / csv / txt / md / json / xml / html / 常见代码文件 / png / jpg / jpeg / gif / webp';

/** 取小写扩展名（不含点） */
export function extOf(filename) {
  const name = String(filename || '');
  const idx = name.lastIndexOf('.');
  if (idx < 0 || idx === name.length - 1) return '';
  return name.slice(idx + 1).toLowerCase();
}

/** 去掉路径分隔符等危险字符，只保留展示用文件名 */
export function safeFilename(filename) {
  const base = String(filename || 'file').replace(/[\\/]+/g, '_').replace(/[\u0000-\u001f]/g, '');
  return base.slice(0, 120) || 'file';
}

function truncateText(text) {
  const value = String(text || '');
  if (value.length <= MAX_ATTACHMENT_CHARS) return value;
  return value.slice(0, MAX_ATTACHMENT_CHARS) +
    '\n…（内容过长，已截断；原文共 ' + value.length + ' 字符）';
}

/** 去掉 pdf-parse 追加的页码行，例如 "-- 1 of 3 --" */
function cleanPdfText(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(function (line) { return !/^--\s*\d+\s+of\s+\d+\s+--\s*$/.test(line.trim()); })
    .join('\n');
}

/**
 * 抽取文件纯文本。图片与老二进制 doc 返回 null。
 * @param {Buffer} buffer
 * @param {string} kind FILE_TYPES[ext].kind
 * @returns {Promise<string|null>}
 */
export async function extractText(buffer, kind) {
  if (kind === 'pdf') {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    const result = await parser.getText();
    return truncateText(cleanPdfText(result && result.text));
  }

  if (kind === 'docx') {
    const result = await mammoth.extractRawText({ buffer: buffer });
    return truncateText(result && result.value);
  }

  if (kind === 'sheet') {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const chunks = [];
    for (const sheetName of workbook.SheetNames) {
      const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[sheetName]);
      if (csv && csv.trim()) chunks.push('【工作表 ' + sheetName + '】\n' + csv);
    }
    return truncateText(chunks.join('\n\n'));
  }

  if (kind === 'pptx') {
    // pptx = zip 包：逐页读 ppt/slides/slideN.xml，抽 <a:t> 文本
    const zip = await JSZip.loadAsync(buffer);
    const slideNames = Object.keys(zip.files)
      .filter(function (n) { return /^ppt\/slides\/slide\d+\.xml$/.test(n); })
      .sort(function (a, b) {
        return Number(/slide(\d+)/.exec(a)[1]) - Number(/slide(\d+)/.exec(b)[1]);
      });
    const chunks = [];
    for (const name of slideNames) {
      const xml = await zip.files[name].async('string');
      const texts = [];
      const re = /<a:t>([\s\S]*?)<\/a:t>/g;
      let m;
      while ((m = re.exec(xml)) !== null) {
        const t = String(m[1])
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
        if (t.trim()) texts.push(t);
      }
      if (texts.length) chunks.push('【第 ' + /slide(\d+)/.exec(name)[1] + ' 页】\n' + texts.join('\n'));
    }
    return truncateText(chunks.join('\n\n'));
  }

  if (kind === 'text') {
    return truncateText(buffer.toString('utf8'));
  }

  // doc（老二进制）与 image 不抽取文本：doc 预览下载，image 走多模态视觉
  return null;
}

const hereDir = path.dirname(fileURLToPath(import.meta.url));
/** 附件磁盘根目录（routes/uploads.js 也用它） */
export const UPLOAD_ROOT = path.join(hereDir, '..', 'data', 'uploads');

/** 读取一个已存附件的磁盘内容（storedName 形如 <userId>/<随机名>，防路径穿越） */
export function readStoredFile(storedName) {
  const rel = String(storedName || '');
  if (!rel || rel.indexOf('..') > -1 || path.isAbsolute(rel)) return null;
  const full = path.join(UPLOAD_ROOT, rel);
  if (full.indexOf(UPLOAD_ROOT) !== 0) return null;
  try { return fs.readFileSync(full); } catch (e) { return null; }
}

/** 多模态视觉：单图原始字节上限（base64 后约 +33%） */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/**
 * 把图片附件行读成 { mime, data(base64) } 供多模态请求内联。
 * 读不到 / 超限的静默跳过（记日志），绝不让一张坏图拖垮整次对话。
 */
export function loadImagesAsBase64(rows) {
  const out = [];
  for (const row of rows || []) {
    const buf = readStoredFile(row.storedName || row.stored_name);
    if (!buf || !buf.length) continue;
    if (buf.length > MAX_IMAGE_BYTES) {
      console.error('[附件] 图片超过 8MB，跳过内联：id=' + row.id);
      continue;
    }
    out.push({ mime: row.mime || 'image/png', data: buf.toString('base64') });
  }
  return out;
}

/** 依据魔数识别生成图片的真实格式 */
export function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return { mime: 'application/octet-stream', ext: 'bin' };
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return { mime: 'image/png', ext: 'png' };
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return { mime: 'image/jpeg', ext: 'jpg' };
  if (buffer.slice(0, 4).toString('latin1') === 'RIFF' && buffer.slice(8, 12).toString('latin1') === 'WEBP') {
    return { mime: 'image/webp', ext: 'webp' };
  }
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) return { mime: 'image/gif', ext: 'gif' };
  return { mime: 'application/octet-stream', ext: 'bin' };
}
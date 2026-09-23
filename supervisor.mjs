/**
 * feishu-ai 进程守护（supervisor.mjs）
 * -------------------------------------------------------------
 * 用法：node supervisor.mjs   （由 restart 脚本 / 登录计划任务拉起）
 * 行为：
 *   - spawn `node server.js`（继承 .env）；子进程退出后自动重启
 *   - 5 分钟内重启超过 5 次则放弃（避免崩溃循环刷日志）
 *   - 重启与放弃都写日志到 %TEMP%/feishu-ai-supervisor.log
 *   - 收到 SIGTERM/SIGINT 时先杀子进程再退出（正常关停不触发重启）
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = 'D:/feishu-ai';
const LOG = path.join(os.tmpdir(), 'feishu-ai-supervisor.log');
const MAX_RESTARTS = 5;          // 窗口内最多重启次数
const WINDOW_MS = 5 * 60 * 1000; // 5 分钟窗口

let child = null;
let stopping = false;
let restarts = [];

function log(msg) {
  const line = '[' + new Date().toISOString() + '] ' + msg + '\n';
  try { fs.appendFileSync(LOG, line); } catch (e) { /* ignore */ }
  console.log(line.trim());
}

function start() {
  if (stopping) return;
  child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env
  });
  log('server.js 已启动，PID=' + child.pid);
  child.on('exit', function (code, signal) {
    if (stopping) return;
    const now = Date.now();
    restarts = restarts.filter(function (t) { return now - t < WINDOW_MS; });
    if (restarts.length >= MAX_RESTARTS) {
      log('放弃：5 分钟内已重启 ' + MAX_RESTARTS + ' 次（code=' + code + '），请检查 ' + path.join(os.tmpdir(), 'feishu-ai-err.log'));
      process.exitCode = 1;
      return;
    }
    restarts.push(now);
    const delay = Math.min(1000 * restarts.length, 5000);
    log('server.js 退出（code=' + code + ' signal=' + signal + '），' + delay + 'ms 后第 ' + restarts.length + ' 次重启');
    setTimeout(start, delay);
  });
}

function shutdown() {
  stopping = true;
  if (child && !child.killed) { try { child.kill(); } catch (e) { /* ignore */ } }
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
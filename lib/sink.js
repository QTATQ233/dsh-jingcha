/**
 * 鲸察 (dsh-jingcha) · 落盘（events.jsonl 追加 + status.json 原子替换）
 * ============================================================================
 * 约束：
 *   · 只用 node:fs / node:path；
 *   · 全部异步、串行化，绝不阻塞事件循环，绝不抛到调用方；
 *   · 磁盘出错只记账（errors/lastError）并丢弃积压，不让监察变成新的故障源。
 */

import fs from 'node:fs';
import path from 'node:path';

export function createSink(options = {}) {
  const dir = String(options.dir ?? '.dsh-jingcha');
  const logPath = path.join(dir, String(options.logFile ?? 'events.jsonl'));
  const statusPath = path.join(dir, String(options.statusFile ?? 'status.json'));
  const maxBytes = Number(options.maxBytes) > 1000 ? Number(options.maxBytes) : 8_000_000;
  const maxQueue = Number(options.maxQueue) > 0 ? Number(options.maxQueue) : 20_000;

  let queue = [];
  let dirReady = false;
  let dirError = '';
  let chain = Promise.resolve();
  let statusPending = null;
  let statusQueued = false;
  const stats = { written: 0, dropped: 0, errors: 0, statusWrites: 0, rotations: 0, lastError: '' };

  function ensureDir() {
    if (dirReady) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      dirReady = true;
      return true;
    } catch (error) {
      stats.errors++;
      dirError = String(error?.message ?? error);
      stats.lastError = 'mkdir ' + dir + ': ' + dirError;
      return false;
    }
  }

  function fail(where, error) {
    stats.errors++;
    stats.lastError = where + ': ' + String(error?.message ?? error);
  }

  /** 追加若干结构化事件（内存排队，稍后合并写盘）。 */
  function queueRecords(records) {
    if (!Array.isArray(records) || records.length === 0) return;
    if (queue.length + records.length > maxQueue) {
      const overflow = queue.length + records.length - maxQueue;
      stats.dropped += overflow;
      queue.splice(0, overflow);
    }
    queue.push(...records);
  }

  async function rotateIfNeeded(incoming) {
    try {
      const st = await fs.promises.stat(logPath);
      if (st.size + incoming <= maxBytes) return;
      const rotated = logPath + '.1';
      try { await fs.promises.rm(rotated, { force: true }); } catch { /* 旧轮转文件删不掉就算了 */ }
      await fs.promises.rename(logPath, rotated);
      stats.rotations++;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }

  async function appendBatch(batch) {
    if (!ensureDir()) { stats.dropped += batch.length; return; }
    let text = '';
    for (const record of batch) {
      try { text += JSON.stringify(record) + '\n'; } catch { stats.dropped++; }
    }
    if (text.length === 0) return;
    await rotateIfNeeded(text.length);
    await fs.promises.appendFile(logPath, text, 'utf8');
    stats.written += batch.length;
  }

  async function writeStatusNow(value) {
    if (!value) return;
    if (!ensureDir()) return;
    const tmp = statusPath + '.tmp';
    await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
    await fs.promises.rename(tmp, statusPath);
    stats.statusWrites++;
  }

  /** 排空队列写日志（返回可 await 的 Promise）。 */
  function flush() {
    if (queue.length === 0) return chain;
    const batch = queue;
    queue = [];
    chain = chain.then(() => appendBatch(batch)).catch((error) => {
      fail('append', error);
      stats.dropped += batch.length;
    });
    return chain;
  }

  /** 更新 status.json（保留最后一次内容，合并写入）。 */
  function status(value) {
    statusPending = value;
    if (statusQueued) return chain;
    statusQueued = true;
    chain = chain.then(async () => {
      statusQueued = false;
      const latest = statusPending;
      statusPending = null;
      if (latest) await writeStatusNow(latest);
    }).catch((error) => {
      statusQueued = false;
      fail('status', error);
    });
    return chain;
  }

  async function close() {
    await flush();
    if (statusPending) await status(statusPending);
    await chain;
  }

  return {
    dir,
    logPath,
    statusPath,
    queueRecords,
    flush,
    status,
    close,
    ensureDir,
    stats() { return { ...stats, queued: queue.length, dirError }; },
  };
}

export default createSink;

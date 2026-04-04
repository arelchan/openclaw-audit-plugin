const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { appendJsonl, ensureDir, getStateDir } = require('./log-store');

const AUDIT_SPAN_SCHEMA_VERSION = 'audit.span.v1';

// 子 session 嵌套映射：childSessionId -> { parentSpanId, traceId }
// 用于把子 session spans 以 trace/树结构嵌回主会话 trace 展示。
const subagentParentInfoByChildSessionId = new Map();

function getAuditArtifactsDir() {
  return ensureDir(path.join(getStateDir(), 'logs', 'audit-artifacts'));
}

function appendEvent(record) {
  try {
    appendJsonl('events', record);
  } catch {}
}

function appendSpan(span) {
  try {
    appendJsonl('spans', span);
  } catch {}
}

function genSpanId() {
  return `span-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

function safeFileSegment(value, fallback = 'unknown') {
  const normalized = String(value == null ? '' : value)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (normalized || fallback).slice(0, 80);
}

function hashText(text) {
  return crypto.createHash('sha1').update(text).digest('hex');
}

function previewText(value, maxLen = 400) {
  const text = typeof value === 'string' ? value : toJsonText(value);
  if (!text) return '';
  return text.length > maxLen ? `${text.slice(0, maxLen)}...` : text;
}

function buildArtifactPayload(payload) {
  if (payload == null) return { text: '', extension: 'json' };
  if (typeof payload === 'string') return { text: payload, extension: 'txt' };
  try {
    return { text: JSON.stringify(payload, null, 2), extension: 'json' };
  } catch {
    return { text: String(payload), extension: 'txt' };
  }
}

function persistArtifact(kind, meta, payload, options = {}) {
  try {
    const { text, extension } = buildArtifactPayload(payload);
    const sha1 = hashText(text);
    const day = new Date().toISOString().slice(0, 10);
    const dir = ensureDir(path.join(getAuditArtifactsDir(), safeFileSegment(kind), day));
    const fileName = [
      Date.now(),
      safeFileSegment(meta?.traceId || meta?.runId || 'trace'),
      safeFileSegment(meta?.sessionId || meta?.sessionKey || 'session'),
      safeFileSegment(options.label || kind),
      sha1.slice(0, 10)
    ].join('-');
    const filePath = path.join(dir, `${fileName}.${extension}`);
    fs.writeFileSync(filePath, text, { encoding: 'utf8' });
    return {
      kind,
      path: filePath,
      sha1,
      bytes: Buffer.byteLength(text, 'utf8'),
      preview: previewText(text, options.previewLength || 400)
    };
  } catch (error) {
    return {
      kind,
      path: null,
      sha1: null,
      bytes: null,
      preview: '',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function artifactAttributes(prefix, artifact) {
  if (!artifact) return {};
  return {
    [`${prefix}.artifact_path`]: artifact.path,
    [`${prefix}.artifact_sha1`]: artifact.sha1,
    [`${prefix}.artifact_bytes`]: artifact.bytes,
    ...(artifact.error ? { [`${prefix}.artifact_error`]: artifact.error } : {})
  };
}



function toJsonText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function extractToolResultTextFromAgentMessage(message) {
  if (!message || typeof message !== 'object') return '';
  // OpenClaw toolResultPersist：message.content 通常是 parts 数组
  const content = message.content;
  if (Array.isArray(content)) {
    const texts = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (typeof part.text === 'string') texts.push(part.text);
    }
    return texts.join('\n').trim();
  }
  if (typeof content === 'string') return content;
  if (typeof message.text === 'string') return message.text;
  return toJsonText(message);
}

function inferToolNameFromText(value) {
  const text = toJsonText(value);
  if (!text) return '';
  const patterns = [
    /Tool\s+([A-Za-z0-9._:-]+)\s+not found/i,
    /unknown tool[:\s]+([A-Za-z0-9._:-]+)/i,
    /tool["'\s:]+([A-Za-z0-9._:-]+)["'\s]+(?:is\s+)?not found/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return String(match[1]).trim();
  }
  return '';
}

function resolveToolName(event, pendingSpan = null) {
  const directCandidates = [
    event?.toolName,
    event?.message?.toolName,
    event?.details?.toolName,
    pendingSpan?.attributes?.['tool.name']
  ];
  for (const candidate of directCandidates) {
    const normalized = String(candidate || '').trim();
    if (normalized) return normalized;
  }

  const inferredCandidates = [
    event?.result,
    event?.error,
    event?.message,
    event?.details,
    event
  ];
  for (const candidate of inferredCandidates) {
    const inferred = inferToolNameFromText(candidate);
    if (inferred) return inferred;
  }
  return '';
}

/** 单条 assistant 片段 → 文本（兼容 string / { content,text,message } / 嵌套） */
function assistantPartToText(part) {
  if (part == null) return '';
  if (typeof part === 'string') return part.trim() ? part : '';
  if (typeof part !== 'object') return String(part);
  const inner =
    part.content ??
    part.text ??
    part.message ??
    part.body ??
    (typeof part.delta === 'string' ? part.delta : null);
  if (typeof inner === 'string' && inner.trim()) return inner;
  if (Array.isArray(part.content)) {
    const joined = part.content.map((c) => assistantPartToText(c)).filter(Boolean).join('');
    if (joined) return joined;
  }
  const j = toJsonText(part);
  return j && j !== '{}' && j !== 'null' ? j : '';
}

/** OpenClaw / volcengine 等：`assistantTexts` 为 assistant 消息数组 */
function pickFromAssistantTexts(event) {
  const arr = event?.assistantTexts;
  if (!Array.isArray(arr) || arr.length === 0) return '';
  const texts = arr.map((p) => assistantPartToText(p)).filter((s) => s && String(s).trim());
  return texts.length ? texts.join('\n') : '';
}

/** 最后一条 assistant 对象（常与 assistantTexts 二选一或并存） */
function pickFromLastAssistant(event) {
  const la = event?.lastAssistant;
  if (la == null) return '';
  const t = assistantPartToText(la);
  return t && String(t).trim() ? t : '';
}

/** 从 llm_output 事件里尽量取出「模型输出文本」（字段名因版本可能不同） */
function pickLlmOutputFromEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const fromAssist = pickFromAssistantTexts(event) || pickFromLastAssistant(event);
  if (fromAssist) return fromAssist;
  const candidates = [
    event.output,
    event.text,
    event.content,
    event.message,
    event.response,
    event.assistantText,
    event.assistantMessage,
    event.delta,
    event.completion
  ];
  for (const c of candidates) {
    if (c == null) continue;
    if (typeof c === 'string' && c.trim() !== '') return c;
    if (typeof c === 'object') {
      const j = toJsonText(c);
      if (j && j !== '{}' && j !== 'null') return j;
    }
  }
  return '';
}

function isLlmOutputEmpty(value) {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'object') {
    const j = toJsonText(value);
    return !j || j === '{}' || j === 'null';
  }
  return false;
}

/** output 为空时写入 span，便于对照 hook 实际字段（避免整包 history 进日志） */
function buildLlmOutputDebugPreview(event, maxLen = 2000) {
  if (!event || typeof event !== 'object') return { keys: [], preview: String(event) };
  const keys = Object.keys(event).sort();
  const out = {};
  for (const k of keys) {
    if (k === 'historyMessages') {
      out[k] = `[array:${Array.isArray(event[k]) ? event[k].length : '?'}]`;
      continue;
    }
    const v = event[k];
    if (v == null) out[k] = null;
    else if (typeof v === 'string') out[k] = v.length > 240 ? `${v.slice(0, 240)}…` : v;
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (Array.isArray(v)) out[k] = `[array:${v.length}]`;
    else if (typeof v === 'object') out[k] = '[object]';
    else out[k] = String(v);
  }
  try {
    const s = JSON.stringify(out);
    return { keys, preview: s.length > maxLen ? `${s.slice(0, maxLen)}…` : s };
  } catch {
    return { keys, preview: '[unserializable]' };
  }
}

function isUuidString(v) {
  if (v == null || typeof v !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.trim());
}

/** 从 systemPrompt 里 <available_skills> 片段解析技能名（格式随 OpenClaw 变化时需调整） */
function extractAvailableSkillNamesFromSystemPrompt(text) {
  if (!text || typeof text !== 'string') return [];
  const names = [];
  const re = /<name>([^<]+)<\/name>/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const n = m[1].trim();
    if (n) names.push(n);
  }
  return [...new Set(names)];
}

function summarizeEvent(event) {
  if (event == null) return { value: null };
  if (typeof event !== 'object') return { value: event };
  return {
    keys: Object.keys(event).sort(),
    provider: event.provider ?? null,
    model: event.model ?? null,
    callId: event.callId ?? null,
    toolName: resolveToolName(event) || null,
    toolCallId: event.toolCallId ?? null,
    historyMessagesCount: Array.isArray(event.historyMessages) ? event.historyMessages.length : null,
    imagesCount: event.imagesCount ?? null,
    promptPreview: previewText(event.prompt, 180),
    outputPreview: previewText(event.output, 180),
    childSessionKey: event.childSessionKey ?? event.targetSessionKey ?? null
  };
}

function uniqueStrings(values) {
  return [...new Set((values || []).filter(Boolean).map((value) => String(value)))];
}

function resolveSkillsScanDirectories(workspaceDir) {
  return uniqueStrings([
    '/usr/local/lib/node_modules/openclaw/skills',
    path.join(getStateDir(), 'skills'),
    workspaceDir ? path.join(workspaceDir, 'skills') : null
  ]);
}

function classifySkillSource(filePath, workspaceDir) {
  const normalizedPath = String(filePath || '');
  if (normalizedPath.startsWith('/usr/local/lib/node_modules/openclaw/skills/')) return 'bundled';
  if (normalizedPath.startsWith('/usr/local/lib/node_modules/openclaw/extensions/')) return 'bundled-plugin';
  if (normalizedPath.startsWith(`${path.join(getStateDir(), 'skills')}${path.sep}`)) return 'managed';
  if (workspaceDir && normalizedPath.startsWith(`${path.join(workspaceDir, 'skills')}${path.sep}`)) return 'workspace';
  if (
    normalizedPath.startsWith(`${getStateDir()}${path.sep}workspace-`) &&
    normalizedPath.includes(`${path.sep}skills${path.sep}`)
  ) {
    return 'workspace';
  }
  return 'unknown';
}

function findSkillPathInValue(value) {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.endsWith('SKILL.md') ? trimmed : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSkillPathInValue(item);
      if (found) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  for (const entry of Object.values(value)) {
    const found = findSkillPathInValue(entry);
    if (found) return found;
  }
  return null;
}

function extractSkillReadIntent(toolName, params) {
  if (String(toolName || '').trim().toLowerCase() !== 'read') return null;
  const filePath = findSkillPathInValue(params);
  if (!filePath || !String(filePath).includes('SKILL.md')) return null;
  return String(filePath);
}

function resolveObservedPath(filePath) {
  if (!filePath || typeof filePath !== 'string') return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

function inspectFile(filePath, readFileSyncImpl = fs.readFileSync.bind(fs)) {
  try {
    const resolvedPath = resolveObservedPath(filePath);
    const stat = fs.statSync(resolvedPath);
    const content = readFileSyncImpl(resolvedPath, 'utf8');
    return {
      resolvedPath,
      bytes: stat.size,
      sha1: hashText(content),
      preview: previewText(content, 240)
    };
  } catch (error) {
    return {
      resolvedPath: resolveObservedPath(filePath),
      bytes: null,
      sha1: null,
      preview: '',
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseJsonMaybe(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function readArtifactJson(filePath) {
  if (!filePath || typeof filePath !== 'string') return null;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function extractSessionsSpawnContext(span, persistedResultText) {
  if (String(span?.attributes?.['tool.name'] || '').trim().toLowerCase() !== 'sessions_spawn') return null;
  const inputArtifact = readArtifactJson(span?.attributes?.['tool.input.artifact_path']);
  const outputArtifact = readArtifactJson(span?.attributes?.['tool.output.artifact_path']);
  const input = inputArtifact?.params || parseJsonMaybe(span?.attributes?.['tool.args_preview']) || null;
  const output =
    parseJsonMaybe(persistedResultText) ||
    outputArtifact?.result?.content?.[0]?.text && parseJsonMaybe(outputArtifact.result.content[0].text) ||
    outputArtifact?.result ||
    null;
  if (!input || !output) return null;
  const runtime = String(input.runtime || '').trim().toLowerCase();
  if (runtime !== 'subagent') return null;
  const status = String(output.status || '').trim().toLowerCase();
  if (status !== 'accepted') return null;
  return {
    runtime,
    status,
    childSessionKey: output.childSessionKey || null,
    childSessionId: output.childSessionId || null,
    childRunId: output.runId || null,
    agentId: input.agentId || null,
    task: input.task || '',
    label: input.label || '',
    mode: input.mode || output.mode || null,
    toolCallId: span?.attributes?.['tool.call_id'] || null
  };
}

function pickSessionId(ctx, event) {
  // 非 subagent hook：通常有 ctx.sessionId 或 event.sessionId
  if (ctx?.sessionId) return ctx.sessionId;
  if (event?.sessionId) return event.sessionId;

  // subagent hook：区分 requester / target（child）
  // PluginHookSubagentContext: { requesterSessionKey?, childSessionKey?, runId? }
  if (ctx?.requesterSessionKey) return ctx.requesterSessionKey;
  if (ctx?.childSessionKey) return ctx.childSessionKey;

  // subagent hook event：直接带 child/target key
  if (event?.childSessionKey) return event.childSessionKey;
  if (event?.targetSessionKey) return event.targetSessionKey;
  if (event?.requesterSessionKey) return event.requesterSessionKey;

  // 兼容旧字段（可能来自 legacy/旧插件版本）
  if (event?.childSessionId) return event.childSessionId;
  if (event?.subSessionId) return event.subSessionId;

  return null;
}

function pickRunId(ctx, event) {
  // subagent hook 上下文里可能有 ctx.runId（requester run），用于保证同一 trace/回合关联
  if (ctx?.runId) return ctx.runId;
  return event?.runId || event?.run_id || event?.requestId || ctx?.sessionId || ctx?.sessionKey || 'unknown';
}

/** 子 session 可能以整段 sessionKey 或末尾 UUID 出现；多键注册避免 lookup 落空 */
function registerSubagentParentLinks(childSessionId, info) {
  if (childSessionId == null || childSessionId === '') return;
  const s = String(childSessionId);
  subagentParentInfoByChildSessionId.set(s, info);
  const m = s.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i);
  if (m) subagentParentInfoByChildSessionId.set(m[1], info);
}

function traceSessionRootKey(traceId, sessionId, sessionKey) {
  return [traceId || '', sessionId || '', sessionKey || ''].join('|');
}

function extractSubagentChildSessionRef(ctx, event) {
  const childSessionKey = event?.childSessionKey || event?.targetSessionKey || ctx?.childSessionKey || null;
  const childSessionId =
    event?.childSessionId ||
    event?.subSessionId ||
    (childSessionKey ? lastSessionIdBySessionKey.get(childSessionKey) || null : null);
  return {
    childSessionKey,
    childSessionId,
    pendingKey: childSessionKey || childSessionId || null
  };
}

/**
 * 子 session 内 hook 的 ctx.sessionId 常为 UUID，而 map 可能只登记了 agent:x:subagent:uuid；
 * 按 sessionKey / childSessionKey / targetSessionKey / pickSessionId 依次解析。
 */
function resolveSubagentParentLink(ctx, event) {
  const tried = new Set();
  const tryKey = (k) => {
    if (k == null || k === '') return null;
    const s = String(k);
    if (tried.has(s)) return null;
    tried.add(s);
    return subagentParentInfoByChildSessionId.get(s) || null;
  };
  const keys = [
    ctx?.sessionKey,
    ctx?.childSessionKey,
    event?.sessionKey,
    event?.childSessionKey,
    event?.targetSessionKey,
    pickSessionId(ctx, event)
  ];
  for (const k of keys) {
    const link = tryKey(k);
    if (link) return link;
  }
  return null;
}

/**
 * 区分「用户直接触发的模型调用」与「Agent↔Agent（子 agent / 嵌套会话）」等。
 * - a2a：子 agent session（sessionKey 含 :subagent:）或能解析到 subagent 父链
 * - user：OpenClaw trigger 为 user（主会话上用户一轮）
 * - automated：主 agent 在工具/编排后的续跑等（非用户直触、非子 agent）
 */
function classifyLlmInvocationSource(ctx, event, meta) {
  const sk = String((meta && meta.sessionKey) || ctx?.sessionKey || event?.sessionKey || '');
  if (sk.includes(':subagent:')) return 'a2a';
  if (resolveSubagentParentLink(ctx, event)) return 'a2a';
  const t = (meta && meta.trigger) ?? ctx?.trigger ?? event?.trigger ?? null;
  if (t === 'user') return 'user';
  return 'automated';
}

/** @type {import('openclaw/dist/plugin-sdk').OpenClawPluginModule} */
module.exports = async function auditPlugin(api) {
  const { logger } = api;

  const runStateByRunId = new Map();
  /**
   * OpenClaw 里 tool_result_persist 的 meta.runId 常与 before_tool_call 不一致（persist 用 trace/父 run），
   * getRunState 不是同一个桶 → consumePendingTool 落空 → 只能新建空 args 的 span。
   * 用 toolCallId 全局索引，persist 仍能拿到带 tool.args 的 pending span。
   */
  const pendingToolSpanByCallId = new Map();

  function purgePendingToolEverywhere(toolCallId, toolName) {
    if (toolCallId) pendingToolSpanByCallId.delete(toolCallId);
    for (const st of runStateByRunId.values()) {
      if (toolCallId) st.pendingToolByCallId.delete(toolCallId);
      if (toolName) st.pendingToolByName.delete(toolName);
    }
  }
  /** 同 sessionKey 下最近一次「文件会话 UUID + trace UUID」，修补 tool_result_persist 等 hook 丢字段 */
  const lastSessionIdBySessionKey = new Map();
  const lastTraceBySessionKey = new Map();
  const rootSpanIdByTraceAndSession = new Map();

  /**
   * 最近一次 llm_input 的上下文，供 fs 拦截 skills.load 时对齐 session/run/trace 与 session.turn 父节点
   * @type {{ sessionKey: string|null, sessionId: string|null, runId: string|null, traceId: string|null, agentId: string|null, workspaceDir: string|null, trigger: string|null, channelId: string|null, rootSpanId: string|null } | null}
   */
  let lastLlmAnchor = null;

  function baseMeta(hookName, ctx, event) {
    let sessionId = pickSessionId(ctx, event);
    let runId = pickRunId(ctx, event);
    const sessionKey =
      ctx?.sessionKey ||
      event?.sessionKey ||
      ctx?.childSessionKey ||
      event?.childSessionKey ||
      event?.targetSessionKey ||
      null;
    const requesterSk = ctx?.requesterSessionKey || event?.requesterSessionKey || null;

    if (sessionKey && !isUuidString(sessionId)) {
      const sid = lastSessionIdBySessionKey.get(sessionKey);
      if (sid) sessionId = sid;
    }
    if ((!sessionId || !isUuidString(sessionId)) && requesterSk) {
      const sid = lastSessionIdBySessionKey.get(requesterSk);
      if (sid) sessionId = sid;
    }

    const runIdLooksBad =
      runId == null ||
      runId === '' ||
      runId === 'unknown' ||
      runId === sessionKey ||
      (typeof runId === 'string' && (runId.startsWith('agent:') || runId.startsWith('announce:')));
    if (sessionKey && runIdLooksBad) {
      const lt = lastTraceBySessionKey.get(sessionKey);
      if (isUuidString(lt)) runId = lt;
    }
    if (runIdLooksBad && requesterSk) {
      const lt = lastTraceBySessionKey.get(requesterSk);
      if (isUuidString(lt)) runId = lt;
    }

    const link = resolveSubagentParentLink(ctx, event);
    let traceId = link?.traceId || runId;

    // subagent_*：OpenClaw 常把 ctx.runId 设为子 run；span 应挂在发起方当前 trace（与主会话该轮 llm 同 traceId）
    if (String(hookName || '').startsWith('subagent_')) {
      const req = requesterSk || sessionKey;
      const pt = req ? lastTraceBySessionKey.get(req) : null;
      if (isUuidString(pt)) traceId = pt;
    }

    const meta = {
      hook: hookName,
      timestamp: new Date().toISOString(),
      agentId: ctx?.agentId || event?.agentId || null,
      sessionKey,
      sessionId,
      runId,
      traceId,
      workspaceDir: ctx?.workspaceDir || null,
      trigger: ctx?.trigger || null,
      channelId: ctx?.channelId || null
    };

    if (sessionKey && isUuidString(sessionId) && isUuidString(traceId)) {
      lastSessionIdBySessionKey.set(sessionKey, sessionId);
      lastTraceBySessionKey.set(sessionKey, traceId);
    }
    if (requesterSk && isUuidString(sessionId) && isUuidString(traceId)) {
      lastSessionIdBySessionKey.set(requesterSk, sessionId);
      lastTraceBySessionKey.set(requesterSk, traceId);
    }

    return meta;
  }

  function rememberRootSpan(meta, spanId) {
    if (!meta?.traceId || !spanId) return;
    rootSpanIdByTraceAndSession.set(traceSessionRootKey(meta.traceId, meta.sessionId || '', meta.sessionKey || ''), spanId);
    if (meta.sessionKey) {
      rootSpanIdByTraceAndSession.set(traceSessionRootKey(meta.traceId, '', meta.sessionKey), spanId);
    }
  }

  function resolveKnownRootSpanId(meta) {
    if (!meta?.traceId) return null;
    const keys = [
      traceSessionRootKey(meta.traceId, meta.sessionId || '', meta.sessionKey || ''),
      meta.sessionKey ? traceSessionRootKey(meta.traceId, '', meta.sessionKey) : null
    ].filter(Boolean);
    for (const key of keys) {
      if (rootSpanIdByTraceAndSession.has(key)) return rootSpanIdByTraceAndSession.get(key);
    }
    return null;
  }

  function buildSubagentParentMeta(hookName, ctx, event) {
    const meta = baseMeta(hookName, ctx, event);
    const requesterSessionKey = ctx?.requesterSessionKey || event?.requesterSessionKey || lastLlmAnchor?.sessionKey || null;
    const parentSessionKey =
      requesterSessionKey ||
      (meta.sessionKey && !String(meta.sessionKey).includes(':subagent:') ? meta.sessionKey : null) ||
      lastLlmAnchor?.sessionKey ||
      null;
    const parentSessionId =
      (parentSessionKey ? lastSessionIdBySessionKey.get(parentSessionKey) || null : null) ||
      (meta.sessionKey === parentSessionKey && isUuidString(meta.sessionId) ? meta.sessionId : null) ||
      lastLlmAnchor?.sessionId ||
      meta.sessionId ||
      null;
    const parentTraceId =
      (parentSessionKey ? lastTraceBySessionKey.get(parentSessionKey) || null : null) ||
      lastLlmAnchor?.traceId ||
      meta.traceId ||
      null;
    return {
      ...meta,
      sessionKey: parentSessionKey || meta.sessionKey,
      sessionId: parentSessionId,
      traceId: parentTraceId
    };
  }

  function getRunState(meta) {
    const key = meta.runId || meta.sessionId || meta.sessionKey || 'unknown';
    if (!runStateByRunId.has(key)) {
      runStateByRunId.set(key, {
        runId: key,
        rootSpanId: null,
        rootSpan: null,
        // 按 callId 暂存：一个 callId 可能会多次出现（push 到队列）
        pendingLlmByCallId: new Map(),
        // 无 callId：用队列按出现顺序匹配后续 llm_output
        pendingLlmNoCallId: [],
        pendingToolByCallId: new Map(),
        pendingToolByName: new Map(),
        // subagent：只落一个 span，直到 subagent_ended 才 append
        pendingSubagentByChildSessionId: new Map(),
        pendingSubagentNoSession: [],
        hasSessionSummary: false
      });
    }
    return runStateByRunId.get(key);
  }

  function createSpan(meta, hookName, extra = {}) {
    return {
      schemaVersion: AUDIT_SPAN_SCHEMA_VERSION,
      traceId: extra.traceId || meta.traceId || meta.runId,
      spanId: genSpanId(),
      parentSpanId: extra.parentSpanId || null,
      name: hookName,
      kind: 'INTERNAL',
      startTime: meta.timestamp,
      endTime: meta.timestamp,
      status: { code: extra.statusCode || 'OK', message: extra.statusMessage || '' },
      attributes: {
        'span.type': extra.type || 'internal',
        'session.id': meta.sessionId,
        'session.key': meta.sessionKey,
        'agent.id': meta.agentId,
        'workspace.dir': meta.workspaceDir,
        'trigger': meta.trigger,
        'channel.id': meta.channelId,
        'run.id': meta.runId,
        'audit.schema_version': AUDIT_SPAN_SCHEMA_VERSION,
        'hook.name': hookName,
        ...(extra.attributes || {})
      },
      events: extra.events || []
    };
  }

  function ensureRootSpan(meta, state, ctx, event) {
    if (state.rootSpanId) return state.rootSpanId;
    const link = resolveSubagentParentLink(ctx, event);
    const root = createSpan(meta, 'session.turn', {
      type: 'session',
      parentSpanId: link?.parentSpanId || null,
      events: [{ time: meta.timestamp, name: 'session.turn.start' }]
    });
    state.rootSpanId = root.spanId;
    state.rootSpan = root;
    // 立即落盘：OpenClaw 往往长期不触发 session_end，若只写 llm/tool 会导致 parentSpanId 指向不存在的根节点
    appendSpan(root);
    rememberRootSpan(meta, root.spanId);
    return root.spanId;
  }

  function writeEventRecord(type, meta, event, extra = {}, options = {}) {
    const record = {
      type,
      ...meta,
      ...extra
    };
    if (options.eventSummary) {
      record.eventSummary = options.eventSummary;
    } else if (event !== undefined) {
      record.eventSummary = summarizeEvent(event);
    }
    if (options.artifact) {
      record.artifact = options.artifact;
    } else if (options.artifactPayload !== undefined) {
      record.artifact = persistArtifact(options.artifactKind || type, meta, options.artifactPayload, {
        label: options.artifactLabel || type,
        previewLength: options.previewLength || 240
      });
    }
    if (options.includeEvent !== false) record.event = event;
    appendEvent(record);
  }

  function flushPendingLlms(state, parentSpanId) {
    for (const queue of state.pendingLlmByCallId.values()) {
      for (const span of queue || []) {
        if (!span.parentSpanId) span.parentSpanId = parentSpanId || null;
        appendSpan(span);
      }
    }
    for (const span of state.pendingLlmNoCallId) {
      if (!span.parentSpanId) span.parentSpanId = parentSpanId || null;
      appendSpan(span);
    }
    state.pendingLlmByCallId.clear();
    state.pendingLlmNoCallId.length = 0;
  }

  function flushPendingTools(state, parentSpanId) {
    const seen = new Set();
    for (const span of state.pendingToolByCallId.values()) {
      if (!span || !span.spanId) continue;
      if (seen.has(span.spanId)) continue;
      seen.add(span.spanId);
      if (!span.parentSpanId) span.parentSpanId = parentSpanId || null;
      const cid = span.attributes && span.attributes['tool.call_id'];
      if (cid) pendingToolSpanByCallId.delete(cid);
      appendSpan(span);
    }
    state.pendingToolByCallId.clear();
    for (const span of state.pendingToolByName.values()) {
      if (!span || !span.spanId) continue;
      if (seen.has(span.spanId)) continue;
      seen.add(span.spanId);
      if (!span.parentSpanId) span.parentSpanId = parentSpanId || null;
      const cid = span.attributes && span.attributes['tool.call_id'];
      if (cid) pendingToolSpanByCallId.delete(cid);
      appendSpan(span);
    }
    state.pendingToolByName.clear();
  }

  function peekPendingTool(state, toolCallId, toolName) {
    if (toolCallId && pendingToolSpanByCallId.has(toolCallId)) return pendingToolSpanByCallId.get(toolCallId);
    if (toolCallId && state.pendingToolByCallId.has(toolCallId)) return state.pendingToolByCallId.get(toolCallId);
    if (toolName && state.pendingToolByName.has(toolName)) return state.pendingToolByName.get(toolName);
    return null;
  }

  function consumePendingTool(state, toolCallId, toolName) {
    if (toolCallId && pendingToolSpanByCallId.has(toolCallId)) {
      const span = pendingToolSpanByCallId.get(toolCallId);
      purgePendingToolEverywhere(toolCallId, toolName);
      return span;
    }
    if (toolCallId && state.pendingToolByCallId.has(toolCallId)) {
      const span = state.pendingToolByCallId.get(toolCallId);
      state.pendingToolByCallId.delete(toolCallId);
      if (toolName) state.pendingToolByName.delete(toolName);
      pendingToolSpanByCallId.delete(toolCallId);
      return span;
    }
    if (toolName && state.pendingToolByName.has(toolName)) {
      const span = state.pendingToolByName.get(toolName);
      state.pendingToolByName.delete(toolName);
      const cid = span && span.attributes && span.attributes['tool.call_id'];
      if (cid) {
        pendingToolSpanByCallId.delete(cid);
        state.pendingToolByCallId.delete(cid);
      }
      return span;
    }
    return null;
  }

  api.on('before_model_resolve', (event, ctx) => writeEventRecord('before_model_resolve', baseMeta('before_model_resolve', ctx, event), event));
  api.on('before_prompt_build', (event, ctx) => writeEventRecord('before_prompt_build', baseMeta('before_prompt_build', ctx, event), event));
  api.on('before_agent_start', (event, ctx) => writeEventRecord('before_agent_start', baseMeta('before_agent_start', ctx, event), event));

  api.on('session_start', (event, ctx) => {
    const meta = baseMeta('session_start', ctx, event);
    ensureRootSpan(meta, getRunState(meta), ctx, event);
    writeEventRecord('session_start', meta, event);
  });

  api.on('session_end', (event, ctx) => {
    const meta = baseMeta('session_end', ctx, event);
    const state = getRunState(meta);
    const rootSpanId = ensureRootSpan(meta, state, ctx, event);
    flushPendingLlms(state, rootSpanId);
    flushPendingTools(state, rootSpanId);
    appendSpan(createSpan(meta, 'session.turn.end', {
      type: 'session',
      parentSpanId: rootSpanId,
      statusCode: event?.error ? 'ERROR' : 'OK',
      statusMessage: event?.error ? String(event.error) : '',
      attributes: { 'session.error': event?.error || null },
      events: [{ time: meta.timestamp, name: 'session_end' }]
    }));
    // 统一：session.turn 直到 session_end 才 append，并补齐 endTime/status
    if (state.rootSpan) {
      state.rootSpan.endTime = meta.timestamp;
      state.rootSpan.status = { code: event?.error ? 'ERROR' : 'OK', message: event?.error ? String(event.error) : '' };
      appendSpan(state.rootSpan);
      state.rootSpan = null;
    }
    writeEventRecord('session_end', meta, event);
  });

  api.on('llm_input', (event, ctx) => {
    const meta = baseMeta('llm_input', ctx, event);
    const state = getRunState(meta);
    const rootSpanId = ensureRootSpan(meta, state, ctx, event);
    const callId = event?.callId || null;
    const logicalRequest = {
      provider: event?.provider,
      model: event?.model,
      systemPrompt: event?.systemPrompt,
      prompt: event?.prompt,
      historyMessages: event?.historyMessages,
      imagesCount: event?.imagesCount
    };
    const llmInputArtifact = persistArtifact('llm-input', meta, logicalRequest, {
      label: callId || 'llm-input',
      previewLength: 300
    });
    writeEventRecord('llm_input', meta, event, {
      callId,
      provider: event?.provider,
      model: event?.model,
      historyMessagesCount: Array.isArray(event?.historyMessages) ? event.historyMessages.length : 0,
      imagesCount: event?.imagesCount || 0,
      inputArtifactPath: llmInputArtifact.path
    }, {
      includeEvent: false,
      artifact: llmInputArtifact
    });
    const invSrc = classifyLlmInvocationSource(ctx, event, meta);
    const promptSkillNames = extractAvailableSkillNamesFromSystemPrompt(event?.systemPrompt || '');
    const span = createSpan(meta, 'llm.call', {
      type: 'model_call',
      parentSpanId: rootSpanId,
      attributes: {
        'llm.provider': event?.provider,
        'llm.model': event?.model,
        'llm.call_id': callId,
        'llm.system_prompt_preview': previewText(event?.systemPrompt, 500),
        'llm.user_prompt_preview': previewText(event?.prompt, 500),
        'llm.history_messages_count': Array.isArray(event?.historyMessages) ? event.historyMessages.length : 0,
        'llm.images_count': event?.imagesCount || 0,
        'llm.invocation_source': invSrc,
        'skills.prompt.count': promptSkillNames.length,
        ...artifactAttributes('llm.input', llmInputArtifact),
        ...(promptSkillNames.length ? { 'skills.prompt.names': promptSkillNames } : {})
      },
      events: [{ time: meta.timestamp, name: 'llm_input' }]
    });
    lastLlmAnchor = {
      sessionKey: meta.sessionKey || null,
      sessionId: meta.sessionId || null,
      runId: meta.runId || null,
      traceId: meta.traceId || meta.runId || null,
      agentId: meta.agentId || null,
      workspaceDir: meta.workspaceDir || null,
      trigger: meta.trigger || null,
      channelId: meta.channelId || null,
      rootSpanId
    };
    if (!state.hasSessionSummary && event?.prompt) {
      span.attributes['session.summary'] = String(event.prompt).slice(0, 500);
      state.hasSessionSummary = true;
    }
    if (callId) {
      if (!state.pendingLlmByCallId.has(callId)) state.pendingLlmByCallId.set(callId, []);
      state.pendingLlmByCallId.get(callId).push(span);
    } else {
      // 无 callId：不落盘，等待 llm_output 再 append
      state.pendingLlmNoCallId.push(span);
    }
  });

  api.on('llm_output', (event, ctx) => {
    const meta = baseMeta('llm_output', ctx, event);
    const state = getRunState(meta);
    const rootSpanId = ensureRootSpan(meta, state, ctx, event);
    const callId = event?.callId || null;
    const usage = event?.usage || {};
    const resolvedOutput = pickLlmOutputFromEvent(event) || toJsonText(event?.output);
    const llmOutputArtifact = persistArtifact('llm-output', meta, {
      provider: event?.provider,
      model: event?.model,
      callId,
      usage,
      output: resolvedOutput,
      assistantTexts: event?.assistantTexts,
      lastAssistant: event?.lastAssistant
    }, {
      label: callId || 'llm-output',
      previewLength: 300
    });
    writeEventRecord('llm_output', meta, event, {
      callId,
      provider: event?.provider,
      model: event?.model,
      usage,
      outputPreview: previewText(resolvedOutput, 240),
      outputArtifactPath: llmOutputArtifact.path
    }, {
      includeEvent: false,
      artifact: llmOutputArtifact
    });
    let span = null;
    if (callId) {
      const queue = state.pendingLlmByCallId.get(callId);
      if (Array.isArray(queue) && queue.length) span = queue.shift();
      if (queue && queue.length === 0) state.pendingLlmByCallId.delete(callId);
    } else {
      span = state.pendingLlmNoCallId.shift() || null;
    }
    span =
      span ||
      createSpan(meta, 'llm.call', {
        type: 'model_call',
        parentSpanId: rootSpanId,
        attributes: { 'llm.invocation_source': classifyLlmInvocationSource(ctx, event, meta) },
        events: []
      });
    span.endTime = meta.timestamp;
    if (!span.attributes['llm.invocation_source']) {
      span.attributes['llm.invocation_source'] = classifyLlmInvocationSource(ctx, event, meta);
    }
    span.attributes['llm.provider'] = event?.provider || span.attributes['llm.provider'];
    span.attributes['llm.model'] = event?.model || span.attributes['llm.model'];
    span.attributes['llm.output_preview'] = previewText(resolvedOutput, 500);
    Object.assign(span.attributes, artifactAttributes('llm.output', llmOutputArtifact));
    if (isLlmOutputEmpty(resolvedOutput)) {
      const { keys, preview } = buildLlmOutputDebugPreview(event);
      span.attributes['llm.debug.empty_output'] = true;
      span.attributes['llm.debug.event_keys'] = keys.join(',');
      span.attributes['llm.debug.event_preview'] = preview;
    }
    span.attributes['llm.usage.input_tokens'] = usage.input ?? usage.prompt_tokens ?? null;
    span.attributes['llm.usage.output_tokens'] = usage.output ?? usage.completion_tokens ?? null;
    span.attributes['llm.usage.cache_read_tokens'] = usage.cacheRead ?? usage.cache_read ?? null;
    span.attributes['llm.usage.cache_write_tokens'] = usage.cacheWrite ?? usage.cache_write ?? null;
    span.attributes['llm.usage.total_tokens'] = usage.totalTokens ?? usage.total_tokens ?? null;
    span.attributes['llm.usage.cost_total'] = usage?.cost?.total ?? null;
    span.events = [...(span.events || []), { time: meta.timestamp, name: 'llm_output' }];
    appendSpan(span);
    if (lastLlmAnchor && lastLlmAnchor.traceId === (meta.traceId || meta.runId)) {
      lastLlmAnchor = null;
    }
  });

  api.on('before_tool_call', (event, ctx) => {
    const meta = baseMeta('before_tool_call', ctx, event);
    const state = getRunState(meta);
    const rootSpanId = ensureRootSpan(meta, state, ctx, event);
    const toolCallId = event?.toolCallId || null;
    const toolName = resolveToolName(event);
    const toolArgsArtifact = persistArtifact('tool-input', meta, {
      toolName,
      toolCallId,
      params: event?.params
    }, {
      label: toolCallId || toolName || 'tool-input',
      previewLength: 240
    });
    writeEventRecord('before_tool_call', meta, event, {
      toolName: toolName || null,
      toolCallId,
      inputArtifactPath: toolArgsArtifact.path
    }, {
      includeEvent: false,
      artifact: toolArgsArtifact
    });
    const span = createSpan(meta, 'tool.call', {
      type: 'tool_call',
      parentSpanId: rootSpanId,
      attributes: {
        'tool.name': toolName || null,
        'tool.call_id': toolCallId,
        'tool.args_preview': previewText(event?.params ?? null, 300),
        ...artifactAttributes('tool.input', toolArgsArtifact)
      },
      events: [{ time: meta.timestamp, name: 'tool_before_call' }]
    });
    const skillReadPath = extractSkillReadIntent(toolName, event?.params);
    if (skillReadPath) {
      span.attributes['skill.read.candidate_path'] = skillReadPath;
      span.attributes['skill.read.candidate_name'] = path.basename(path.dirname(skillReadPath));
      span.attributes['skill.read.candidate_source'] = classifySkillSource(skillReadPath, meta.workspaceDir || null);
    }

    if (toolCallId) {
      state.pendingToolByCallId.set(toolCallId, span);
      pendingToolSpanByCallId.set(toolCallId, span);
    }
    if (toolName) state.pendingToolByName.set(toolName, span);
  });

  api.on('after_tool_call', (event, ctx) => {
    const meta = baseMeta('after_tool_call', ctx, event);
    const state = getRunState(meta);
    const rootSpanId = ensureRootSpan(meta, state, ctx, event);
    const toolCallId = event?.toolCallId || null;
    const existingSpan = peekPendingTool(state, toolCallId, event?.toolName ? String(event.toolName) : '');
    const toolName = resolveToolName(event, existingSpan);
    const toolResultArtifact = persistArtifact('tool-output', meta, {
      toolName,
      toolCallId,
      result: event?.result,
      error: event?.error,
      durationMs: event?.durationMs
    }, {
      label: toolCallId || toolName || 'tool-output',
      previewLength: 240
    });
    writeEventRecord('after_tool_call', meta, event, {
      toolName: toolName || null,
      toolCallId,
      error: event?.error,
      durationMs: event?.durationMs,
      outputArtifactPath: toolResultArtifact.path
    }, {
      includeEvent: false,
      artifact: toolResultArtifact
    });
    const span =
      existingSpan ||
      createSpan(meta, 'tool.call', {
        type: 'tool_call',
        parentSpanId: rootSpanId,
        attributes: { 'tool.name': toolName || null, 'tool.call_id': toolCallId, 'tool.args_preview': '' },
        events: []
      });

    // after_tool_call 只更新状态，不 append；等 tool_result_persist 最终落盘。
    if (!peekPendingTool(state, toolCallId, toolName)) {
      if (toolCallId) {
        state.pendingToolByCallId.set(toolCallId, span);
        pendingToolSpanByCallId.set(toolCallId, span);
      }
      if (toolName) state.pendingToolByName.set(toolName, span);
    }
    span.endTime = meta.timestamp;
    span.status = { code: event?.error ? 'ERROR' : 'OK', message: event?.error ? String(event.error) : '' };
    if (toolName && !span.attributes['tool.name']) span.attributes['tool.name'] = toolName;
    if (event?.result !== undefined) span.attributes['tool.result_preview'] = previewText(event?.result ?? null, 400);
    Object.assign(span.attributes, artifactAttributes('tool.output', toolResultArtifact));
    span.attributes['tool.error'] = event?.error || null;
    span.attributes['tool.duration_ms'] = event?.durationMs ?? null;
    span.events = [...(span.events || []), { time: meta.timestamp, name: 'tool_after_call' }];
  });

  api.on('tool_result_persist', (event, ctx) => {
    const meta = baseMeta('tool_result_persist', ctx, event);
    const state = getRunState(meta);
    const rootSpanId = ensureRootSpan(meta, state, ctx, event);
    const toolCallId = event?.toolCallId || null;
    const existingSpan = peekPendingTool(state, toolCallId, event?.toolName ? String(event.toolName) : '');
    const toolName = resolveToolName(event, existingSpan);
    const persistedResultText = extractToolResultTextFromAgentMessage(event?.message);
    const persistedArtifact = persistArtifact('tool-persisted', meta, {
      toolName,
      toolCallId,
      message: event?.message,
      persistedText: persistedResultText
    }, {
      label: toolCallId || toolName || 'tool-persisted',
      previewLength: 240
    });
    writeEventRecord('tool_result_persist', meta, event, {
      toolName: toolName || null,
      toolCallId,
      persistedArtifactPath: persistedArtifact.path
    }, {
      includeEvent: false,
      artifact: persistedArtifact
    });
    const span =
      consumePendingTool(state, toolCallId, toolName) ||
      createSpan(meta, 'tool.call', {
        type: 'tool_call',
        parentSpanId: rootSpanId,
        attributes: { 'tool.name': toolName || null, 'tool.call_id': toolCallId, 'tool.args_preview': '' },
        events: []
      });

    span.endTime = meta.timestamp;
    if (toolName && !span.attributes['tool.name']) span.attributes['tool.name'] = toolName;
    span.attributes['tool.result_preview'] = previewText(persistedResultText, 400);
    Object.assign(span.attributes, artifactAttributes('tool.persisted', persistedArtifact));
    const msg = event?.message;
    span.attributes['tool.error'] = msg?.isError ? msg?.isError : null;
    span.status = { code: msg?.isError ? 'ERROR' : 'OK', message: '' };
    span.events = [...(span.events || []), { time: meta.timestamp, name: 'tool_result_persist' }];
    appendSpan(span);

    const subagentSpawn = extractSessionsSpawnContext(span, persistedResultText);
    if (subagentSpawn && !msg?.isError) {
      const pendingKey = subagentSpawn.childSessionKey || subagentSpawn.childSessionId || null;
      let subagentSpan = pendingKey ? state.pendingSubagentByChildSessionId.get(pendingKey) : null;
      if (!subagentSpan) {
        subagentSpan = createSpan(meta, 'subagent.call', {
          type: 'subagent_call',
          // subagent.call is a semantic child of the sessions_spawn tool call,
          // just like skill.read is a child of the read tool call.
          parentSpanId: span.spanId,
          statusCode: 'OK',
          attributes: {
            'subagent.id': subagentSpawn.agentId,
            'subagent.task': subagentSpawn.task || subagentSpawn.label || '',
            'subagent.label': subagentSpawn.label || '',
            'subagent.mode': subagentSpawn.mode,
            'subagent.session_id': subagentSpawn.childSessionId,
            'subagent.session_key': subagentSpawn.childSessionKey,
            'subagent.run_id': subagentSpawn.childRunId,
            'subagent.status': 'accepted',
            'subagent.source': 'sessions_spawn',
            'subagent.tool_call_id': subagentSpawn.toolCallId
          },
          events: [{ time: meta.timestamp, name: 'subagent_spawn_accepted' }]
        });
        if (pendingKey) state.pendingSubagentByChildSessionId.set(pendingKey, subagentSpan);
      } else {
        subagentSpan.attributes['subagent.id'] = subagentSpawn.agentId || subagentSpan.attributes['subagent.id'];
        subagentSpan.attributes['subagent.task'] = subagentSpawn.task || subagentSpan.attributes['subagent.task'];
        subagentSpan.attributes['subagent.label'] = subagentSpawn.label || subagentSpan.attributes['subagent.label'];
        subagentSpan.attributes['subagent.mode'] = subagentSpawn.mode || subagentSpan.attributes['subagent.mode'];
        subagentSpan.attributes['subagent.session_id'] = subagentSpawn.childSessionId || subagentSpan.attributes['subagent.session_id'];
        subagentSpan.attributes['subagent.session_key'] = subagentSpawn.childSessionKey || subagentSpan.attributes['subagent.session_key'];
        subagentSpan.attributes['subagent.run_id'] = subagentSpawn.childRunId || subagentSpan.attributes['subagent.run_id'];
        subagentSpan.attributes['subagent.status'] = subagentSpan.attributes['subagent.status'] || 'accepted';
        subagentSpan.attributes['subagent.source'] = subagentSpan.attributes['subagent.source'] || 'sessions_spawn';
        subagentSpan.attributes['subagent.tool_call_id'] = subagentSpawn.toolCallId || subagentSpan.attributes['subagent.tool_call_id'];
        subagentSpan.events = [...(subagentSpan.events || []), { time: meta.timestamp, name: 'subagent_spawn_accepted' }];
        subagentSpan.endTime = meta.timestamp;
      }
      appendSpan(subagentSpan);
      if (pendingKey) {
        registerSubagentParentLinks(pendingKey, {
          parentSpanId: subagentSpan.spanId,
          traceId: meta.traceId || meta.runId
        });
      }
      writeEventRecord('subagent_call', meta, null, {
        toolCallId: subagentSpawn.toolCallId,
        childSessionKey: subagentSpawn.childSessionKey,
        childSessionId: subagentSpawn.childSessionId,
        childRunId: subagentSpawn.childRunId,
        agentId: subagentSpawn.agentId,
        task: subagentSpawn.task || subagentSpawn.label || '',
        mode: subagentSpawn.mode,
        source: 'sessions_spawn',
        status: 'accepted'
      }, {
        includeEvent: false
      });
    }

    const skillReadPath = span.attributes?.['skill.read.candidate_path'];
    if (skillReadPath) {
      const skillName = path.basename(path.dirname(skillReadPath));
      const skillFileInfo = inspectFile(skillReadPath, originalReadFileSync.bind(fs));
      const resolvedSkillPath = skillFileInfo.resolvedPath || resolveObservedPath(skillReadPath);
      const skillReadArtifact = persistArtifact('skill-read', meta, {
        skillName,
        filePath: skillReadPath,
        resolvedFilePath: resolvedSkillPath,
        source: classifySkillSource(skillReadPath, meta.workspaceDir || null),
        toolName,
        toolCallId,
        status: span.status?.code || 'OK',
        fileInfo: skillFileInfo
      }, {
        label: skillName || toolCallId || 'skill-read',
        previewLength: 240
      });
      const skillReadSpan = createSpan(meta, 'skill.read', {
        type: 'skills',
        parentSpanId: span.spanId,
        statusCode: span.status?.code || 'OK',
        statusMessage: span.status?.message || '',
        attributes: {
          'skill.name': skillName,
          'skill.path': skillReadPath,
          'skill.resolved_path': resolvedSkillPath,
          'skill.source': classifySkillSource(skillReadPath, meta.workspaceDir || null),
          'skill.read.via_tool': span.attributes?.['tool.name'] || toolName,
          'skill.read.tool_call_id': span.attributes?.['tool.call_id'] || toolCallId,
          'skill.read.file_sha1': skillFileInfo.sha1,
          'skill.read.file_bytes': skillFileInfo.bytes,
          'skill.read.preview': skillFileInfo.preview,
          ...artifactAttributes('skill.read', skillReadArtifact)
        },
        events: [{ time: meta.timestamp, name: 'skill.read' }]
      });
      skillReadSpan.endTime = meta.timestamp;
      appendSpan(skillReadSpan);
      writeEventRecord('skill_read', meta, null, {
        skillName,
        filePath: skillReadPath,
        source: classifySkillSource(skillReadPath, meta.workspaceDir || null),
        toolName: span.attributes?.['tool.name'] || toolName,
        toolCallId: span.attributes?.['tool.call_id'] || toolCallId,
        status: span.status?.code || 'OK'
      }, {
        includeEvent: false,
        artifact: skillReadArtifact
      });
    }
  });

  api.on('subagent_spawning', (event, ctx) => {
    const meta = buildSubagentParentMeta('subagent_spawning', ctx, event);
    const state = getRunState({ ...meta, runId: event?.runId || meta.runId });
    const rootSpanId = resolveKnownRootSpanId(meta) || lastLlmAnchor?.rootSpanId || null;
    const { childSessionKey, childSessionId, pendingKey } = extractSubagentChildSessionRef(ctx, event);
    const span = createSpan(meta, 'subagent.call', {
      type: 'subagent_call',
      parentSpanId: rootSpanId,
      attributes: {
        'subagent.id': event?.agentId || event?.subAgentId || null,
        'subagent.task': event?.task || event?.label || '',
        'subagent.session_id': childSessionId,
        'subagent.session_key': childSessionKey
      },
      events: [{ time: meta.timestamp, name: 'subagent_spawning' }]
    });
    if (pendingKey) state.pendingSubagentByChildSessionId.set(pendingKey, span);
    else state.pendingSubagentNoSession.push(span);
    if (childSessionKey || childSessionId) {
      registerSubagentParentLinks(childSessionKey || childSessionId, {
        parentSpanId: span.spanId,
        traceId: meta.traceId || meta.runId
      });
    }
    writeEventRecord('subagent_spawning', meta, event);
  });

  api.on('subagent_spawned', (event, ctx) => {
    const meta = buildSubagentParentMeta('subagent_spawned', ctx, event);
    const state = getRunState({ ...meta, runId: event?.runId || meta.runId });
    const rootSpanId = resolveKnownRootSpanId(meta) || lastLlmAnchor?.rootSpanId || null;
    const { childSessionKey, childSessionId, pendingKey } = extractSubagentChildSessionRef(ctx, event);
    const pending = pendingKey ? state.pendingSubagentByChildSessionId.get(pendingKey) : state.pendingSubagentNoSession.shift() || null;
    if (pending) {
      pending.attributes['subagent.id'] = event?.agentId || event?.subAgentId || pending.attributes['subagent.id'];
      pending.attributes['subagent.task'] = event?.task || event?.label || pending.attributes['subagent.task'];
      pending.attributes['subagent.session_id'] = childSessionId || pending.attributes['subagent.session_id'];
      pending.attributes['subagent.session_key'] = childSessionKey || pending.attributes['subagent.session_key'];
      pending.attributes['subagent.status'] = 'spawned';
      pending.events = [...(pending.events || []), { time: meta.timestamp, name: 'subagent_spawned' }];
      if (childSessionKey || childSessionId) {
        registerSubagentParentLinks(childSessionKey || childSessionId, { parentSpanId: pending.spanId, traceId: meta.traceId || meta.runId });
      }
      // 这里不 append，等 subagent_ended 统一 append
    } else {
      // 缺少 spawning：降级创建一个 pending span，等 ended 再落盘
      const span = createSpan(meta, 'subagent.call', {
        type: 'subagent_call',
        parentSpanId: rootSpanId,
        attributes: {
          'subagent.id': event?.agentId || event?.subAgentId || null,
          'subagent.task': event?.task || event?.label || '',
          'subagent.session_id': childSessionId,
          'subagent.session_key': childSessionKey,
          'subagent.status': 'spawned'
        },
        events: [{ time: meta.timestamp, name: 'subagent_spawned' }]
      });
      if (pendingKey) state.pendingSubagentByChildSessionId.set(pendingKey, span);
      else state.pendingSubagentNoSession.push(span);
      if (childSessionKey || childSessionId) {
        registerSubagentParentLinks(childSessionKey || childSessionId, { parentSpanId: span.spanId, traceId: meta.traceId || meta.runId });
      }
    }
    writeEventRecord('subagent_spawned', meta, event);
  });

  api.on('subagent_ended', (event, ctx) => {
    const meta = buildSubagentParentMeta('subagent_ended', ctx, event);
    const state = getRunState({ ...meta, runId: event?.runId || meta.runId });
    const rootSpanId = resolveKnownRootSpanId(meta) || lastLlmAnchor?.rootSpanId || null;
    const { childSessionKey, childSessionId, pendingKey } = extractSubagentChildSessionRef(ctx, event);
    let span = pendingKey ? state.pendingSubagentByChildSessionId.get(pendingKey) : state.pendingSubagentNoSession.shift() || null;
    if (pendingKey && span) state.pendingSubagentByChildSessionId.delete(pendingKey);
    if (!span) {
      span = createSpan(meta, 'subagent.call', {
        type: 'subagent_call',
        parentSpanId: rootSpanId,
        statusCode: event?.error ? 'ERROR' : 'OK',
        statusMessage: event?.error ? String(event.error) : '',
        attributes: {
          'subagent.id': event?.agentId || event?.subAgentId || null,
          'subagent.task': event?.task || event?.label || '',
          'subagent.session_id': childSessionId,
          'subagent.session_key': childSessionKey
        },
        events: []
      });
    }
    span.endTime = meta.timestamp;
    span.status = { code: event?.error ? 'ERROR' : 'OK', message: event?.error ? String(event.error) : '' };
    span.attributes['subagent.id'] = event?.agentId || event?.subAgentId || span.attributes['subagent.id'];
    span.attributes['subagent.task'] = event?.task || span.attributes['subagent.task'];
    span.attributes['subagent.session_id'] = childSessionId || span.attributes['subagent.session_id'];
    span.attributes['subagent.session_key'] = childSessionKey || span.attributes['subagent.session_key'];
    span.attributes['subagent.status'] = event?.error ? 'error' : 'ended';
    span.attributes['subagent.error'] = event?.error || null;
    span.events = [...(span.events || []), { time: meta.timestamp, name: 'subagent_ended' }];
    appendSpan(span);
    writeEventRecord('subagent_ended', meta, event);
  });



  api.on('message_received', (event, ctx) => {
    const meta = baseMeta('message_received', ctx, event);
    writeEventRecord('message_received', meta, event);
  });
  api.on('message_sending', (event, ctx) => writeEventRecord('message_sending', baseMeta('message_sending', ctx, event), event));
  api.on('message_sent', (event, ctx) => writeEventRecord('message_sent', baseMeta('message_sent', ctx, event), event));
  api.on('before_message_write', (event, ctx) => writeEventRecord('before_message_write', baseMeta('before_message_write', ctx, event), event));
  api.on('gateway_start', (event, ctx) => writeEventRecord('gateway_start', baseMeta('gateway_start', ctx, event), event));
  api.on('gateway_stop', (event, ctx) => writeEventRecord('gateway_stop', baseMeta('gateway_stop', ctx, event), event));

  const originalReadFileSync = fs.readFileSync;
  logger.info('[audit-plugin] skills audit hooks registered (skill.read)');

  logger.info('[audit-plugin] registered audit hooks with standardized span schema (single-span mode)');
};

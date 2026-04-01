const state = {
  data: null,
  viewMode: 'sessions',
  selectedSessionId: null,
  selectedTraceKey: null,
  selectedSpanId: null,
  selectedTab: 'content',
  search: '',
  agent: 'all',
  artifactCache: new Map(),
  isLoading: false,
  autoRefreshTimer: null,
  openDetailKeys: new Set()
};

const AUTO_REFRESH_MS = 5000;

const elements = {
  listTitle: document.getElementById('listTitle'),
  sessionList: document.getElementById('sessionList'),
  traceList: document.getElementById('traceList'),
  detailsBody: document.getElementById('detailsBody'),
  flowEyebrow: document.getElementById('flowEyebrow'),
  traceTitle: document.getElementById('traceTitle'),
  traceMeta: document.getElementById('traceMeta'),
  detailsTitle: document.getElementById('detailsTitle'),
  searchInput: document.getElementById('searchInput'),
  agentFilter: document.getElementById('agentFilter'),
  refreshButton: document.getElementById('refreshButton'),
  tabs: [...document.querySelectorAll('.tab[data-tab]')],
  viewModeButtons: [...document.querySelectorAll('.tab[data-view-mode]')],
  emptyStateTemplate: document.getElementById('emptyStateTemplate')
};

function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function formatTime(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function formatDuration(ms) {
  if (ms == null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`;
  const mins = Math.floor(ms / 60000);
  const secs = Math.round((ms % 60000) / 1000);
  return `${mins}m ${secs}s`;
}

function shortId(value, len = 12) {
  if (!value) return '-';
  const text = String(value);
  return text.length <= len ? text : `${text.slice(0, len)}...`;
}

function detailKey(span, key) {
  return `${span?.spanId || 'span'}::${key}`;
}

function captureOpenDetails() {
  const openKeys = new Set();
  elements.detailsBody
    ?.querySelectorAll('details[data-detail-key][open]')
    ?.forEach((node) => {
      const key = node.getAttribute('data-detail-key');
      if (key) openKeys.add(key);
    });
  state.openDetailKeys = openKeys;
}

function hydrateOpenDetails() {
  const details = elements.detailsBody?.querySelectorAll('details[data-detail-key]') || [];
  details.forEach((node) => {
    const key = node.getAttribute('data-detail-key');
    if (!key) return;
    if (state.openDetailKeys.has(key)) {
      node.setAttribute('open', '');
    } else {
      node.removeAttribute('open');
    }
    node.addEventListener('toggle', () => {
      if (node.open) state.openDetailKeys.add(key);
      else state.openDetailKeys.delete(key);
    });
  });
}

function sessionChainLabel(session) {
  if (!session) return '';
  if (session.resumedFrom) return `续接自 ${shortId(session.resumedFrom, 12)}`;
  if (session.resumedTo) return `已续接到 ${shortId(session.resumedTo, 12)}`;
  return '';
}

function traceRoundLabel(session, index) {
  if (!session) return `第 ${index + 1} 轮`;
  const total = sortedTraces(session).length;
  if (index === 0) return `最近一轮`;
  return `第 ${total - index} 轮`;
}

function cloneEmptyState() {
  return elements.emptyStateTemplate.content.firstElementChild.cloneNode(true);
}

function allSessions() {
  return state.data?.sessions || [];
}

function filteredSessions() {
  const query = state.search.trim().toLowerCase();
  return allSessions().filter((session) => {
    if (state.agent !== 'all' && session.agentId !== state.agent) return false;
    if (!query) return true;
    const haystack = [
      session.agentId,
      session.sessionId,
      session.sessionKey,
      session.workspaceDir,
      ...session.traces.map((trace) => `${trace.traceId} ${trace.traceKey || ''}`)
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

function allApiCalls() {
  return allSessions()
    .flatMap((session) =>
      (session.traces || []).flatMap((trace) =>
        (trace.spans || [])
          .filter((span) => span.name === 'llm.call')
          .map((span) => ({
            sessionId: session.sessionId,
            sessionKey: session.sessionKey,
            sessionAgentId: session.agentId,
            traceKey: trace.traceKey,
            traceId: trace.traceId,
            traceStartTime: trace.startTime,
            traceEndTime: trace.endTime,
            span
          }))
      )
    )
    .sort(
      (a, b) =>
        new Date(b.span.startTime || b.traceStartTime || 0).getTime() -
        new Date(a.span.startTime || a.traceStartTime || 0).getTime()
    );
}

function filteredApiCalls() {
  const query = state.search.trim().toLowerCase();
  return allApiCalls().filter((entry) => {
    const span = entry.span;
    if (state.agent !== 'all' && entry.sessionAgentId !== state.agent) return false;
    if (!query) return true;
    const haystack = [
      entry.sessionAgentId,
      entry.sessionId,
      entry.sessionKey,
      entry.traceId,
      span.spanId,
      span.displayTitle,
      span.attributes?.['llm.provider'],
      span.attributes?.['llm.model'],
      span.attributes?.['llm.input_preview'],
      span.attributes?.['llm.output_preview']
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(query);
  });
}

function aggregateApiOverview(calls) {
  const summary = {
    totalCalls: calls.length,
    failedCalls: 0,
    usageReportedCalls: 0,
    usageUnreportedCalls: 0,
    input: 0,
    output: 0,
    total: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costTotal: 0,
    durationTotal: 0,
    providerModelCounts: new Map()
  };

  for (const entry of calls) {
    const span = entry.span;
    if (span.isFailed) summary.failedCalls += 1;
    summary.durationTotal += span.durationMs || 0;
    const usage = usageFromSpan(span);
    if (usageReported(usage)) {
      summary.usageReportedCalls += 1;
      if (usage.input != null) summary.input += usage.input;
      if (usage.output != null) summary.output += usage.output;
      if (usage.total != null) summary.total += usage.total;
      if (usage.cacheRead != null) summary.cacheRead += usage.cacheRead;
      if (usage.cacheWrite != null) summary.cacheWrite += usage.cacheWrite;
      if (usage.costTotal != null) summary.costTotal += usage.costTotal;
    } else {
      summary.usageUnreportedCalls += 1;
    }
    const providerModel = [span.attributes?.['llm.provider'], span.attributes?.['llm.model']]
      .filter(Boolean)
      .join(' / ');
    if (providerModel) {
      summary.providerModelCounts.set(providerModel, (summary.providerModelCounts.get(providerModel) || 0) + 1);
    }
  }

  summary.avgDurationMs = summary.totalCalls ? Math.round(summary.durationTotal / summary.totalCalls) : 0;
  summary.topModel =
    [...summary.providerModelCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  return summary;
}

function currentSession() {
  return allSessions().find((session) => session.sessionId === state.selectedSessionId) || null;
}

function sortedTraces(session) {
  return [...(session?.traces || [])].sort(
    (a, b) => new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
  );
}

function currentTrace() {
  const session = currentSession();
  if (!session) return null;
  const traces = sortedTraces(session);
  return traces.find((trace) => trace.traceKey === state.selectedTraceKey) || traces[0] || null;
}

function currentApiCall() {
  return (
    filteredApiCalls().find(
      (entry) =>
        entry.sessionId === state.selectedSessionId &&
        entry.traceKey === state.selectedTraceKey &&
        entry.span.spanId === state.selectedSpanId
    ) || null
  );
}

function findSessionByIdentity(sessionId, sessionKey) {
  return allSessions().find((session) => {
    if (sessionId && session.sessionId === sessionId) return true;
    if (sessionKey && session.sessionKey === sessionKey) return true;
    return false;
  }) || null;
}

function currentSpan() {
  const trace = currentTrace();
  if (!trace) return null;
  return trace.spans.find((span) => span.spanId === state.selectedSpanId) || preferredSpan(trace) || null;
}

function preferredSpan(trace) {
  if (!trace) return null;
  return (
    trace.spans.find((span) => span.name === 'llm.call') ||
    trace.spans[0] ||
    null
  );
}

function promptSkills(span) {
  return span?.attributes?.['skills.prompt.names'] || [];
}

function toNumberOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function usageFromSpan(span) {
  const attrs = span?.attributes || {};
  return {
    input: toNumberOrNull(attrs['llm.usage.input_tokens']),
    output: toNumberOrNull(attrs['llm.usage.output_tokens']),
    total: toNumberOrNull(attrs['llm.usage.total_tokens']),
    cacheRead: toNumberOrNull(attrs['llm.usage.cache_read_tokens']),
    cacheWrite: toNumberOrNull(attrs['llm.usage.cache_write_tokens']),
    costTotal: toNumberOrNull(attrs['llm.usage.cost_total'])
  };
}

function usageReported(usage) {
  if (!usage) return false;
  return ['input', 'output', 'total', 'cacheRead', 'cacheWrite', 'costTotal'].some((key) => usage[key] != null);
}

function usageChipsFromUsage(usage) {
  if (!usageReported(usage)) return ['usage 未统计'];
  const chips = [];
  if (usage.input != null) chips.push(`${usage.input} input`);
  if (usage.output != null) chips.push(`${usage.output} output`);
  if (usage.total != null) chips.push(`${usage.total} total`);
  if (usage.cacheRead != null) chips.push(`${usage.cacheRead} cache hit`);
  if (usage.cacheWrite != null) chips.push(`${usage.cacheWrite} cache write`);
  if (usage.costTotal != null) chips.push(`cost ${usage.costTotal}`);
  return chips;
}

function aggregateTraceUsage(trace) {
  const llmSpans = (trace?.spans || []).filter((span) => span.name === 'llm.call');
  const aggregate = {
    input: 0,
    output: 0,
    total: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costTotal: 0,
    reportedCalls: 0,
    unreportedCalls: 0
  };

  for (const span of llmSpans) {
    const usage = usageFromSpan(span);
    if (!usageReported(usage)) {
      aggregate.unreportedCalls += 1;
      continue;
    }
    aggregate.reportedCalls += 1;
    if (usage.input != null) aggregate.input += usage.input;
    if (usage.output != null) aggregate.output += usage.output;
    if (usage.total != null) aggregate.total += usage.total;
    if (usage.cacheRead != null) aggregate.cacheRead += usage.cacheRead;
    if (usage.cacheWrite != null) aggregate.cacheWrite += usage.cacheWrite;
    if (usage.costTotal != null) aggregate.costTotal += usage.costTotal;
  }

  return aggregate;
}

function traceReadSkills(trace) {
  return [
    ...new Set(
      (trace?.spans || [])
        .filter((span) => span.name === 'skill.read')
        .map((span) => span.attributes?.['skill.name'])
        .filter(Boolean)
    )
  ];
}

function sortedTraceSpans(trace) {
  return [...(trace?.spans || [])].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

function buildSkillEvidence(trace) {
  const spans = sortedTraceSpans(trace);
  const visibleNames = new Set(['llm.call', 'tool.call', 'subagent.call']);
  const promptedSet = new Set(tracePromptSkills(trace));
  return spans
    .filter((span) => span.name === 'skill.read')
    .map((readSpan) => {
      const readTime = new Date(readSpan.endTime || readSpan.startTime).getTime();
      const readCallId = readSpan.attributes?.['skill.read.tool_call_id'];
      const followUps = spans
        .filter((candidate) => {
          if (candidate.spanId === readSpan.spanId) return false;
          if (!visibleNames.has(candidate.name)) return false;
          if (candidate.name === 'tool.call') {
            const sameReadTool =
              String(candidate.attributes?.['tool.name'] || '').toLowerCase() === 'read' &&
              candidate.attributes?.['tool.call_id'] === readCallId;
            if (sameReadTool) return false;
          }
          return new Date(candidate.startTime).getTime() > readTime;
        })
        .slice(0, 5);
      return {
        skillName: readSpan.attributes?.['skill.name'] || '-',
        source: readSpan.attributes?.['skill.source'] || '-',
        path: readSpan.attributes?.['skill.path'] || '',
        prompted: promptedSet.has(readSpan.attributes?.['skill.name']),
        readSpan,
        followUps,
        status: followUps.length ? 'follow-up seen' : 'read only'
      };
    });
}

function skillStatusTone(status) {
  if (status === 'follow-up seen') return 'success';
  if (status === 'read only') return 'neutral';
  if (status === 'prompted only') return 'soft';
  if (status === 'catalog only') return 'muted';
  return 'muted';
}

function tracePromptSkills(trace) {
  return [
    ...new Set(
      (trace?.spans || [])
        .filter((span) => span.name === 'llm.call')
        .flatMap((span) => promptSkills(span))
        .filter(Boolean)
    )
  ];
}

function traceSummary(trace) {
  const spans = trace?.spans || [];
  return {
    modelCalls: spans.filter((span) => span.name === 'llm.call').length,
    toolCalls: spans.filter((span) => span.name === 'tool.call').length,
    subagents: spans.filter((span) => span.name === 'subagent.call').length,
    readSkills: traceReadSkills(trace),
    promptSkills: tracePromptSkills(trace),
    usage: aggregateTraceUsage(trace)
  };
}

function buildDepthMap(nodes, depthMap = new Map()) {
  for (const node of nodes || []) {
    depthMap.set(node.spanId, node.depth || 0);
    buildDepthMap(node.children || [], depthMap);
  }
  return depthMap;
}

function orderedVisibleSpans(trace) {
  const depthMap = buildDepthMap(trace?.tree || []);
  return (trace?.spans || [])
    .filter((span) => !['skills.scan', 'skills.catalog_read', 'skills.cataloged'].includes(span.name))
    .sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime())
    .map((span) => ({
      ...span,
      depth: depthMap.get(span.spanId) || 0
    }));
}

function visibleTraceTree(nodes) {
  return (nodes || [])
    .filter((node) => !['skills.scan', 'skills.catalog_read', 'skills.cataloged'].includes(node.name))
    .map((node) => ({
      ...node,
      children: visibleTraceTree(node.children || [])
    }));
}

function collectArtifacts(span) {
  const attrs = span?.attributes || {};
  const entries = [];
  const push = (label, filePath) => {
    if (!filePath) return;
    entries.push({ label, path: filePath });
  };
  push('Model Input', attrs['llm.input.artifact_path']);
  push('Model Output', attrs['llm.output.artifact_path']);
  push('Tool Input', attrs['tool.input.artifact_path']);
  push('Tool Output', attrs['tool.output.artifact_path']);
  push('Tool Persisted', attrs['tool.persisted.artifact_path']);
  push('Skill Read', attrs['skill.read.artifact_path']);
  if (span?.name === 'skill.read' && span?.parentSpanId) {
    const parentTool = currentTrace()?.spans?.find((candidate) => candidate.spanId === span.parentSpanId) || null;
    const parentAttrs = parentTool?.attributes || {};
    push('Read Request', parentAttrs['tool.input.artifact_path']);
    push('Read Content', parentAttrs['tool.output.artifact_path']);
  }
  return entries;
}

function parsePromptSkillEntries(span, artifacts) {
  const names = promptSkills(span);
  const llmInputArtifact = artifacts.find((entry) => entry.label === 'Model Input')?.artifact;
  const systemPrompt =
    llmInputArtifact?.parsed?.systemPrompt ||
    llmInputArtifact?.parsed?.system_prompt ||
    llmInputArtifact?.parsed?.prompt ||
    llmInputArtifact?.content ||
    '';

  const entries = [];
  const seen = new Set();
  const xmlPattern = /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>([\s\S]*?)<\/description>\s*<location>([\s\S]*?)<\/location>\s*<\/skill>/g;
  let match;
  while ((match = xmlPattern.exec(systemPrompt)) !== null) {
    const name = match[1]?.trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    entries.push({
      name,
      description: match[2]?.trim() || '',
      location: match[3]?.trim() || ''
    });
  }

  if (!entries.length) {
    return names.map((name) => ({ name, description: '', location: '' }));
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  return names.map((name) => byName.get(name) || { name, description: '', location: '' });
}

function artifactByLabel(artifacts, label) {
  return artifacts.find((entry) => entry.label === label)?.artifact || null;
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

function prettyValue(value, fallback = '(empty)') {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseProjectContextEntries(systemPrompt) {
  if (!systemPrompt) return [];
  const entries = [];
  const pattern = /^## (\/[^\n]+)\n([\s\S]*?)(?=^## \/[^\n]+\n|\Z)/gm;
  let match;
  while ((match = pattern.exec(systemPrompt)) !== null) {
    const filePath = match[1]?.trim();
    const body = match[2] || '';
    entries.push({
      path: filePath,
      status: body.trim().startsWith('[MISSING]') ? 'missing' : 'loaded',
      preview: body.trim().split('\n').slice(0, 3).join('\n')
    });
  }
  return entries;
}

function extractSystemPromptSection(systemPrompt, heading) {
  if (!systemPrompt) return '';
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^## ${escaped}\\n([\\s\\S]*?)(?=^## [^\\n]+\\n|\\Z)`, 'm');
  const match = systemPrompt.match(pattern);
  return match?.[1]?.trim() || '';
}

function extractAvailableTools(systemPrompt) {
  if (!systemPrompt) return [];
  const toolBlockMatch = systemPrompt.match(/Tool names are case-sensitive\. Call tools exactly as listed\.\n([\s\S]*?)\nTOOLS\.md does not control tool availability;/);
  if (!toolBlockMatch) return [];
  return toolBlockMatch[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => {
      const name = line.slice(2).split(':')[0]?.trim();
      return name || null;
    })
    .filter(Boolean);
}

function parseSafetyBullets(systemPrompt) {
  const section = extractSystemPromptSection(systemPrompt, 'Safety');
  if (!section) return [];
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function parseRuntimeSummary(systemPrompt) {
  const section = extractSystemPromptSection(systemPrompt, 'Runtime');
  if (!section) return [];
  return section
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 4);
}

function classifyHistoryMessage(message) {
  const role = message?.role || 'unknown';
  if (role === 'toolResult') return 'tool_result';
  const items = Array.isArray(message?.content) ? message.content : [message?.content];
  const hasToolCall = items.some((item) => item && typeof item === 'object' && item.type === 'toolCall');
  if (role === 'assistant' && hasToolCall) return 'assistant_tool';
  if (role === 'assistant') return 'assistant';
  if (role === 'user') return 'user';
  return 'system';
}

function summarizeHistoryMessage(message) {
  const role = message?.role || 'unknown';
  const content = message?.content;
  const items = Array.isArray(content) ? content : [content];
  const parts = [];
  let toolCalls = 0;
  let toolResults = 0;

  for (const item of items) {
    if (typeof item === 'string') {
      if (item.trim()) parts.push(item.trim());
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
      parts.push(item.text.trim());
      continue;
    }
    if (item.type === 'toolCall') {
      toolCalls += 1;
      parts.push(`[toolCall] ${item.name || 'tool'}`);
      continue;
    }
  }

  if (role === 'toolResult') {
    toolResults += 1;
    if (message.toolName) parts.push(`[toolResult] ${message.toolName}`);
  }

  return {
    role,
    kind: classifyHistoryMessage(message),
    timestamp: message?.timestamp || null,
    text: parts.join('\n').trim() || message?.errorMessage || '',
    toolCalls,
    toolResults,
    stopReason: message?.stopReason || null,
    provider: message?.provider || null,
    model: message?.model || null,
    toolName: message?.toolName || null,
    errorMessage: message?.errorMessage || null
  };
}

function renderHistoryMessageItem(item) {
  const kindLabel = {
    user: 'user',
    assistant: 'assistant',
    assistant_tool: 'assistant + tool',
    tool_result: 'tool result',
    system: 'system'
  }[item.kind] || item.role;
  const badges = [
    item.toolCalls ? `${item.toolCalls} tool call` : '',
    item.toolResults ? `${item.toolResults} tool result` : '',
    item.toolName || '',
    item.stopReason || '',
    item.errorMessage ? 'error' : ''
  ].filter(Boolean);
  return `
    <article class="history-item history-item-${escapeHtml(item.kind)}">
      <div class="history-item-head">
        <div class="history-item-meta">
          <span class="summary-chip">${escapeHtml(kindLabel)}</span>
          <span class="evidence-time">${escapeHtml(item.timestamp ? formatTime(item.timestamp) : '-')}</span>
        </div>
        ${
          badges.length
            ? `<div class="history-badges">${badges.map((badge) => `<span class="summary-chip summary-chip-soft">${escapeHtml(badge)}</span>`).join('')}</div>`
            : ''
        }
      </div>
      <div class="history-text">${escapeHtml(item.text || '(empty)')}</div>
    </article>
  `;
}

function renderModelInputCard(span, artifacts) {
  if (span.name !== 'llm.call') return '';
  const llmInput = artifactByLabel(artifacts, 'Model Input')?.parsed;
  if (!llmInput) return '';

  const prompt = llmInput.prompt || '';
  const systemPrompt = llmInput.systemPrompt || '';
  const historyMessages = Array.isArray(llmInput.historyMessages) ? llmInput.historyMessages : [];
  const projectEntries = parseProjectContextEntries(systemPrompt);
  const historyItems = historyMessages.map(summarizeHistoryMessage);
  const promptSkills = parsePromptSkillEntries(span, artifacts);

  return `
    <article class="content-card wide-card content-card-model-input">
      <header>
        <h4>Model Input</h4>
        <span class="card-note">structured view</span>
      </header>
      <div class="model-input-layout">
        <section class="model-panel">
          <div class="model-panel-head">
            <strong>Request</strong>
          </div>
          <pre class="structured-pre">${escapeHtml(prompt || '(empty prompt)')}</pre>
        </section>
        ${
          promptSkills.length
            ? `
              <section class="model-panel wide-panel">
                <details class="skill-summary-details" data-detail-key="${escapeHtml(detailKey(span, 'skills-in-prompt'))}">
                  <summary class="model-panel-head">
                    <strong>Skills In Prompt</strong>
                    <div class="overview-tags">
                      <span class="summary-chip">${promptSkills.length} skills</span>
                    </div>
                  </summary>
                  <p class="content-note">这里只展示这次 model call 带进 prompt 的 skill 名称和说明，不代表已经实际读取。</p>
                  <div class="skill-summary-list">
                    ${promptSkills
                      .map(
                        (skill) => `
                          <article class="skill-summary-item">
                            <div class="skill-summary-head">
                              <span class="skill-chip">${escapeHtml(skill.name)}</span>
                            </div>
                            ${
                              skill.description
                                ? `<p class="skill-summary-desc">${escapeHtml(skill.description)}</p>`
                                : '<p class="skill-summary-desc muted">没有解析到 description。</p>'
                            }
                          </article>
                        `
                      )
                      .join('')}
                  </div>
                </details>
              </section>
            `
            : ''
        }
        <section class="model-panel wide-panel">
          <details class="model-diagnostic-details" data-detail-key="${escapeHtml(detailKey(span, 'system-prompt'))}">
            <summary class="model-panel-head">
              <strong>System Prompt</strong>
              <div class="overview-tags">
                <span class="summary-chip">${systemPrompt.length} chars</span>
              </div>
            </summary>
            <pre class="structured-pre">${escapeHtml(systemPrompt || '(empty system prompt)')}</pre>
          </details>
        </section>
        <section class="model-panel wide-panel">
          <details class="project-context-details" data-detail-key="${escapeHtml(detailKey(span, 'project-context'))}">
            <summary class="model-panel-head">
              <strong>Project Context</strong>
              <div class="overview-tags">
                <span class="summary-chip">${projectEntries.filter((entry) => entry.status === 'loaded').length} loaded</span>
                <span class="summary-chip">${projectEntries.filter((entry) => entry.status === 'missing').length} not present</span>
              </div>
            </summary>
            <div class="project-context-list">
              ${
                projectEntries.length
                  ? projectEntries
                      .map(
                        (entry) => `
                          <details class="project-context-item" data-detail-key="${escapeHtml(detailKey(span, `project:${entry.path}`))}">
                            <summary class="project-context-head">
                              <span class="summary-chip summary-chip-${entry.status === 'missing' ? 'muted' : 'success'}">${escapeHtml(entry.status === 'missing' ? 'not present' : 'loaded')}</span>
                              <span class="project-context-path">${escapeHtml(entry.path)}</span>
                            </summary>
                            <pre class="project-context-preview">${escapeHtml(entry.preview || '(empty preview)')}</pre>
                          </details>
                        `
                      )
                      .join('')
                  : '<div class="trace-tree-note">没有解析到 project context 文件。</div>'
              }
            </div>
          </details>
        </section>
        <section class="model-panel wide-panel">
          <details class="model-diagnostic-details" data-detail-key="${escapeHtml(detailKey(span, 'history'))}">
            <summary class="model-panel-head">
              <strong>History</strong>
              <div class="overview-tags">
                <span class="summary-chip">${historyItems.length} messages</span>
              </div>
            </summary>
            <div class="history-list">
              ${
                historyItems.length
                  ? historyItems.map(renderHistoryMessageItem).join('')
                  : '<div class="trace-tree-note">这次模型调用没有携带 historyMessages。</div>'
              }
            </div>
          </details>
        </section>
      </div>
    </article>
  `;
}

function assistantContentText(message) {
  if (!message) return '';
  if (typeof message === 'string') return message;
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text') return part.text || '';
      if (part.type === 'toolCall') {
        return `[toolCall] ${part.name || 'unknown'}`;
      }
      return '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function llmUsageSummary(span) {
  return usageChipsFromUsage(usageFromSpan(span));
}

function renderAssistantStep(text, index, total) {
  return `
    <article class="history-item history-item-assistant">
      <div class="history-item-head">
        <div class="history-item-meta">
          <span class="summary-chip">assistant step</span>
          <span class="evidence-time">${index + 1} / ${total}</span>
        </div>
      </div>
      <div class="history-text">${escapeHtml(text || '(empty)')}</div>
    </article>
  `;
}

function renderModelOutputCard(span, artifacts) {
  if (span.name !== 'llm.call') return '';
  const llmOutput = artifactByLabel(artifacts, 'Model Output')?.parsed;
  if (!llmOutput) return '';

  const assistantTexts = Array.isArray(llmOutput.assistantTexts) ? llmOutput.assistantTexts : [];
  const finalMessage = assistantContentText(llmOutput.lastAssistant) || llmOutput.output || assistantTexts[assistantTexts.length - 1] || '';
  const steps = assistantTexts.length ? assistantTexts : (finalMessage ? [finalMessage] : []);

  return `
    <article class="content-card wide-card content-card-model-output">
      <header>
        <h4>Model Output</h4>
        <span class="card-note">structured view</span>
      </header>
      <div class="model-input-layout">
        <section class="model-panel wide-panel">
          <div class="model-panel-head">
            <strong>Assistant Steps</strong>
          </div>
          <div class="history-list">
            ${
              steps.length
                ? steps.map((text, index) => renderAssistantStep(text, index, steps.length)).join('')
                : '<div class="trace-tree-note">这次没有拆分的 assistant steps。</div>'
            }
          </div>
        </section>
      </div>
    </article>
  `;
}

function renderToolCallCard(span, artifacts) {
  if (span.name !== 'tool.call') return '';
  const attrs = span.attributes || {};
  const toolInput = artifactByLabel(artifacts, 'Tool Input')?.parsed;
  const toolOutput = artifactByLabel(artifacts, 'Tool Output')?.parsed;
  const toolPersisted = artifactByLabel(artifacts, 'Tool Persisted')?.parsed;
  const toolName = attrs['tool.name'] || span.displaySubtitle || '-';
  const inputParams = toolInput?.params ?? parseJsonMaybe(attrs['tool.args_preview']) ?? null;
  const outputResult = toolOutput?.result ?? toolOutput?.output ?? toolOutput?.error ?? null;
  const persistedResult = toolPersisted?.message ?? toolPersisted?.result ?? toolPersisted ?? null;

  return `
    <article class="content-card wide-card">
      <header>
        <h4>Tool Input</h4>
        <span class="card-note">${escapeHtml(toolName)}</span>
      </header>
      <pre class="structured-pre">${escapeHtml(prettyValue(inputParams))}</pre>
    </article>
    <article class="content-card wide-card">
      <header>
        <h4>Tool Output</h4>
      </header>
      <pre class="structured-pre">${escapeHtml(prettyValue(outputResult))}</pre>
      ${
        persistedResult != null
          ? `
            <details class="model-diagnostic-details" data-detail-key="${escapeHtml(detailKey(span, 'tool-persisted'))}">
              <summary class="model-panel-head">
                <strong>Persisted</strong>
              </summary>
              <pre class="structured-pre">${escapeHtml(prettyValue(persistedResult))}</pre>
            </details>
          `
          : ''
      }
    </article>
  `;
}

function latestChildOutput(session) {
  if (!session) return null;
  const traces = sortedTraces(session);
  for (const trace of traces) {
    const llmSpans = [...(trace.spans || [])]
      .filter((item) => item.name === 'llm.call')
      .sort((a, b) => new Date(b.endTime || b.startTime).getTime() - new Date(a.endTime || a.startTime).getTime());
    const latest = llmSpans[0];
    if (!latest) continue;
    const preview = latest.attributes?.['llm.output_preview'] || '';
    if (preview) {
      return {
        text: preview,
        time: latest.endTime || latest.startTime || null,
        source: 'child_session'
      };
    }
  }
  return null;
}

function renderSubagentCallCard(span, artifacts) {
  if (span.name !== 'subagent.call') return '';
  const attrs = span.attributes || {};
  const toolOutput = artifactByLabel(artifacts, 'Tool Output')?.parsed;
  const dispatchKind = attrs['subagent.id'] ? `named subagent / ${attrs['subagent.id']}` : 'derived subagent';
  const task = attrs['subagent.task'] || attrs['subagent.label'] || '';
  const dispatchInput = task || '';
  const dispatchOutput = toolOutput?.result ?? toolOutput?.output ?? null;
  const childSession = findSessionByIdentity(
    attrs['subagent.session_id'] || null,
    attrs['subagent.session_key'] || null
  );
  const childOutcome = latestChildOutput(childSession);
  const outputText = childOutcome?.text || null;
  const outputSource = childOutcome ? 'child session final output' : 'spawn accepted payload';

  return `
    <article class="content-card wide-card">
      <header>
        <h4>Subagent Input</h4>
        <span class="card-note">${escapeHtml(dispatchKind)}</span>
      </header>
      <pre class="structured-pre">${escapeHtml(prettyValue(dispatchInput))}</pre>
    </article>
    <article class="content-card wide-card">
      <header>
        <h4>Subagent Output</h4>
        <span class="card-note">${escapeHtml(outputSource)}</span>
      </header>
      <pre class="structured-pre">${escapeHtml(prettyValue(outputText ?? dispatchOutput, outputText || dispatchOutput ? '(empty)' : '还没有拿到子 agent 的最终返回'))}</pre>
    </article>
  `;
}

async function fetchArtifact(filePath) {
  if (!filePath) return null;
  if (state.artifactCache.has(filePath)) return state.artifactCache.get(filePath);
  const response = await fetch(`/api/artifact?path=${encodeURIComponent(filePath)}`);
  if (!response.ok) throw new Error(`Artifact request failed: ${response.status}`);
  const data = await response.json();
  state.artifactCache.set(filePath, data);
  return data;
}

async function loadArtifacts(span) {
  const entries = collectArtifacts(span);
  const items = [];
  for (const entry of entries) {
    try {
      const artifact = await fetchArtifact(entry.path);
      items.push({ ...entry, artifact });
    } catch (error) {
      items.push({
        ...entry,
        artifact: { path: entry.path, parsed: null, content: '', error: error.message }
      });
    }
  }
  return items;
}

function renderAgentFilter() {
  const source = state.viewMode === 'api'
    ? allApiCalls().map((entry) => entry.sessionAgentId)
    : allSessions().map((session) => session.agentId);
  const agents = ['all', ...new Set(source.filter(Boolean))];
  elements.agentFilter.innerHTML = agents
    .map((agent) => `<option value="${agent}">${agent === 'all' ? '全部 agent' : agent}</option>`)
    .join('');
  elements.agentFilter.value = state.agent;
}

function syncSelection() {
  if (state.viewMode === 'api') {
    const calls = filteredApiCalls();
    if (!calls.length) {
      state.selectedSessionId = null;
      state.selectedTraceKey = null;
      state.selectedSpanId = null;
      return;
    }

    const active =
      calls.find(
        (entry) =>
          entry.sessionId === state.selectedSessionId &&
          entry.traceKey === state.selectedTraceKey &&
          entry.span.spanId === state.selectedSpanId
      ) || calls[0];

    state.selectedSessionId = active.sessionId;
    state.selectedTraceKey = active.traceKey;
    state.selectedSpanId = active.span.spanId;
    return;
  }

  const sessions = filteredSessions();
  if (!sessions.length) {
    state.selectedSessionId = null;
    state.selectedTraceKey = null;
    state.selectedSpanId = null;
    return;
  }

  const session = sessions.find((item) => item.sessionId === state.selectedSessionId) || sessions[0];
  state.selectedSessionId = session.sessionId;
  const traces = sortedTraces(session);
  const trace = traces.find((item) => item.traceKey === state.selectedTraceKey) || traces[0];
  state.selectedTraceKey = trace?.traceKey || null;
  const span = trace?.spans.find((item) => item.spanId === state.selectedSpanId) || preferredSpan(trace);
  state.selectedSpanId = span?.spanId || null;
}

function renderSessionList() {
  if (state.viewMode === 'api') {
    renderApiCallList();
    return;
  }
  const sessions = filteredSessions();
  elements.sessionList.innerHTML = '';
  if (!sessions.length) {
    elements.sessionList.appendChild(cloneEmptyState());
    return;
  }

  for (const session of sessions) {
    const chainLabel = sessionChainLabel(session);
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `session-card${session.sessionId === state.selectedSessionId ? ' is-active' : ''}`;
    card.title = `${session.sessionId}\n${session.sessionKey || ''}`.trim();
    card.innerHTML = `
      <div class="session-card-head">
        <span class="session-pill">${escapeHtml(session.agentId || 'agent')}</span>
        <span class="session-badge">${session.traceCount} traces</span>
      </div>
      <div class="session-title-row">
        <div class="session-id">${escapeHtml(shortId(session.sessionId, 18))}</div>
        <div class="session-channel">${escapeHtml(session.channelId || 'local')}</div>
      </div>
      <div class="session-meta">
        <div>开始 ${formatTime(session.startedAt)}</div>
        <div>更新 ${formatTime(session.updatedAt)}</div>
      </div>
      ${chainLabel ? `<div class="session-chain">${escapeHtml(chainLabel)}</div>` : ''}
    `;
    card.addEventListener('click', () => {
      const traces = sortedTraces(session);
      state.selectedSessionId = session.sessionId;
      state.selectedTraceKey = traces[0]?.traceKey || null;
      state.selectedSpanId = preferredSpan(traces[0])?.spanId || null;
      render();
    });
    elements.sessionList.appendChild(card);
  }
}

function renderApiCallList() {
  const calls = filteredApiCalls();
  elements.sessionList.innerHTML = '';
  if (!calls.length) {
    elements.sessionList.appendChild(cloneEmptyState());
    return;
  }

  for (const entry of calls) {
    const span = entry.span;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `session-card${span.spanId === state.selectedSpanId ? ' is-active' : ''}`;
    card.title = `${span.spanId}\n${entry.traceId}`.trim();
    const modelInfo = [span.attributes?.['llm.provider'], span.attributes?.['llm.model']].filter(Boolean).join(' / ');
    const usageChips = llmUsageSummary(span);

    card.innerHTML = `
      <div class="session-card-head">
        <span class="session-pill">model call</span>
        <span class="session-badge">${formatDuration(span.durationMs)}</span>
      </div>
      <div class="session-title-row">
        <div class="session-id">${escapeHtml(shortId(span.spanId, 18))}</div>
        <div class="session-channel">${escapeHtml(entry.sessionAgentId || 'agent')}</div>
      </div>
      <div class="session-meta">
        <div>${formatTime(span.startTime)}</div>
        <div>${escapeHtml(shortId(entry.traceId, 14))}</div>
      </div>
      <div class="trace-summary">
        ${modelInfo ? `<span class="summary-chip">${escapeHtml(modelInfo)}</span>` : ''}
        ${usageChips.map((chip) => `<span class="summary-chip${chip === 'usage 未统计' ? ' summary-chip-soft' : ''}">${escapeHtml(chip)}</span>`).join('')}
      </div>
      ${span.isFailed ? '<div class="session-chain">error</div>' : ''}
    `;
    card.addEventListener('click', () => {
      state.selectedSessionId = entry.sessionId;
      state.selectedTraceKey = entry.traceKey;
      state.selectedSpanId = span.spanId;
      render();
    });
    elements.sessionList.appendChild(card);
  }
}

function renderTraceList() {
  if (state.viewMode === 'api') {
    renderApiTraceContext();
    return;
  }
  const session = currentSession();
  elements.traceList.innerHTML = '';
  if (!session) {
    elements.traceTitle.textContent = '选择一个会话';
    elements.traceMeta.textContent = '';
    elements.traceList.appendChild(cloneEmptyState());
    return;
  }

  elements.traceTitle.textContent = `${session.agentId || 'agent'} / ${shortId(session.sessionId, 18)}`;
  elements.traceMeta.innerHTML = `
    <div>${escapeHtml(session.workspaceDir || '-')}</div>
    <div>${session.traceCount} traces</div>
    ${sessionChainLabel(session) ? `<div>${escapeHtml(sessionChainLabel(session))}</div>` : ''}
  `;

  sortedTraces(session).forEach((trace, index) => {
    const summary = traceSummary(trace);
    const visibleSpans = orderedVisibleSpans(trace);
    const visibleTree = visibleTraceTree(trace.tree || []);
    const group = document.createElement('section');
    group.className = `trace-group${trace.traceKey === state.selectedTraceKey ? ' is-active' : ''}`;
    group.title = trace.traceKey || trace.traceId;
    group.innerHTML = `
      <div class="trace-header">
        <div class="trace-title">
          <div class="trace-topline">
            <span class="trace-pill">${traceRoundLabel(session, index)}</span>
            <span class="span-chip trace-mini-id">${escapeHtml(shortId(trace.traceId, 10))}</span>
            <span class="trace-status">${formatDuration(trace.durationMs)}</span>
          </div>
          <div class="trace-meta">
            <div>${formatTime(trace.startTime)} -> ${formatTime(trace.endTime)}</div>
            <div>${trace.spanCount} spans</div>
          </div>
        </div>
        <button class="ghost-button" type="button" data-trace="${trace.traceKey}">定位</button>
      </div>
      <div class="trace-summary">
        <span class="summary-chip">${summary.modelCalls} model</span>
        <span class="summary-chip">${summary.toolCalls} tool</span>
        <span class="summary-chip">${summary.subagents} subagent</span>
        <span class="summary-chip">${summary.promptSkills.length} prompt skills</span>
        <span class="summary-chip">${summary.readSkills.length} read skills</span>
        ${
          summary.usage.reportedCalls
            ? `
              <span class="summary-chip">${summary.usage.input} input</span>
              <span class="summary-chip">${summary.usage.output} output</span>
              ${
                summary.usage.cacheRead
                  ? `<span class="summary-chip">${summary.usage.cacheRead} cache hit</span>`
                  : ''
              }
              ${
                summary.usage.unreportedCalls
                  ? `<span class="summary-chip summary-chip-soft">${summary.usage.unreportedCalls} 未统计</span>`
                  : ''
              }
            `
            : summary.modelCalls
              ? `<span class="summary-chip summary-chip-soft">usage 未统计</span>`
              : ''
        }
      </div>
      <div class="trace-tree"></div>
    `;
    group.querySelector('[data-trace]').addEventListener('click', () => {
      state.selectedTraceKey = trace.traceKey;
      state.selectedSpanId = preferredSpan(trace)?.spanId || null;
      render();
    });

    const treeHost = group.querySelector('.trace-tree');
    if (!visibleSpans.length) {
      const empty = document.createElement('div');
      empty.className = 'trace-tree-note';
      empty.textContent = '这个 trace 当前没有可展示的主要执行节点。';
      treeHost.appendChild(empty);
    } else {
      visibleTree.forEach((span) => renderSpanNode(span, treeHost));
    }
    elements.traceList.appendChild(group);
  });
}

function renderApiOverview(summary) {
  return `
    <section class="api-overview">
      <article class="overview-row">
        <div class="overview-title"><strong>calls</strong></div>
        <div class="overview-tags">
          <span class="summary-chip">${summary.totalCalls} total</span>
          <span class="summary-chip${summary.failedCalls ? ' summary-chip-error' : ''}">${summary.failedCalls} failed</span>
          <span class="summary-chip">${formatDuration(summary.avgDurationMs)}</span>
        </div>
      </article>
      <article class="overview-row">
        <div class="overview-title"><strong>tokens</strong></div>
        <div class="overview-tags">
          <span class="summary-chip">${summary.input} input</span>
          <span class="summary-chip">${summary.output} output</span>
          <span class="summary-chip">${summary.total} total</span>
        </div>
      </article>
      <article class="overview-row">
        <div class="overview-title"><strong>cache & cost</strong></div>
        <div class="overview-tags">
          <span class="summary-chip">${summary.cacheRead} cache hit</span>
          ${
            summary.cacheWrite
              ? `<span class="summary-chip">${summary.cacheWrite} cache write</span>`
              : ''
          }
          ${
            summary.costTotal
              ? `<span class="summary-chip">cost ${escapeHtml(String(summary.costTotal))}</span>`
              : ''
          }
        </div>
      </article>
      <article class="overview-row">
        <div class="overview-title"><strong>coverage</strong></div>
        <div class="overview-tags">
          <span class="summary-chip">${summary.usageReportedCalls} usage reported</span>
          <span class="summary-chip${summary.usageUnreportedCalls ? ' summary-chip-soft' : ''}">${summary.usageUnreportedCalls} 未统计</span>
          ${
            summary.topModel
              ? `<span class="summary-chip">${escapeHtml(summary.topModel)}</span>`
              : ''
          }
        </div>
      </article>
    </section>
  `;
}

function renderApiTraceContext() {
  const entry = currentApiCall();
  elements.traceList.innerHTML = '';
  if (!entry) {
    elements.traceTitle.textContent = '选择一个 API 调用';
    elements.traceMeta.textContent = '';
    elements.traceList.appendChild(cloneEmptyState());
    return;
  }

  const session = currentSession();
  const trace = currentTrace();
  const overview = aggregateApiOverview(filteredApiCalls());
  const summary = traceSummary(trace);
  const visibleTree = visibleTraceTree(trace.tree || []);
  elements.traceTitle.textContent = `${[entry.span.attributes?.['llm.provider'], entry.span.attributes?.['llm.model']].filter(Boolean).join(' / ') || 'model call'}`;
  elements.traceMeta.innerHTML = `
    <div>${escapeHtml(session?.agentId || '-')}</div>
    <div>${escapeHtml(shortId(trace?.traceId || '-', 14))}</div>
    <div>${formatTime(entry.span.startTime)}</div>
  `;

  elements.traceList.innerHTML = renderApiOverview(overview);
  const group = document.createElement('section');
  group.className = 'trace-group is-active';
  group.title = trace?.traceKey || trace?.traceId || '';
  group.innerHTML = `
    <div class="trace-header">
      <div class="trace-title">
        <div class="trace-topline">
          <span class="trace-pill">trace context</span>
          <span class="span-chip trace-mini-id">${escapeHtml(shortId(trace?.traceId || '-', 10))}</span>
          <span class="trace-status">${formatDuration(trace?.durationMs)}</span>
        </div>
        <div class="trace-meta">
          <div>${formatTime(trace?.startTime)} -> ${formatTime(trace?.endTime)}</div>
          <div>${trace?.spanCount || 0} spans</div>
        </div>
      </div>
    </div>
    <div class="trace-summary">
      <span class="summary-chip">${summary.modelCalls} model</span>
      <span class="summary-chip">${summary.toolCalls} tool</span>
      <span class="summary-chip">${summary.subagents} subagent</span>
      <span class="summary-chip">${summary.readSkills.length} skill.read</span>
    </div>
    <div class="trace-tree"></div>
  `;

  const treeHost = group.querySelector('.trace-tree');
  if (!visibleTree.length) {
    const empty = document.createElement('div');
    empty.className = 'trace-tree-note';
    empty.textContent = '这个 trace 当前没有可展示的主要执行节点。';
    treeHost.appendChild(empty);
  } else {
    visibleTree.forEach((node) => renderSpanNode(node, treeHost));
  }
  elements.traceList.appendChild(group);
}

function renderSpanNode(node, host) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `span-node depth-${Math.min(node.depth, 5)}${node.spanId === state.selectedSpanId ? ' is-active' : ''}${node.isFailed ? ' is-failed' : ''}`;
  button.dataset.kind = node.kind;
  button.title = node.spanId;
  const primaryMeta = node.displaySubtitle || node.kind;
  button.innerHTML = `
    <div class="span-node-main">
      <div class="span-node-time">${formatTime(node.startTime)}</div>
      <div class="span-node-body">
        <div class="span-node-header">
          <div class="span-node-title">
            <strong>${escapeHtml(node.displayTitle)}</strong>
            ${node.isFailed ? '<span class="summary-chip summary-chip-error">error</span>' : ''}
          </div>
          <span class="span-chip">${formatDuration(node.durationMs)}</span>
        </div>
        <div class="span-node-subtitle">
          <span>${escapeHtml(primaryMeta)}</span>
        </div>
      </div>
    </div>
  `;
  button.addEventListener('click', () => {
    state.selectedTraceKey = node.traceKey || currentTrace()?.traceKey || null;
    state.selectedSpanId = node.spanId;
    renderSessionList();
    renderTraceList();
    renderDetails();
  });
  host.appendChild(button);
  (node.children || []).forEach((child) => renderSpanNode(child, host));
}

function renderMetadata(span) {
  if (span.name === 'session.turn') {
    const trace = currentTrace();
    const summary = traceSummary(trace);
    const attrs = span.attributes || {};
    const traceStart = trace?.startTime || span.startTime;
    const traceEnd = trace?.endTime || span.endTime;
    const traceDuration = trace?.durationMs ?? span.durationMs;
    const rows = [
      ['Span ID', span.spanId],
      ['Trace ID', span.traceId],
      ['Span Type', span.kind],
      ['Status', span.isFailed ? (span.failureLabel || span.status?.code || 'FAILED') : (span.status?.code || 'OK')],
      ['Failed', span.isFailed ? 'yes' : 'no'],
      ['Duration', formatDuration(traceDuration)],
      ['Started', formatTime(traceStart)],
      ['Ended', formatTime(traceEnd)],
      ['Agent', span.agentId],
      ['Session ID', span.sessionId],
      ['Session Key', span.sessionKey],
      ['Run ID', span.runId],
      ['Trigger', triggerLabel(span.trigger || attrs['trigger'])],
      ['Model Calls', summary.modelCalls],
      ['Tool Calls', summary.toolCalls],
      ['Subagent Calls', summary.subagents],
      ['Skill Reads', summary.readSkills.length]
    ].filter(([, value]) => value || value === 0);

    const events = (span.events || [])
      .map((event) => `<li><span>${formatTime(event.time)}</span><strong>${escapeHtml(event.name)}</strong></li>`)
      .join('');

    return `
      <div class="detail-grid">
        <section class="detail-panel">
          <div class="detail-panel-head">
            <h3>元数据</h3>
            <span class="meta-tag">${escapeHtml(span.kind)}</span>
          </div>
          <dl class="metadata-grid">
            ${rows
              .map(
                ([label, value]) => `
                  <div class="meta-row">
                    <dt>${escapeHtml(label)}</dt>
                    <dd>${escapeHtml(String(value))}</dd>
                  </div>
                `
              )
              .join('')}
          </dl>
        </section>
        <section class="detail-panel">
          <div class="detail-panel-head">
            <h3>Span Events</h3>
            <span class="meta-tag">${span.events?.length || 0} events</span>
          </div>
          <div class="events-list">
            ${events ? `<ul>${events}</ul>` : '<div class="trace-tree-note">这个 span 没有额外事件。</div>'}
          </div>
        </section>
      </div>
    `;
  }
  const attrs = span.attributes || {};
  const rows = [
    ['Span ID', span.spanId],
    ['Trace ID', span.traceId],
    ['Parent Span', span.parentSpanId],
    ['Span Type', span.kind],
    ['Status', span.isFailed ? (span.failureLabel || span.status?.code || 'FAILED') : (span.status?.code || 'OK')],
    ['Failed', span.isFailed ? 'yes' : 'no'],
    ['Duration', formatDuration(span.durationMs)],
    ['Started', formatTime(span.startTime)],
    ['Ended', formatTime(span.endTime)],
    ['Session ID', span.sessionId],
    ['Session Key', span.sessionKey],
    ['Run ID', span.runId],
    ['Agent', span.agentId],
    ['Workspace', span.workspaceDir],
    ['Trigger', span.trigger],
    ['Provider', attrs['llm.provider']],
    ['Model', attrs['llm.model']],
    ['Tool', attrs['tool.name']],
    ['Tool Call ID', attrs['tool.call_id']],
    ['Subagent Kind', attrs['subagent.id'] ? 'named subagent' : (span.name === 'subagent.call' ? 'derived subagent' : null)],
    ['Subagent ID', attrs['subagent.id']],
    ['Subagent Label', attrs['subagent.label']],
    ['Subagent Session Key', attrs['subagent.session_key']],
    ['Subagent Run ID', attrs['subagent.run_id']],
    ['Subagent Status', attrs['subagent.status']],
    ['Skills In This Prompt', attrs['skills.prompt.count']],
    ['Read Skill', attrs['skill.name']],
    ['Read Skill Source', attrs['skill.source']],
    ['Read Skill Path', attrs['skill.path']]
  ].filter(([, value]) => value || value === 0);

  const events = (span.events || [])
    .map((event) => `<li><span>${formatTime(event.time)}</span><strong>${escapeHtml(event.name)}</strong></li>`)
    .join('');

  return `
    <div class="detail-grid">
      <section class="detail-panel">
        <div class="detail-panel-head">
          <h3>元数据</h3>
          <span class="meta-tag">${escapeHtml(span.kind)}</span>
        </div>
        <dl class="metadata-grid">
          ${rows
            .map(
              ([label, value]) => `
                <div class="meta-row">
                  <dt>${escapeHtml(label)}</dt>
                  <dd>${escapeHtml(String(value))}</dd>
                </div>
              `
            )
            .join('')}
        </dl>
      </section>
      <section class="detail-panel">
        <div class="detail-panel-head">
          <h3>Span Events</h3>
          <span class="meta-tag">${span.events?.length || 0} events</span>
        </div>
        <div class="events-list">
          ${events ? `<ul>${events}</ul>` : '<div class="trace-tree-note">这个 span 没有额外事件。</div>'}
        </div>
      </section>
    </div>
  `;
}

function prettyArtifactContent(artifact) {
  if (!artifact) return '';
  if (artifact.parsed) return JSON.stringify(artifact.parsed, null, 2);
  return artifact.content || '';
}

function renderSkillReadCard(trace, span, artifacts) {
  if (span.name !== 'skill.read') return '';
  const evidence = buildSkillEvidence(trace).find((item) => item.readSpan.spanId === span.spanId);
  if (!evidence) return '';
  const attrs = span.attributes || {};
  const skillReadArtifact = artifactByLabel(artifacts, 'Skill Read');
  const readContent = artifactByLabel(artifacts, 'Read Content');
  const readRequest = artifactByLabel(artifacts, 'Read Request');
  const readInputValue = {
    skill: attrs['skill.name'] || evidence.skillName || '-',
    path: attrs['skill.path'] || evidence.path || '-',
    resolvedPath: attrs['skill.resolved_path'] || skillReadArtifact?.parsed?.resolvedFilePath || '-',
    source: attrs['skill.source'] || evidence.source || '-',
    viaTool: attrs['skill.read.via_tool'] || 'read',
    request: readRequest?.parsed?.params ?? null
  };
  const readContentValue =
    readContent?.parsed?.result ??
    readContent?.parsed?.output ??
    readContent?.content ??
    skillReadArtifact?.parsed?.fileInfo?.preview ??
    '';
  return `
    <article class="content-card wide-card">
      <header>
        <h4>Skill Input</h4>
        <span class="card-note">${escapeHtml(readInputValue.skill)}</span>
      </header>
      <pre class="structured-pre">${escapeHtml(prettyValue(readInputValue))}</pre>
    </article>
    <article class="content-card wide-card">
      <header>
        <h4>Skill Output</h4>
      </header>
      <pre class="structured-pre">${escapeHtml(prettyValue(readContentValue, '没有拿到这次读取的内容'))}</pre>
      ${
        evidence.followUps.length
          ? `
            <details class="model-diagnostic-details" data-detail-key="${escapeHtml(detailKey(span, 'follow-up'))}">
              <summary class="model-panel-head">
                <strong>Follow-up</strong>
                <div class="overview-tags">
                  <span class="summary-chip">${evidence.followUps.length} spans</span>
                </div>
              </summary>
              <div class="evidence-timeline">
                ${evidence.followUps
                  .map(
                    (follow) => `
                      <div class="evidence-step">
                        <span class="evidence-time">${escapeHtml(formatTime(follow.startTime))}</span>
                        <span class="summary-chip evidence-chip">${escapeHtml(follow.displayTitle)}</span>
                        ${
                          follow.displaySubtitle
                            ? `<span class="evidence-sub">${escapeHtml(follow.displaySubtitle)}</span>`
                            : ''
                        }
                      </div>
                    `
                  )
                  .join('')}
              </div>
            </details>
          `
          : ''
      }
    </article>
  `;
}

function renderSkillEvidenceCard(trace, span) {
  return '';
}

function triggerLabel(value) {
  if (!value) return 'unknown';
  if (value === 'user') return 'user';
  return String(value);
}

function renderSessionTurnCard(trace, span) {
  if (span.name !== 'session.turn') return '';
  const summary = traceSummary(trace);
  const attrs = span.attributes || {};
  const session = currentSession();
  const start = trace?.startTime ? formatTime(trace.startTime) : (span.startTime ? formatTime(span.startTime) : '-');
  const end = trace?.endTime ? formatTime(trace.endTime) : (span.endTime ? formatTime(span.endTime) : '-');
  const duration = trace?.durationMs != null ? formatDuration(trace.durationMs) : (span.durationMs != null ? formatDuration(span.durationMs) : '-');
  const trigger = triggerLabel(span.trigger || attrs['trigger']);
  const agent = span.agentId || 'agent';
  return `
    <article class="content-card wide-card">
      <header>
        <h4>Turn Overview</h4>
        <span class="card-note">${escapeHtml(trigger)}</span>
      </header>
      <div class="overview-stack">
        <section class="overview-row">
          <div class="overview-title"><strong>summary</strong></div>
          <div class="evidence-sub">${escapeHtml(`${agent} · ${trigger} triggered turn`)}</div>
        </section>
        <section class="overview-row">
          <div class="overview-title"><strong>session</strong></div>
          <div class="evidence-sub">${escapeHtml(span.sessionId || '-')}</div>
          <div class="evidence-sub">${escapeHtml(span.sessionKey || '-')}</div>
          ${sessionChainLabel(session) ? `<div class="evidence-sub">${escapeHtml(sessionChainLabel(session))}</div>` : ''}
        </section>
        <section class="overview-row">
          <div class="overview-title"><strong>run</strong></div>
          <div class="evidence-sub">${escapeHtml(span.runId || '-')}</div>
        </section>
        <section class="overview-row">
          <div class="overview-title"><strong>time</strong></div>
          <div class="evidence-sub">${escapeHtml(start)}</div>
          <div class="evidence-sub">${escapeHtml(end)}</div>
          <div class="evidence-sub">${escapeHtml(duration)}</div>
        </section>
        <section class="overview-row">
          <div class="overview-title"><strong>calls in this turn</strong></div>
          <div class="overview-tags">
            <span class="summary-chip">${summary.modelCalls} model</span>
            <span class="summary-chip">${summary.toolCalls} tool</span>
            <span class="summary-chip">${summary.subagents} subagent</span>
            <span class="summary-chip">${summary.readSkills.length} skill.read</span>
          </div>
        </section>
      </div>
    </article>
  `;
}

function renderContent(span, trace, artifacts) {
  const hiddenArtifactLabels = new Set();
  if (span.name === 'llm.call') {
    hiddenArtifactLabels.add('Model Input');
    hiddenArtifactLabels.add('Model Output');
  }
  if (span.name === 'tool.call' || span.name === 'subagent.call') {
    hiddenArtifactLabels.add('Tool Input');
    hiddenArtifactLabels.add('Tool Output');
    hiddenArtifactLabels.add('Tool Persisted');
  }
  if (span.name === 'skill.read') {
    hiddenArtifactLabels.add('Skill Read');
    hiddenArtifactLabels.add('Read Request');
    hiddenArtifactLabels.add('Read Content');
  }
  const artifactEntries = artifacts.filter((entry) => !hiddenArtifactLabels.has(entry.label));
  const artifactCards = span.name === 'session.turn'
    ? ''
    : (span.name === 'llm.call' || span.name === 'tool.call' || span.name === 'subagent.call' || span.name === 'skill.read') && !artifactEntries.length
    ? ''
    : artifactEntries.length
    ? artifactEntries
        .map(
          ({ label, artifact }) => `
          <article class="content-card">
            <header>
              <h4>${escapeHtml(label)}</h4>
                <span class="card-note">${escapeHtml(shortId(artifact?.path || '-', 46))}</span>
              </header>
              <pre>${escapeHtml(prettyArtifactContent(artifact))}</pre>
            </article>
          `
        )
        .join('')
    : `
      <article class="content-card">
        <header>
          <h4>暂无 artifact</h4>
          <span class="card-note">showing span attributes</span>
        </header>
        <pre>${escapeHtml(JSON.stringify(span.attributes || {}, null, 2))}</pre>
      </article>
    `;

  const heroSubtitle = span.name === 'llm.call'
    ? 'structured input view'
    : (span.displaySubtitle || span.kind);
  const heroModelInfo = span.name === 'llm.call'
    ? [span.attributes?.['llm.provider'], span.attributes?.['llm.model']].filter(Boolean).join(' / ')
    : '';
  const usageChips = span.name === 'llm.call'
    ? llmUsageSummary(span)
    : [];
  const heroStatusText = span.isFailed ? (span.failureLabel || span.status?.code || 'FAILED') : (span.status?.code || 'OK');
  const heroStatusClass = span.isFailed ? 'summary-chip summary-chip-error' : 'summary-chip';

  return `
    <div class="content-stack">
      <article class="content-card hero-card">
        <header>
          <h4>${escapeHtml(span.displayTitle)}</h4>
          <span class="card-note">${escapeHtml(heroSubtitle)}</span>
        </header>
        <div class="hero-metrics">
          <span class="summary-chip">${formatDuration(span.durationMs)}</span>
          <span class="${heroStatusClass}">${escapeHtml(heroStatusText)}</span>
          ${heroModelInfo ? `<span class="summary-chip">${escapeHtml(heroModelInfo)}</span>` : ''}
          ${usageChips.map((chip) => `<span class="summary-chip${chip === 'usage 未统计' ? ' summary-chip-soft' : ''}">${escapeHtml(chip)}</span>`).join('')}
          <span class="summary-chip">${formatTime(span.startTime)}</span>
          <span class="summary-chip muted">${escapeHtml(shortId(span.spanId, 12))}</span>
        </div>
      </article>
      ${renderSessionTurnCard(trace, span)}
      ${renderModelInputCard(span, artifacts)}
      ${renderModelOutputCard(span, artifacts)}
      ${renderToolCallCard(span, artifacts)}
      ${renderSubagentCallCard(span, artifacts)}
      ${renderSkillReadCard(trace, span, artifacts)}
      ${renderSkillEvidenceCard(trace, span)}
      ${artifactCards}
    </div>
  `;
}

function renderRaw(span, artifacts) {
  const payload = {
    span,
    artifacts: artifacts.map(({ label, artifact }) => ({
      label,
      path: artifact?.path,
      parsed: artifact?.parsed,
      content: artifact?.parsed ? undefined : artifact?.content,
      error: artifact?.error
    }))
  };
  return `
    <div class="raw-view">
      <pre>${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
    </div>
  `;
}

async function renderDetails() {
  captureOpenDetails();
  const trace = currentTrace();
  const span = currentSpan();
  elements.detailsBody.innerHTML = '';
  if (!trace || !span) {
    elements.detailsTitle.textContent = '选择一个 Span';
    elements.detailsBody.appendChild(cloneEmptyState());
    return;
  }

  elements.detailsTitle.textContent = span.name === 'llm.call'
    ? span.displayTitle
    : `${span.displayTitle}${span.displaySubtitle ? ` / ${span.displaySubtitle}` : ''}`;
  const artifacts = await loadArtifacts(span);
  if (!currentSpan() || currentSpan().spanId !== span.spanId) return;

  if (state.selectedTab === 'metadata') {
    elements.detailsBody.innerHTML = renderMetadata(span);
    hydrateOpenDetails();
    return;
  }

  if (state.selectedTab === 'raw') {
    elements.detailsBody.innerHTML = renderRaw(span, artifacts);
    hydrateOpenDetails();
    return;
  }

  elements.detailsBody.innerHTML = renderContent(span, trace, artifacts);
  hydrateOpenDetails();
}

function render() {
  syncSelection();
  renderAgentFilter();
  elements.listTitle.textContent = state.viewMode === 'api' ? 'API Calls' : 'Sessions';
  elements.flowEyebrow.textContent = state.viewMode === 'api' ? 'API Overview' : 'Execution Flow';
  elements.searchInput.placeholder =
    state.viewMode === 'api' ? 'span / trace / model / tool' : 'session / trace / agent';
  renderSessionList();
  renderTraceList();
  renderDetails();
  elements.tabs.forEach((tab) => {
    tab.classList.toggle('is-active', tab.dataset.tab === state.selectedTab);
  });
  elements.viewModeButtons.forEach((button) => {
    button.classList.toggle('is-active', button.dataset.viewMode === state.viewMode);
  });
}

async function loadData(options = {}) {
  const { silent = false } = options;
  if (state.isLoading) return;
  state.isLoading = true;
  if (!silent) {
    elements.refreshButton.disabled = true;
  }
  try {
    const response = await fetch(`/api/data?ts=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`API failed with status ${response.status}`);
    state.data = await response.json();
    render();
  } catch (error) {
    if (!silent) {
      elements.sessionList.innerHTML = `
        <div class="empty-state">
          <p class="empty-title">加载失败</p>
          <p class="empty-copy">${escapeHtml(error.message)}</p>
        </div>
      `;
    }
  } finally {
    state.isLoading = false;
    if (!silent) {
      elements.refreshButton.disabled = false;
    }
  }
}

function startAutoRefresh() {
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
  }
  state.autoRefreshTimer = window.setInterval(() => {
    if (document.hidden) return;
    loadData({ silent: true });
  }, AUTO_REFRESH_MS);
}

elements.searchInput.addEventListener('input', (event) => {
  state.search = event.target.value;
  render();
});

elements.agentFilter.addEventListener('change', (event) => {
  state.agent = event.target.value;
  render();
});

elements.refreshButton.addEventListener('click', () => {
  state.artifactCache.clear();
  loadData();
});

elements.viewModeButtons.forEach((button) => {
  button.addEventListener('click', () => {
    state.viewMode = button.dataset.viewMode;
    render();
  });
});

elements.tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    state.selectedTab = tab.dataset.tab;
    elements.tabs.forEach((item) => item.classList.toggle('is-active', item === tab));
    renderDetails();
  });
});

loadData();
startAutoRefresh();

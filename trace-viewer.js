#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readJsonl } = require('./log-store');

function getStateDir() {
  return process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), '.openclaw');
}

function short(value, len = 8) {
  if (!value) return 'null';
  const text = String(value);
  return text.length <= len ? text : text.slice(0, len);
}

function durationMs(span) {
  const start = Date.parse(span.startTime || '');
  const end = Date.parse(span.endTime || '');
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

function chooseLatestTraceId(spans) {
  const roots = spans
    .filter((span) => span && span.name === 'session.turn')
    .sort((a, b) => Date.parse(b.startTime || '') - Date.parse(a.startTime || ''));
  return roots[0] ? roots[0].traceId : null;
}

function dedupeSpans(spans) {
  const bySpanId = new Map();
  for (const span of spans) bySpanId.set(span.spanId, span);
  return [...bySpanId.values()];
}

function dedupeChildren(children) {
  const seen = new Set();
  const result = [];
  for (const child of children) {
    const key = [
      child.name,
      child.parentSpanId,
      child.attributes?.['skills.cataloged.artifact_sha1'] || '',
      child.attributes?.['skills.catalog_read.path'] || child.attributes?.['skills.load.path'] || '',
      child.attributes?.['skill.path'] || '',
      child.attributes?.['tool.call_id'] || '',
      child.attributes?.['llm.input.artifact_sha1'] || '',
      child.attributes?.['llm.output.artifact_sha1'] || '',
      child.startTime
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(child);
  }
  return result;
}

function buildTree(spans) {
  const byParent = new Map();
  const byId = new Map();
  for (const span of spans) {
    byId.set(span.spanId, span);
    const parentId = span.parentSpanId || '__root__';
    if (!byParent.has(parentId)) byParent.set(parentId, []);
    byParent.get(parentId).push(span);
  }
  for (const [key, children] of byParent.entries()) {
    children.sort((a, b) => Date.parse(a.startTime || '') - Date.parse(b.startTime || ''));
    byParent.set(key, dedupeChildren(children));
  }
  return { byParent, byId };
}

function spanSummary(span) {
  const attrs = span.attributes || {};
  const ms = durationMs(span);
  const pieces = [`${span.name}`];
  if (ms != null) pieces.push(`${ms}ms`);
  if (span.name === 'llm.call') {
    pieces.push(`${attrs['llm.provider'] || '?'}:${attrs['llm.model'] || '?'}`);
    if (attrs['llm.input.artifact_path']) pieces.push(`in=${attrs['llm.input.artifact_path']}`);
    if (attrs['llm.output.artifact_path']) pieces.push(`out=${attrs['llm.output.artifact_path']}`);
  } else if (span.name === 'tool.call') {
    pieces.push(`tool=${attrs['tool.name'] || '?'}`);
    if (attrs['tool.input.artifact_path']) pieces.push(`in=${attrs['tool.input.artifact_path']}`);
    if (attrs['tool.output.artifact_path']) pieces.push(`out=${attrs['tool.output.artifact_path']}`);
    if (attrs['tool.persisted.artifact_path']) pieces.push(`persist=${attrs['tool.persisted.artifact_path']}`);
  } else if (span.name === 'skills.cataloged') {
    pieces.push(`count=${attrs['skills.cataloged.count'] || 0}`);
    const names = attrs['skills.cataloged.names'] || [];
    if (Array.isArray(names) && names.length) pieces.push(`skills=${names.slice(0, 6).join(',')}${names.length > 6 ? ',...' : ''}`);
  } else if (span.name === 'skills.catalog_read') {
    pieces.push(`skill=${attrs['skills.catalog_read.skill_name'] || '?'}`);
    pieces.push(`source=${attrs['skills.catalog_read.source'] || '?'}`);
  } else if (span.name === 'skill.read') {
    pieces.push(`skill=${attrs['skill.name'] || '?'}`);
    pieces.push(`source=${attrs['skill.source'] || '?'}`);
  }
  return pieces.join(' | ');
}

function printTree(node, byParent, indent = '') {
  console.log(`${indent}- ${spanSummary(node)}`);
  const children = byParent.get(node.spanId) || [];
  for (const child of children) printTree(child, byParent, `${indent}  `);
}

function printEvents(traceId, limit = 20) {
  const events = readJsonl('events')
    .filter((event) => event.traceId === traceId)
    .sort((a, b) => Date.parse(a.timestamp || '') - Date.parse(b.timestamp || ''));
  if (!events.length) return;
  console.log('\nEvents');
  for (const event of events.slice(-limit)) {
    const summary = [];
    summary.push(event.type);
    if (event.provider || event.model) summary.push(`${event.provider || '?'}:${event.model || '?'}`);
    if (event.toolName) summary.push(`tool=${event.toolName}`);
    if (event.skillName) summary.push(`skill=${event.skillName}`);
    if (event.artifact?.path) summary.push(`artifact=${event.artifact.path}`);
    console.log(`- ${event.timestamp} | ${summary.join(' | ')}`);
  }
}

function main() {
  const spans = dedupeSpans(readJsonl('spans'));
  if (!spans.length) {
    console.error('No spans found.');
    process.exit(1);
  }

  const arg = process.argv[2] || 'latest';
  const traceId = arg === 'latest' ? chooseLatestTraceId(spans) : arg;
  if (!traceId) {
    console.error('Could not resolve a traceId.');
    process.exit(1);
  }

  const traceSpans = spans.filter((span) => span.traceId === traceId);
  if (!traceSpans.length) {
    console.error(`No spans found for traceId: ${traceId}`);
    process.exit(1);
  }

  const { byParent } = buildTree(traceSpans);
  const roots = (byParent.get('__root__') || []).filter((span) => !span.parentSpanId);

  console.log(`Trace ${traceId}`);
  console.log(`Spans ${traceSpans.length}`);
  console.log('');
  for (const root of roots) printTree(root, byParent);
  printEvents(traceId);
}

main();

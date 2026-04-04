# OpenClaw Audit Plugin

Structured audit logging and local trace visualization for OpenClaw.

This plugin turns OpenClaw runtime activity into a trace-oriented debugging surface:

- session turns as trace roots
- model calls with structured input/output views
- tool calls with input/output artifacts
- skill reads as derived child nodes
- subagent dispatches linked to child sessions

It writes JSONL span/event logs plus large artifacts to the local OpenClaw state directory, then serves a dashboard for exploring trace trees and node-level details.

## Why This Exists

OpenClaw exposes a lot of useful runtime signals, but they are spread across hooks, logs, and session state.

This plugin pulls those signals into one place so you can:

- inspect a full turn as a trace tree
- compare model input vs model output
- see which tools were called and what they returned
- track skill reads separately from prompt-visible skills
- follow parent agent to child subagent dispatches

## What It Includes

- `index.js`: OpenClaw plugin entrypoint
- `server.js`: local trace dashboard server
- `trace-viewer.js`: terminal trace viewer
- `ui/`: dashboard frontend
- `openclaw.plugin.json`: plugin manifest
- `package.json`: standalone scripts for local development

## Installing In OpenClaw

Copy this directory into an OpenClaw workspace or plugin search path, then load it as a local plugin.

Typical shape:

```text
<workspace>/plugins/audit-plugin/
  index.js
  openclaw.plugin.json
  server.js
  trace-viewer.js
  ui/
```

The plugin expects OpenClaw to call `index.js` through the standard plugin mechanism.

## What It Writes

By default, the plugin writes to the OpenClaw state directory:

- `logs/audit-events.log`
- `logs/audit-spans.log`
- `logs/audit-artifacts/`

The base directory is:

- `$OPENCLAW_STATE_DIR` if set
- otherwise `~/.openclaw`

## Running The Dashboard

```bash
npm run trace:ui
```

Optional environment variables:

- `TRACE_UI_PORT`: dashboard port, defaults to `4318`
- `OPENCLAW_STATE_DIR`: override the OpenClaw state directory

Then open:

- `http://127.0.0.1:4318`

Or run directly:

```bash
node server.js
```

## Terminal Trace Viewer

```bash
npm run trace:view -- latest
```

Or pass a specific trace id:

```bash
npm run trace:view -- <trace-id>
```

Or run directly:

```bash
node trace-viewer.js latest
node trace-viewer.js <trace-id>
```

## Publishing Notes

This repository is intended to publish only the plugin code, not local runtime data.

Do **not** publish:

- your `openclaw.json`
- `logs/`
- `audit-artifacts/`
- API keys, tokens, or bot credentials
- real session data
- machine-specific launch agent files

Before publishing, review:

- local absolute paths
- organization-specific names
- copied third-party code or license headers

## Recommended Release Shape

Publish this directory as the unit of reuse:

- `index.js`
- `server.js`
- `trace-viewer.js`
- `ui/`
- `openclaw.plugin.json`
- `package.json`
- `README.md`
- `.gitignore`
- `PUBLISHING.md`

Keep local deployment glue outside the published package:

- user-specific `LaunchAgents`
- private config
- logs and artifacts

## License

This project is licensed under the MIT License.

If you copied code from OpenClaw itself, preserve the required upstream license notice where needed.

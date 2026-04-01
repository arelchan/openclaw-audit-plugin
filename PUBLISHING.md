# Publishing Checklist

Use this checklist before open-sourcing the plugin.

## 1. Keep Only Shareable Files

Publish the plugin code, not your local OpenClaw runtime.

Safe baseline:

- `index.js`
- `server.js`
- `trace-viewer.js`
- `ui/`
- `openclaw.plugin.json`
- `package.json`
- `README.md`
- `PUBLISHING.md`
- `.gitignore`

Do not include:

- `~/.openclaw/openclaw.json`
- `~/.openclaw/logs/`
- `~/.openclaw/logs/audit-artifacts/`
- local launch agent files

## 2. Remove Sensitive Data

Check for:

- API keys
- gateway tokens
- Feishu credentials
- real user identifiers
- private workspace names

## 3. Review Path Assumptions

This plugin intentionally uses:

- `$OPENCLAW_STATE_DIR`
- `os.homedir()`

That is publishable.

Avoid adding hardcoded paths such as:

- `/Users/<name>/...`

## 4. Verify Runtime Behavior

Before publishing, test on a clean machine or a temporary directory by setting:

```bash
OPENCLAW_STATE_DIR=/tmp/openclaw-test node server.js
```

And verify the code still parses cleanly:

```bash
npm run check
```

## 5. Add A License

Pick a license for your code and commit it explicitly.

If any source was copied from upstream OpenClaw, keep the required license notice.

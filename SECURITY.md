# Security Notes

## Sensitive Data

This plugin is an audit and tracing tool. It may capture sensitive runtime content, including:

- prompts
- model outputs
- tool arguments
- tool results
- skill file contents
- session metadata

## Default Output Paths

By default, runtime data is written under the OpenClaw state directory:

- `logs/audit-events.log`
- `logs/audit-spans.log`
- `logs/audit-artifacts/`

Unless overridden, this is typically `~/.openclaw`.

## Safe Publishing Guidance

Do not publish or share:

- your OpenClaw config
- raw logs
- raw artifacts
- API keys or access tokens
- real user conversations without redaction

## Reporting

If you discover a security issue in the plugin code itself, report it privately to the maintainer before opening a public issue.

# Contributing

Thanks for contributing.

## Before You Change Code

- keep the plugin self-contained
- avoid coupling published code to private local config
- do not commit runtime logs or artifacts
- prefer environment variables over machine-specific paths

## Local Checks

Run:

```bash
npm run check
```

If you changed the dashboard, also run:

```bash
npm run trace:ui
```

Then inspect a few real traces in the browser.

## Design Principles

- trace trees should stay readable first
- derived nodes should map cleanly to real runtime behavior
- structured views should prefer input/output over raw JSON
- privacy boundaries should be explicit

## Pull Requests

Small, focused changes are preferred.

When changing trace semantics, explain:

- what runtime event changed
- how the UI changes
- whether existing logs remain compatible

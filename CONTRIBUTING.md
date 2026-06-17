# Contributing

Thanks for helping improve WhereMyTokens.

## Before You Start

- Open an issue for larger behavior changes so the direction is clear.
- Keep changes scoped to the platform repository you are editing.
- Preserve the local-first privacy model: do not upload session logs or credentials.

## Development

```bash
npm install
npm run build
npm test
```

Use `npm start` for local smoke testing after a successful build.

## Pull Requests

- Include a short summary of the user-visible change.
- Mention any privacy, credential, or provider-data implications.
- Add or update focused tests when changing parser, provider, quota, ledger, IPC, or notification behavior.
- Update README or docs when changing installation, setup, provider support, or release assets.

## Release Notes

Release notes should group changes under:

- New Features
- Improvements
- Fixes
- Install

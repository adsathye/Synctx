# Contributing to Synctx

Thank you for your interest in contributing! Here's how to get started.

## Getting Started

1. **Fork** the repository
2. **Clone** your fork locally
3. **Install** prerequisites: Node.js 18+, GitHub CLI (`gh`), [Gitleaks](https://github.com/gitleaks/gitleaks)
4. **Run** `node install.js` to set up the plugin locally

## Development Workflow

```bash
# Run syntax checks
npm run lint

# Run status check
npm test

# Test the CLI directly
synctx help
synctx status
synctx list
```

## Making Changes

1. Create a feature branch: `git checkout -b feature/my-feature`
2. Make your changes — keep them focused and minimal
3. Run `npm run lint` to verify syntax
4. Commit with a clear message following [Conventional Commits](https://www.conventionalcommits.org/):
   ```
   feat: add new command for session export
   fix: handle empty repo on first push
   docs: update README with new prerequisites
   ```
5. Push and open a Pull Request

## Project Structure

```
synctx/
├── scripts/
│   ├── sync-engine.js          # Main entry point and command router
│   ├── lib/
│   │   ├── config.js           # Configuration and CLI path mappings
│   │   ├── file-manager.js     # Delta sync with atomic copy
│   │   ├── git-manager.js      # Git lifecycle (bootstrap, sync, restore)
│   │   ├── security.js         # Gitleaks secret scanner
│   │   ├── lock.js             # PID-aware concurrency lock
│   │   ├── logger.js           # Audit logging with redaction
│   │   ├── tags.js             # Session tagging system
│   │   └── commands/           # Command implementations
│   ├── postinstall.js          # Interactive setup wizard
│   └── auto-setup.js           # Session-start hook handler
├── commands/                   # Copilot CLI command definitions (.md)
├── skills/                     # Copilot CLI skill definitions (SKILL.md)
├── agents/                     # Agent definition
├── plugin.json                 # Copilot CLI plugin manifest
├── hooks.json                  # Copilot CLI hook definitions
└── install.js                  # One-step installer
```

## Guidelines

- **No dependencies** — Synctx uses only Node.js built-ins (fs, path, os, child_process)
- **Cross-platform** — All code must work on Windows, macOS, and Linux
- **Security first** — Never commit secrets; all staged files are scanned by Gitleaks
- **Minimal changes** — Keep PRs focused; one feature or fix per PR

## Reporting Issues

- Use [GitHub Issues](https://github.com/adsathye/synctx/issues) for bugs and feature requests
- Include your OS, Node.js version, and relevant log output from `~/.synctx/security-audit/general.log`

## Code of Conduct

This project follows the [Contributor Covenant Code of Conduct](CODE_OF_CONDUCT.md).

# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.0.x   | ✅        |

## Reporting a Vulnerability

If you discover a security vulnerability in Synctx, please report it responsibly:

1. **Do NOT** open a public GitHub issue for security vulnerabilities
2. Email the maintainer or use [GitHub's private vulnerability reporting](https://github.com/adsathye/synctx/security/advisories/new)
3. Include a description of the vulnerability, steps to reproduce, and potential impact

We will acknowledge receipt within 48 hours and aim to release a fix within 7 days for critical issues.

## Security Architecture

Synctx is designed with security as a core principle:

- **Gitleaks Integration** — All session files are scanned for secrets before every push. Detected secrets are auto-redacted and logged.
- **Private Repository** — Session data is stored in a private GitHub repository, never public.
- **Delegated Authentication** — Synctx never handles credentials directly. Git authentication is delegated to `gh auth git-credential`, configured as a repo-local credential helper. No tokens, passwords, or SSH keys are stored by Synctx.
- **Dedicated Commit Identity** — Sync commits use a local identity (`Synctx <synctx@noreply>`) scoped to the sync repo. Your global git config and other repositories are not affected.
- **No Network Calls** — Synctx only communicates with GitHub via `git` and `gh` CLI tools. No telemetry, no third-party services.
- **PID-Aware Locking** — Concurrency locks prevent race conditions and include stale-lock recovery.
- **Git Guardrails** — All git commands are sandboxed to the staging directory via `assertSyncDir()`, preventing accidental operations on user repositories.
- **Audit Logging** — All sync operations, security scans, and redactions are logged to `~/.synctx/security-audit/general.log`.

## Dependencies

Synctx has **zero npm dependencies**. It uses only Node.js built-in modules. External tools (git, gh, gitleaks) are invoked via `child_process` and must be installed separately by the user.

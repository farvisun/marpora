# Security

Marpora keeps your documents on your Mac and guards a few things on purpose:

- AI provider API keys are stored in the macOS Keychain (service `app.marpora.editor`), never in settings files, and are sent only to the provider or base URL you configured.
- An agent's edits to your files are shown first and applied only after you allow them, per agent.
- Updates are installed only when their signature matches the public key built into the app (`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`).

If you find a way around any of that, or anything else that puts your files or keys at risk, please report it privately through [GitHub security advisories](https://github.com/farvisun/marpora/security/advisories/new) rather than in a public issue.

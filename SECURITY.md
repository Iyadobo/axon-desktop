# Privacy and security

Axon keeps chats and settings in Electron's per-user application-data directory.
They are never part of the repository or release artifacts.

Before contributing, remove personal paths, account names, tokens, local logs,
and captured conversations. Use `.env` for local credentials; do not commit it.

If you discover a sensitive value in a published revision, report it privately
to the maintainers and do not open a public issue containing the value.

# scripts/bin — PATH shims

This directory contains shim scripts that intercept forbidden CLI commands and redirect developers (and agents) to the correct alternative.

`scripts/bin` is prepended to PATH for all sessions within the project directory via `[env] _.path` in `mise.toml`.
This activates automatically for any shell or agent session where mise is active and the working directory is under the repo.

## Shims

| Command | Redirects to | Rationale                                                                                                              |
| ------- | ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `npm`   | `pnpm`       | This project uses pnpm exclusively. npm must never be used — it ignores `pnpm-lock.yaml` and can corrupt the lockfile. |

### npm shim pass-throughs

| Pattern                      | Reason                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm root`                   | The extension calls `npm root -g` at startup to discover the global `node_modules` directory where Pi installs skills and extensions.                                                 |
| `npm ... --prefix */.pi/npm` | Pi itself runs `npm install/uninstall --prefix <project>/.pi/npm` to manage extensions and skills. Any subcommand with a `.pi/npm` path is passed through as a Pi-internal operation. |
| `npm install -g ...`         | Pi runs `npm install -g <pkg>` to install global packages. Global installs don't affect the project lockfile.                                                                         |
| `npm uninstall -g ...`       | Pi runs `npm uninstall -g <pkg>` to remove global packages. Global uninstalls don't affect the project lockfile.                                                                      |

All other npm subcommands are blocked.

## Adding a new shim

1. Create a new executable script in this directory named after the forbidden command.
2. The script must exit with a non-zero exit code.
3. Print a clear error message to stderr identifying the correct alternative.
4. Detect subcommands where possible and provide a specific suggestion.
5. Add the new entry to the table above.

## Emergency bypass

If you genuinely need to run the real `npm` binary (e.g., for debugging the shim itself):

```bash
$(mise where node)/bin/npm --version
```

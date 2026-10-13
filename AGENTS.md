# AGENTS.md - Zedx Development Guide

## Project Overview

Zedx is a CLI toolkit for the Zed Editor. It does two things:

- **Sync**: keeps Zed config (`settings.json`, `keymap.json`, `tasks.json`, `snippets/*.json`) in sync across machines via a Git repo, optionally through an OS daemon.
- **Extensions**: scaffolds, extends, validates, and dev-installs Zed extensions (themes, icon themes, languages, language servers).

For documentation on how Zed extensions are made, use this url: https://zed.dev/docs/extensions

## Build Commands

```bash
pnpm build    # Build TypeScript to dist/ and copy templates
pnpm lint     # Lint with oxlint
pnpm fmt      # Format with oxfmt
pnpm test     # Run vitest unit tests
```

You don't test the cli, tell me to test it myself manually. don't automate the testing.

## Code Style Guidelines

### TypeScript Configuration

- **Target**: ES2022
- **Module**: ESNext (ESM)
- **Strict mode**: Enabled
- **Module resolution**: Bundler

### Types and Interfaces

- Use `type` for unions, primitives, and function types
- Use `interface` for object shapes that may be extended
- PascalCase for all type names
- Export types directly or via index.ts barrel files

```typescript
export type ExtensionType = 'theme' | 'language';

export interface ExtensionOptions {
    name: string;
    id: string;
    types: ExtensionType[];
}
```

### Naming Conventions

- **Variables/functions**: camelCase
- **Types/interfaces**: PascalCase
- **Constants**: SCREAMING_SNAKE_CASE for config values, camelCase otherwise
- **Files**: kebab-case.ts

### Formatting

- 4 spaces for indentation
- Single quotes for strings
- Trailing commas in objects/arrays
- No semicolons at statement end
- Use template literals instead of string concatenation

### Error Handling

```typescript
// CLI errors - use @clack/prompts for user feedback
if (!(await fs.pathExists(tomlPath)) {
  p.log.error(color.red('No extension.toml found'));
  process.exit(1);
}

// Async errors - catch at entry point
main().catch(console.error);

// Cancellation handling
if (p.isCancel(value)) {
  p.cancel('Cancelled.');
  process.exit(0);
}
```

### Best Practices

1. **Async/Await**: Always use for asynchronous operations
2. **File Operations**: Use `fs-extra` for promise-based fs methods
3. **CLI Output**: Use `picocolors` for colors and `@clack/prompts` for interactive prompts
4. **Path Handling**: Use `path.join()` for path construction
5. **Type Safety**: Avoid `any`, use type assertions when needed with `as unknown as Type`

### Project Structure

```
src/
├── index.ts       # CLI entry point (commander), welcome screen, version bumping
├── prompts.ts     # User input for `zedx create` via @clack/prompts
├── generator.ts   # `zedx create` - file generation from EJS templates
├── add.ts         # `zedx add` - theme, icon theme, language
├── snippet.ts     # `zedx snippet add lsp` - language server wiring
├── check.ts       # `zedx check` - extension validation and publish gate
├── publish.ts     # `zedx publish` - registry submission steps, release workflow
├── registry-rules.ts # Zed extension registry rules (ID, version, license)
├── install.ts     # `zedx install` - install as a Zed dev extension
├── sync.ts        # `zedx sync` - init, status, select, and the sync run
├── sync-merge.ts  # Pure helpers for sync: JSON merge, ignored keys, line diff
├── sync-history.ts # `zedx sync history/restore` - browse and restore past versions
├── daemon.ts      # `zedx sync install/uninstall` - launchd, systemd, Task Scheduler
├── config.ts      # `zedx config` - repo, conflict strategy, default files, ignored keys
├── zed-paths.ts   # Per-platform Zed config paths
├── github.ts      # GitHub CLI helpers (create the sync repo with gh)
├── *.test.ts      # Vitest unit tests (sync, sync-merge, sync-history, github, registry-rules, zed-paths)
├── types/
│   └── index.ts   # TypeScript interfaces/types
└── templates/     # EJS templates (copied to dist on build)
```

### Dependencies

- **CLI**: commander, @clack/prompts, picocolors
- **Files**: fs-extra
- **Templating**: ejs
- **Git**: simple-git
- **Parsing**: smol-toml, jsonc-parser
- **Dev**: typescript, tsx, vitest, oxlint, oxfmt, @types/node

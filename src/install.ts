import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import fs from 'fs-extra';
import color from 'picocolors';

// TOML helpers (regex-based — no parser dependency needed for these fields)
function tomlGetString(content: string, key: string): string | undefined {
    const match = content.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
    return match?.[1];
}

function tomlGetNumber(content: string, key: string): number | undefined {
    const match = content.match(new RegExp(`^${key}\\s*=\\s*(\\d+)`, 'm'));
    return match ? Number(match[1]) : undefined;
}

function tomlGetAuthors(content: string): string[] {
    const match = content.match(/^authors\s*=\s*\[([^\]]*)\]/m);
    if (!match) return [];
    return [...match[1].matchAll(/"([^"]*)"/g)].map(m => m[1]);
}

// Filesystem helpers
function resolveZedExtensionsDir(): string {
    const home = os.homedir();
    const platform = process.platform;

    if (platform === 'darwin') {
        return path.join(home, 'Library', 'Application Support', 'Zed', 'extensions');
    }
    if (platform === 'linux') {
        const xdgData =
            process.env.FLATPAK_XDG_DATA_HOME ||
            process.env.XDG_DATA_HOME ||
            path.join(home, '.local', 'share');
        return path.join(xdgData, 'zed', 'extensions');
    }
    if (platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
        return path.join(localAppData, 'Zed', 'extensions');
    }
    throw new Error(`Unsupported platform: ${platform}`);
}

function listSubdirs(dir: string): string[] {
    try {
        return fs
            .readdirSync(dir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
    } catch {
        return [];
    }
}

// Manifest builder
interface ExtensionManifest {
    id: string;
    name: string;
    version: string;
    schema_version: number;
    description: string;
    repository: string;
    authors: string[];
    lib: { kind: string | null; version: string | null };
    themes: string[];
    icon_themes: string[];
    languages: string[];
    grammars: Record<string, unknown>;
    language_servers: Record<string, unknown>;
    context_servers: Record<string, unknown>;
    agent_servers: Record<string, unknown>;
    slash_commands: Record<string, unknown>;
    snippets: null;
    capabilities: unknown[];
}

function buildManifest(extensionDir: string, toml: string): ExtensionManifest {
    const id = tomlGetString(toml, 'id') ?? 'unknown';
    const name = tomlGetString(toml, 'name') ?? id;
    const version = tomlGetString(toml, 'version') ?? '0.0.1';
    const schemaVersion = tomlGetNumber(toml, 'schema_version') ?? 1;
    const description = tomlGetString(toml, 'description') ?? '';
    const repository = tomlGetString(toml, 'repository') ?? '';
    const authors = tomlGetAuthors(toml);

    // Detect themes
    const themesDir = path.join(extensionDir, 'themes');
    const themes: string[] = fs.pathExistsSync(themesDir)
        ? fs
              .readdirSync(themesDir)
              .filter(f => f.endsWith('.json'))
              .map(f => `themes/${f}`)
        : [];

    // Detect languages
    const langsDir = path.join(extensionDir, 'languages');
    const languages: string[] = fs.pathExistsSync(langsDir)
        ? listSubdirs(langsDir).map(d => `languages/${d}`)
        : [];

    // Detect grammars from extension.toml  [grammars.<id>] blocks
    const grammars: Record<string, unknown> = {};
    const grammarMatches = toml.matchAll(
        /^\[grammars\.([^\]]+)\]\s*\nrepository\s*=\s*"([^"]*)"\s*\nrev\s*=\s*"([^"]*)"/gm,
    );
    for (const m of grammarMatches) {
        grammars[m[1]] = { repository: m[2], rev: m[3], path: null };
    }

    // Detect language_servers from extension.toml  [language_servers.<id>] blocks
    const languageServers: Record<string, unknown> = {};
    const lsMatches = toml.matchAll(
        /^\[language_servers\.([^\]]+)\]\s*\nname\s*=\s*"([^"]*)"\s*\nlanguages\s*=\s*\[([^\]]*)\]/gm,
    );
    for (const m of lsMatches) {
        const langs = [...m[3].matchAll(/"([^"]*)"/g)].map(x => x[1]);
        languageServers[m[1]] = {
            language: langs[0] ?? '',
            languages: langs.slice(1),
            language_ids: {},
            code_action_kinds: null,
        };
    }

    // Detect whether Rust lib is present
    const hasLib = fs.pathExistsSync(path.join(extensionDir, 'Cargo.toml'));

    return {
        id,
        name,
        version,
        schema_version: schemaVersion,
        description,
        repository,
        authors,
        lib: { kind: hasLib ? 'Rust' : null, version: null },
        themes,
        icon_themes: [],
        languages,
        grammars,
        language_servers: languageServers,
        context_servers: {},
        agent_servers: {},
        slash_commands: {},
        snippets: null,
        capabilities: [],
    };
}

// Main install function
export async function installDevExtension(callerDir: string): Promise<void> {
    p.intro(
        `${color.bgBlue(color.bold(' zedx install '))} ${color.blue('Installing as a Zed dev extension…')}`,
    );

    const tomlPath = path.join(callerDir, 'extension.toml');
    if (!(await fs.pathExists(tomlPath))) {
        p.log.error(color.red('No extension.toml found. Run zedx from an extension directory.'));
        process.exit(1);
    }

    const toml = await fs.readFile(tomlPath, 'utf-8');
    const extensionId = tomlGetString(toml, 'id');
    if (!extensionId) {
        p.log.error(color.red('Could not read extension id from extension.toml.'));
        process.exit(1);
    }

    let extensionsDir: string;
    try {
        extensionsDir = resolveZedExtensionsDir();
    } catch (err) {
        p.log.error(color.red(String(err)));
        process.exit(1);
    }

    const installedDir = path.join(extensionsDir, 'installed');
    const indexPath = path.join(extensionsDir, 'index.json');
    const symlinkPath = path.join(installedDir, extensionId);

    await fs.ensureDir(installedDir);

    // --- Handle existing symlink / directory ---
    if (await fs.pathExists(symlinkPath)) {
        const stat = await fs.lstat(symlinkPath);
        if (stat.isSymbolicLink()) {
            const existing = await fs.readlink(symlinkPath);
            if (existing === callerDir) {
                p.log.warn(
                    `${color.yellow(`${extensionId}`)} is already installed and points to this directory.`,
                );
            } else {
                const overwrite = await p.confirm({
                    message: `${extensionId} is already installed (→ ${existing}). Replace it?`,
                    initialValue: true,
                });
                if (p.isCancel(overwrite) || !overwrite) {
                    p.cancel('Cancelled.');
                    process.exit(0);
                }
                await fs.remove(symlinkPath);
                await fs.symlink(callerDir, symlinkPath);
                p.log.success(
                    `Replaced symlink ${color.cyan(`installed/${extensionId}`)} → ${color.dim(callerDir)}`,
                );
            }
        } else {
            p.log.error(
                color.red(`${symlinkPath} exists and is not a symlink. Remove it manually first.`),
            );
            process.exit(1);
        }
    } else {
        await fs.symlink(callerDir, symlinkPath);
        p.log.success(
            `Created symlink ${color.cyan(`installed/${extensionId}`)} → ${color.dim(callerDir)}`,
        );
    }

    // --- Upsert index.json ---
    let index: { extensions: Record<string, unknown> } = { extensions: {} };
    if (await fs.pathExists(indexPath)) {
        try {
            index = await fs.readJson(indexPath);
        } catch {
            // malformed — start fresh
        }
    }

    const manifest = buildManifest(callerDir, toml);
    index.extensions[extensionId] = { manifest, dev: true };

    await fs.writeJson(indexPath, index, { spaces: 2 });
    p.log.success(`Updated ${color.cyan('index.json')}`);

    p.outro(
        `${color.green('✓')} ${color.bold(`${manifest.name} v${manifest.version}`)} installed as a dev extension.\n\n` +
            `  ${color.dim('Reload Zed to pick up the changes:')}\n` +
            `  ${color.white('Extensions')} ${color.dim('→')} ${color.white('Reload Extensions')}  ${color.dim('(or restart Zed)')}\n\n` +
            `  ${color.dim('Run')} ${color.cyan('zedx check')} ${color.dim('to validate your extension.')}`,
    );
}

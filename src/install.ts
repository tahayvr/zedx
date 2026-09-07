import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import fs from 'fs-extra';
import color from 'picocolors';
import { parse as parseToml, TomlError } from 'smol-toml';

type TomlTable = Record<string, unknown>;

function tomlString(table: TomlTable, key: string): string | undefined {
    const value = table[key];
    return typeof value === 'string' ? value : undefined;
}

function tomlNumber(table: TomlTable, key: string): number | undefined {
    const value = table[key];
    return typeof value === 'number' ? value : undefined;
}

function tomlAuthors(table: TomlTable): string[] {
    const value = table['authors'];
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
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

function buildManifest(extensionDir: string, toml: TomlTable): ExtensionManifest {
    const id = tomlString(toml, 'id') ?? 'unknown';
    const name = tomlString(toml, 'name') ?? id;
    const version = tomlString(toml, 'version') ?? '0.0.1';
    const schemaVersion = tomlNumber(toml, 'schema_version') ?? 1;
    const description = tomlString(toml, 'description') ?? '';
    const repository = tomlString(toml, 'repository') ?? '';
    const authors = tomlAuthors(toml);

    // Detect themes
    const themesDir = path.join(extensionDir, 'themes');
    const themes: string[] = fs.pathExistsSync(themesDir)
        ? fs
              .readdirSync(themesDir)
              .filter(f => f.endsWith('.json'))
              .map(f => `themes/${f}`)
        : [];

    // Detect icon themes
    const iconThemesDir = path.join(extensionDir, 'icon_themes');
    const iconThemes: string[] = fs.pathExistsSync(iconThemesDir)
        ? fs
              .readdirSync(iconThemesDir)
              .filter(f => f.endsWith('.json'))
              .map(f => `icon_themes/${f}`)
        : [];

    // Detect languages
    const langsDir = path.join(extensionDir, 'languages');
    const languages: string[] = fs.pathExistsSync(langsDir)
        ? listSubdirs(langsDir).map(d => `languages/${d}`)
        : [];

    // Detect grammars from the parsed [grammars.<id>] table
    const grammarsTable = (toml['grammars'] as TomlTable | undefined) ?? {};
    const grammars: Record<string, unknown> = {};
    for (const [grammarId, value] of Object.entries(grammarsTable)) {
        const entry = (value as TomlTable | undefined) ?? {};
        grammars[grammarId] = {
            repository: tomlString(entry, 'repository') ?? '',
            rev: tomlString(entry, 'rev') ?? '',
            path: null,
        };
    }

    // Detect language_servers from the parsed [language_servers.<id>] table
    const languageServersTable = (toml['language_servers'] as TomlTable | undefined) ?? {};
    const languageServers: Record<string, unknown> = {};
    for (const [lsId, value] of Object.entries(languageServersTable)) {
        const entry = (value as TomlTable | undefined) ?? {};
        const languagesValue = entry['languages'];
        const langs = Array.isArray(languagesValue)
            ? languagesValue.filter((v): v is string => typeof v === 'string')
            : [];
        languageServers[lsId] = {
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
        icon_themes: iconThemes,
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
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx install '))} ${color.blue('Installing as a Zed dev extension…')}`,
    );

    const tomlPath = path.join(callerDir, 'extension.toml');
    if (!(await fs.pathExists(tomlPath))) {
        p.log.error(color.red('No extension.toml found. Run zedx from an extension directory.'));
        process.exit(1);
    }

    const tomlContent = await fs.readFile(tomlPath, 'utf-8');
    let toml: TomlTable;
    try {
        toml = parseToml(tomlContent) as TomlTable;
    } catch (err) {
        const message = err instanceof TomlError ? err.message : String(err);
        p.log.error(color.red(`extension.toml is not valid TOML: ${message}`));
        process.exit(1);
    }

    const extensionId = tomlString(toml, 'id');
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

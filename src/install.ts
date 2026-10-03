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

// Zed compiles grammars and Rust code itself when a dev extension is installed
// from its UI. zedx only links the directory, so report what still needs a build.
async function findUnbuiltParts(extensionDir: string, toml: TomlTable): Promise<string[]> {
    const unbuilt: string[] = [];

    const grammarsTable = (toml['grammars'] as TomlTable | undefined) ?? {};
    for (const grammarId of Object.keys(grammarsTable)) {
        const wasmPath = path.join(extensionDir, 'grammars', `${grammarId}.wasm`);
        if (!(await fs.pathExists(wasmPath))) unbuilt.push(`grammar "${grammarId}"`);
    }

    const hasRust = await fs.pathExists(path.join(extensionDir, 'Cargo.toml'));
    if (hasRust && !(await fs.pathExists(path.join(extensionDir, 'extension.wasm')))) {
        unbuilt.push('Rust code');
    }

    return unbuilt;
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

    // Zed builds the index entry from extension.toml itself, and rebuilds
    // index.json whenever installed/ is newer than it. Bump the mtime so that
    // also happens when the symlink was already in place.
    const now = new Date();
    await fs.utimes(installedDir, now, now);

    const unbuilt = await findUnbuiltParts(callerDir, toml);
    if (unbuilt.length > 0) {
        p.log.warn(
            `${color.yellow('Not compiled yet:')} ${unbuilt.join(', ')}\n` +
                `  zedx only links the extension. Use ${color.white('Extensions > Install Dev Extension')} in Zed to compile it.`,
        );
    }

    const name = tomlString(toml, 'name') ?? extensionId;
    const version = tomlString(toml, 'version') ?? '0.0.1';

    p.outro(
        `${color.green('✓')} ${color.bold(`${name} v${version}`)} linked as a dev extension.\n\n` +
            `  ${color.dim('Zed indexes the extension itself. Restart Zed if it does not show up.')}\n\n` +
            `  ${color.dim('Run')} ${color.cyan('zedx check')} ${color.dim('to validate your extension.')}`,
    );
}

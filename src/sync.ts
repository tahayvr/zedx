import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import fs from 'fs-extra';
import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from 'jsonc-parser';
import color from 'picocolors';
import simpleGit from 'simple-git';

import type { SyncConfig, ConflictStrategy } from './types/index.js';
import { resolveZedPaths } from './zed-paths.js';

const ZEDX_CONFIG_DIR = path.join(os.homedir(), '.config', 'zedx');
const ZEDX_CONFIG_PATH = path.join(ZEDX_CONFIG_DIR, 'config.json');

// Config helpers
interface PersistedConfig extends SyncConfig {
    lastSync?: string; // ISO timestamp of the last successful sync
}

async function readSyncConfig(): Promise<PersistedConfig | null> {
    if (!(await fs.pathExists(ZEDX_CONFIG_PATH))) {
        return null;
    }
    return fs.readJson(ZEDX_CONFIG_PATH) as Promise<PersistedConfig>;
}

async function requireSyncConfig(): Promise<PersistedConfig> {
    const config = await readSyncConfig();
    if (!config) {
        p.log.error(
            color.red('No sync config found. Run ') +
                color.cyan('zedx sync init') +
                color.red(' first.'),
        );
        process.exit(1);
    }
    return config;
}

async function writeSyncConfig(config: PersistedConfig): Promise<void> {
    await fs.ensureDir(ZEDX_CONFIG_DIR);
    await fs.writeJson(ZEDX_CONFIG_PATH, config, { spaces: 4 });
}

// Temp dir helper
async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zedx-sync-'));
    try {
        return await fn(tmp);
    } finally {
        await fs.remove(tmp);
    }
}

// Detect indentation from a JSONC source so edits match the surrounding file.
// Falls back to two-space indent (Zed's default for settings.json).
export function detectIndent(src: string): FormattingOptions {
    const match = src.match(/^([ \t]+)\S/m);
    if (!match) return { insertSpaces: true, tabSize: 2 };
    const ws = match[1];
    if (ws.startsWith('\t')) return { insertSpaces: false, tabSize: 1 };
    return { insertSpaces: true, tabSize: ws.length };
}

// Pure decision matrix for what to do with a single tracked file, given its
// local/remote existence and (when both exist) content + mtime state. Kept
// side-effect free so the branching logic can be tested without spinning up
// real git repos or the filesystem.
export type FileSyncDecision =
    | 'both-missing'
    | 'push-new'
    | 'pull-new'
    | 'in-sync'
    | 'push-local-newer'
    | 'pull-remote-newer'
    | 'conflict';

export function decideFileSync(params: {
    localExists: boolean;
    remoteFileExists: boolean;
    contentsEqual: boolean;
    localMtime: Date;
    remoteMtime: Date;
    lastSync: Date | null;
}): FileSyncDecision {
    const { localExists, remoteFileExists, contentsEqual, localMtime, remoteMtime, lastSync } =
        params;

    if (!localExists && !remoteFileExists) return 'both-missing';
    if (localExists && !remoteFileExists) return 'push-new';
    if (!localExists && remoteFileExists) return 'pull-new';
    if (contentsEqual) return 'in-sync';

    // No lastSync (first sync) means both sides are treated as changed,
    // which — when both exist and differ — falls through to 'conflict'.
    const localChanged = !lastSync || localMtime > lastSync;
    const remoteChanged = !lastSync || remoteMtime > lastSync;

    if (localChanged && !remoteChanged) return 'push-local-newer';
    if (remoteChanged && !localChanged) return 'pull-remote-newer';
    return 'conflict';
}

// Effective conflict-resolution strategy, given the persisted/CLI strategy and
// whether we're running unattended (daemon mode can't prompt).
export type ConflictResolution = 'local' | 'remote' | 'ask';

export function resolveConflictStrategy(
    conflict: ConflictStrategy,
    silent: boolean,
): ConflictResolution {
    if (conflict === 'local' || conflict === 'remote') return conflict;
    if (silent) return 'local';
    return 'ask';
}

// Reconcile auto_install_extensions in settings.json against the live
// extensions/index.json so that:
//   - newly installed extensions (present in index, missing from the list) are added as true
//   - uninstalled extensions (absent from index, set to true in the list) are removed
//   - entries explicitly set to false by the user are always preserved (user intent)
//
// Uses jsonc-parser to edit in place, so existing comments and formatting in
// settings.json are preserved across reconciles.
export async function reconcileAutoInstallExtensions(
    localSettingsPath: string,
    localExtensionsIndexPath: string,
    silent = false,
): Promise<void> {
    if (!(await fs.pathExists(localExtensionsIndexPath))) return;
    if (!(await fs.pathExists(localSettingsPath))) return;

    const raw = await fs.readFile(localSettingsPath, 'utf-8');
    const errors: ParseError[] = [];
    const parsed = parse(raw, errors, { allowTrailingComma: true, allowEmptyContent: true });
    if (errors.length > 0 || (parsed !== undefined && typeof parsed !== 'object')) {
        if (!silent)
            p.log.warn(
                color.yellow('Could not parse settings.json — skipping extension reconciliation.'),
            );
        return;
    }
    const settingsObj = (parsed ?? {}) as Record<string, unknown>;

    let installedIds: string[] = [];
    try {
        const indexJson = (await fs.readJson(localExtensionsIndexPath)) as {
            extensions?: Record<string, { dev?: boolean }>;
        };
        installedIds = Object.keys(indexJson.extensions ?? {}).filter(
            id => !indexJson.extensions![id]?.dev,
        );
    } catch {
        if (!silent)
            p.log.warn(
                color.yellow(
                    'Could not parse extensions/index.json — skipping extension reconciliation.',
                ),
            );
        return;
    }

    const existing =
        typeof settingsObj['auto_install_extensions'] === 'object' &&
        settingsObj['auto_install_extensions'] !== null
            ? (settingsObj['auto_install_extensions'] as Record<string, boolean>)
            : {};

    const installedSet = new Set(installedIds);
    const reconciled: Record<string, boolean> = {};

    // Keep all explicit false entries (user said "never install this")
    for (const [id, val] of Object.entries(existing)) {
        if (val === false) reconciled[id] = false;
    }
    // Add every currently installed extension as true
    for (const id of installedIds) {
        reconciled[id] = true;
    }

    const added = installedIds.filter(id => !(id in existing));
    const removed = Object.keys(existing).filter(
        id => existing[id] === true && !installedSet.has(id),
    );

    if (added.length === 0 && removed.length === 0) return;

    const formattingOptions = detectIndent(raw);
    const edits = modify(raw, ['auto_install_extensions'], reconciled, { formattingOptions });
    const next = applyEdits(raw, edits);

    await fs.ensureDir(path.dirname(localSettingsPath));
    await fs.writeFile(localSettingsPath, next, 'utf-8');

    if (!silent) {
        if (added.length > 0)
            p.log.info(
                `Added ${color.cyan(String(added.length))} new extension(s) to ${color.dim('auto_install_extensions')}: ${added.join(', ')}`,
            );
        if (removed.length > 0)
            p.log.info(
                `Removed ${color.cyan(String(removed.length))} uninstalled extension(s) from ${color.dim('auto_install_extensions')}: ${removed.join(', ')}`,
            );
    }
}

// zedx sync status
export async function syncStatus(): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx sync status '))} ${color.blue('Checking sync state…')}`,
    );

    const config = await requireSyncConfig();
    const zedPaths = resolveZedPaths();

    p.log.info(`Repo:   ${color.dim(config.syncRepo)} ${color.dim(`(${config.branch})`)}`);
    if (config.lastSync) {
        p.log.info(`Last sync: ${color.dim(new Date(config.lastSync).toLocaleString())}`);
    } else {
        p.log.info(`Last sync: ${color.dim('never')}`);
    }

    const spinner = p.spinner();

    await withTempDir(async tmp => {
        spinner.start(`Fetching ${config.syncRepo}...`);
        let remoteExists = true;
        try {
            const git = simpleGit(tmp);
            await git.clone(config.syncRepo, tmp, ['--branch', config.branch]);
            spinner.stop('Remote fetched.');
        } catch {
            remoteExists = false;
            spinner.stop(color.yellow('Remote is empty or branch not found.'));
        }

        const files: Array<{ repoPath: string; localPath: string; label: string }> = [
            {
                repoPath: path.join(tmp, 'settings.json'),
                localPath: zedPaths.settings,
                label: 'Settings',
            },
            {
                repoPath: path.join(tmp, 'keymap.json'),
                localPath: zedPaths.keymap,
                label: 'Key bindings',
            },
            {
                repoPath: path.join(tmp, 'tasks.json'),
                localPath: zedPaths.tasks,
                label: 'Tasks',
            },
        ];

        // Track per-file actions needed for the outro message
        const toPush: string[] = [];
        const toPull: string[] = [];
        const toResolve: string[] = [];

        for (const file of files) {
            const localExists = await fs.pathExists(file.localPath);
            const remoteFileExists = remoteExists && (await fs.pathExists(file.repoPath));

            if (!localExists && !remoteFileExists) {
                p.log.warn(`${color.bold(file.label)}: not found locally or remotely`);
                continue;
            }

            if (localExists && !remoteFileExists) {
                p.log.warn(
                    `${color.bold(file.label)}: ${color.green('local only')} — not pushed yet`,
                );
                toPush.push(file.label);
                continue;
            }

            if (!localExists && remoteFileExists) {
                p.log.warn(
                    `${color.bold(file.label)}: ${color.cyan('remote only')} — not pulled yet`,
                );
                toPull.push(file.label);
                continue;
            }

            const localContent = await fs.readFile(file.localPath, 'utf-8');
            const remoteContent = await fs.readFile(file.repoPath, 'utf-8');

            if (localContent === remoteContent) {
                p.log.success(`${color.bold(file.label)}: in sync`);
                continue;
            }

            const localMtime = (await fs.stat(file.localPath)).mtime;
            const remoteMtime = (await fs.stat(file.repoPath)).mtime;
            const lastSync = config.lastSync ? new Date(config.lastSync) : null;
            const localChanged = !lastSync || localMtime > lastSync;
            const remoteChanged = !lastSync || remoteMtime > lastSync;

            if (localChanged && !remoteChanged) {
                p.log.warn(
                    `${color.bold(file.label)}: ${color.green('local ahead')} — modified ${color.dim(localMtime.toLocaleString())}`,
                );
                toPush.push(file.label);
            } else if (remoteChanged && !localChanged) {
                p.log.warn(
                    `${color.bold(file.label)}: ${color.cyan('remote ahead')} — modified ${color.dim(remoteMtime.toLocaleString())}`,
                );
                toPull.push(file.label);
            } else {
                p.log.warn(
                    `${color.bold(file.label)}: ${color.yellow('conflict')} — both changed since last sync`,
                );
                toResolve.push(file.label);
            }
        }

        const singleAction = [toPush, toPull, toResolve].filter(a => a.length > 0).length === 1;
        const needsSync = toPush.length > 0 || toPull.length > 0 || toResolve.length > 0;

        if (needsSync) {
            if (singleAction && toPush.length > 0) {
                p.outro(
                    `Run ${color.cyan('zedx sync')} to push ${toPush.map(l => color.bold(l)).join(', ')} to remote.`,
                );
            } else if (singleAction && toPull.length > 0) {
                p.outro(
                    `Run ${color.cyan('zedx sync')} to pull ${toPull.map(l => color.bold(l)).join(', ')} from remote.`,
                );
            } else {
                p.outro(`Run ${color.cyan('zedx sync')} to resolve.`);
            }
        } else {
            p.outro('Everything is in sync.');
        }
    });
}

// zedx sync init
export async function syncInit(): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx sync init '))} ${color.blue('Linking a git repo as the sync target…')}`,
    );

    const existing = await readSyncConfig();
    if (existing) {
        p.log.warn(
            `Sync is already configured.\n\n` +
                `  Repo:   ${color.cyan(existing.syncRepo)}\n` +
                `  Branch: ${color.cyan(existing.branch)}\n\n` +
                `  Run ${color.cyan('zedx config')} to make changes.`,
        );
        process.exit(0);
    }

    const repo = await p.text({
        message: 'Git repo URL (SSH or HTTPS)',
        placeholder: 'https://github.com/you/zed-config.git',
        validate: v => {
            if (!v.trim()) return 'Repo URL is required';
            if (!v.startsWith('https://') && !v.startsWith('git@')) {
                return 'Must be a valid HTTPS or SSH git URL';
            }
        },
    });

    if (p.isCancel(repo)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const branch = await p.text({
        message: 'Branch name',
        placeholder: 'main',
        defaultValue: 'main',
    });

    if (p.isCancel(branch)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const spinner = p.spinner();
    spinner.start('Verifying repo is reachable...');

    try {
        const git = simpleGit();
        await Promise.race([
            git.listRemote(['--heads', repo as string]),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 8000)),
        ]);
        spinner.stop('Repo verified.');
    } catch {
        spinner.stop(color.red('Could not reach repo. Check the URL and your credentials.'));
        process.exit(1);
    }

    const config: PersistedConfig = {
        syncRepo: (repo as string).trim(),
        branch: ((branch as string) || 'main').trim(),
        conflictStrategy: 'ask',
    };

    await writeSyncConfig(config);

    p.outro(
        `${color.green('✓')} Sync config saved to ${color.cyan(ZEDX_CONFIG_PATH)}\n\n` +
            `  Run ${color.cyan('zedx sync')} to sync your Zed config.`,
    );
}

export type { ConflictStrategy } from './types/index.js';

// zedx sync select
export async function syncSelect(): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx sync select '))} ${color.blue('Choose which files to sync…')}`,
    );

    await requireSyncConfig();

    const allFiles: Array<{ value: string; label: string; hint: string }> = [
        {
            value: 'settings',
            label: 'Settings',
            hint: 'settings.json',
        },
        {
            value: 'keymap',
            label: 'Key bindings',
            hint: 'keymap.json',
        },
        {
            value: 'tasks',
            label: 'Tasks',
            hint: 'tasks.json',
        },
    ];

    const selected = await p.multiselect({
        message: 'Select files to sync',
        options: allFiles,
        required: true,
    });

    if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const selectedFiles = selected as string[];

    await runSync({ selectedFiles });
}

// zedx sync
export async function runSync(
    opts: { silent?: boolean; conflict?: ConflictStrategy; selectedFiles?: string[] } = {},
): Promise<void> {
    const { silent = false, selectedFiles } = opts;

    const config = await requireSyncConfig();

    // Conflict priority: explicit CLI flag > persisted config > default (ask)
    const conflict: ConflictStrategy = opts.conflict ?? config.conflictStrategy ?? 'ask';

    // In silent mode (daemon/watch), route all UI through plain console.log
    // Interactive conflict prompts fall back to "local wins".
    const log = {
        info: (msg: string) => {
            if (!silent) p.log.info(msg);
        },
        warn: (msg: string) => {
            if (!silent) p.log.warn(msg);
            else console.error(`[zedx] warn: ${msg}`);
        },
        success: (msg: string) => {
            if (!silent) p.log.success(msg);
        },
    };

    if (!silent) {
        console.log('');
        p.intro(`${color.bgBlue(color.bold(' zedx sync '))} ${color.blue('Syncing Zed config…')}`);
    }

    const zedPaths = resolveZedPaths();

    // Spinner shim: in silent mode just log to stderr so daemons can capture it
    const spinner = silent
        ? {
              start: (m: string) => console.error(`[zedx] ${m}`),
              stop: (m: string) => console.error(`[zedx] ${m}`),
          }
        : p.spinner();

    await withTempDir(async tmp => {
        // 1. Clone the remote repo
        const git = simpleGit(tmp);
        let remoteExists = true;

        spinner.start(`Fetching ${config.syncRepo}...`);
        try {
            await git.clone(config.syncRepo, tmp, ['--branch', config.branch]);
            spinner.stop('Remote fetched.');
        } catch {
            remoteExists = false;
            spinner.stop('Remote is empty or branch not found — will push fresh.');
            await git.init();
            await git.addRemote('origin', config.syncRepo);
        }

        // 2. Determine what changed for each file
        const lastSync = config.lastSync ? new Date(config.lastSync) : null;

        const allFiles: Array<{ repoPath: string; localPath: string; label: string; key: string }> =
            [
                {
                    key: 'settings',
                    repoPath: path.join(tmp, 'settings.json'),
                    localPath: zedPaths.settings,
                    label: 'Settings',
                },
                {
                    key: 'keymap',
                    repoPath: path.join(tmp, 'keymap.json'),
                    localPath: zedPaths.keymap,
                    label: 'Key bindings',
                },
                {
                    key: 'tasks',
                    repoPath: path.join(tmp, 'tasks.json'),
                    localPath: zedPaths.tasks,
                    label: 'Tasks',
                },
            ];

        const files = selectedFiles
            ? allFiles.filter(f => selectedFiles.includes(f.key))
            : allFiles;

        let anyChanges = false;

        for (const file of files) {
            const localExists = await fs.pathExists(file.localPath);
            const remoteFileExists = remoteExists && (await fs.pathExists(file.repoPath));

            // Reconcile auto_install_extensions before content comparison so newly
            // installed/uninstalled extensions show up as drift and follow the normal
            // push path, rather than being swallowed by the "already in sync" check.
            // Gated on the extensions index mtime so most syncs skip the parse entirely.
            if (file.key === 'settings' && localExists) {
                const indexStat = await fs.stat(zedPaths.extensionsIndex).catch(() => null);
                if (!lastSync || (indexStat && indexStat.mtime > lastSync)) {
                    await reconcileAutoInstallExtensions(
                        file.localPath,
                        zedPaths.extensionsIndex,
                        silent,
                    );
                }
            }

            // Both exist — compare content and mtimes up front so the decision
            // matrix (decideFileSync) has everything it needs.
            let contentsEqual = false;
            let localMtime = new Date(0);
            let remoteMtime = new Date(0);

            if (localExists && remoteFileExists) {
                const localContent = await fs.readFile(file.localPath, 'utf-8');
                const remoteContent = await fs.readFile(file.repoPath, 'utf-8');
                contentsEqual = localContent === remoteContent;

                if (!contentsEqual) {
                    // Use local mtime for local file, and the git commit timestamp for
                    // the remote file — the temp dir mtime is just when git checked it
                    // out, not when it was actually changed, so it can't be used for
                    // comparison.
                    localMtime = (await fs.stat(file.localPath)).mtime;
                    if (remoteExists) {
                        try {
                            const gitLog = await git.log({
                                file: path.basename(file.repoPath),
                                maxCount: 1,
                                format: { date: '%cI' },
                            });
                            if (gitLog.latest?.date) remoteMtime = new Date(gitLog.latest.date);
                        } catch {
                            // fall back to epoch — remote will appear unchanged
                        }
                    }
                }
            }

            const decision = decideFileSync({
                localExists,
                remoteFileExists,
                contentsEqual,
                localMtime,
                remoteMtime,
                lastSync,
            });

            if (decision === 'both-missing') {
                log.warn(`${file.label}: not found locally or remotely — skipping.`);
                continue;
            }

            if (decision === 'push-new') {
                log.info(`${file.label}: ${color.green('pushing')} (not in remote yet)`);
                await fs.ensureDir(path.dirname(file.repoPath));
                await fs.copy(file.localPath, file.repoPath, { overwrite: true });
                anyChanges = true;
                continue;
            }

            if (decision === 'pull-new') {
                log.info(`${file.label}: ${color.cyan('pulling')} (not found locally)`);
                if (await fs.pathExists(file.localPath)) {
                    await fs.copy(file.localPath, file.localPath + '.bak', { overwrite: true });
                    if (!silent)
                        p.log.info(`Backed up settings to ${color.dim(file.localPath + '.bak')}`);
                }
                await fs.ensureDir(path.dirname(file.localPath));
                await fs.copy(file.repoPath, file.localPath, { overwrite: true });
                continue;
            }

            if (decision === 'in-sync') {
                log.success(`${file.label}: ${color.dim('already in sync')}`);
                continue;
            }

            if (decision === 'push-local-newer') {
                log.info(`${file.label}: ${color.green('pushing')} (local is newer)`);
                await fs.ensureDir(path.dirname(file.repoPath));
                await fs.copy(file.localPath, file.repoPath, { overwrite: true });
                anyChanges = true;
                continue;
            }

            if (decision === 'pull-remote-newer') {
                log.info(`${file.label}: ${color.cyan('pulling')} (remote is newer)`);
                await fs.copy(file.localPath, file.localPath + '.bak', { overwrite: true });
                if (!silent)
                    p.log.info(`Backed up settings to ${color.dim(file.localPath + '.bak')}`);
                await fs.copy(file.repoPath, file.localPath, { overwrite: true });
                continue;
            }

            // decision === 'conflict' — resolve based on strategy
            const strategy = resolveConflictStrategy(conflict, silent);
            let resolution: 'local' | 'remote';

            if (strategy === 'local' || strategy === 'remote') {
                resolution = strategy;
                if (conflict === 'local' || conflict === 'remote') {
                    log.warn(
                        `${file.label}: conflict — using ${color.bold(resolution)} (--${resolution} flag).`,
                    );
                } else {
                    log.warn(
                        `${file.label}: conflict detected in unattended mode — keeping local.`,
                    );
                }
            } else {
                p.log.warn(color.yellow(`conflict between local and remote ${file.label}`));

                const choice = await p.select({
                    message: `Which version of ${color.bold(file.label)} should win?`,
                    options: [
                        {
                            value: 'local',
                            label: 'Keep local',
                            hint: `modified ${localMtime.toLocaleString()}`,
                        },
                        {
                            value: 'remote',
                            label: 'Use remote',
                            hint: `modified ${remoteMtime.toLocaleString()}`,
                        },
                    ],
                });

                if (p.isCancel(choice)) {
                    p.cancel('Cancelled.');
                    process.exit(0);
                }

                resolution = choice as 'local' | 'remote';
            }

            if (resolution === 'local') {
                if (!silent && conflict === 'ask')
                    p.log.info(`${file.label}: ${color.green('keeping local, will push')}`);
                await fs.ensureDir(path.dirname(file.repoPath));
                await fs.copy(file.localPath, file.repoPath, { overwrite: true });
                anyChanges = true;
            } else {
                if (!silent && conflict === 'ask')
                    p.log.info(`${file.label}: ${color.cyan('applying remote')}`);
                await fs.copy(file.localPath, file.localPath + '.bak', { overwrite: true });
                if (!silent)
                    p.log.info(`Backed up settings to ${color.dim(file.localPath + '.bak')}`);
                await fs.copy(file.repoPath, file.localPath, { overwrite: true });
            }
        }

        // 3. Commit + push if any local files were written to the repo
        if (anyChanges) {
            spinner.start('Pushing changes to remote...');
            try {
                await git.add(files.map(f => path.basename(f.repoPath)));

                const status = await git.status();
                if (status.staged.length > 0) {
                    if (!(await git.raw(['config', 'user.name']).catch(() => ''))) {
                        await git.addConfig('user.name', 'zedx');
                    }
                    if (!(await git.raw(['config', 'user.email']).catch(() => ''))) {
                        await git.addConfig('user.email', 'zedx@localhost');
                    }

                    const timestamp = new Date().toISOString();
                    await git.commit(`sync: ${timestamp}`);
                    try {
                        await git.push('origin', config.branch, ['--set-upstream']);
                    } catch {
                        await git.push('origin', config.branch);
                    }
                    spinner.stop('Pushed.');
                } else {
                    spinner.stop('Nothing staged to push.');
                }
            } catch (err) {
                spinner.stop(color.red('Failed to push changes.'));
                const message = err instanceof Error ? err.message : String(err);
                if (silent) {
                    console.error(`[zedx] error: ${message}`);
                } else {
                    p.log.error(color.red(message));
                }
                throw err;
            }
        }
    });

    // 4. Save last sync timestamp
    await writeSyncConfig({ ...config, lastSync: new Date().toISOString() });

    if (!silent) p.outro(`${color.green('✓')} Sync complete.`);
}

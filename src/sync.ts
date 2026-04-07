import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import fs from 'fs-extra';
import color from 'picocolors';
import simpleGit from 'simple-git';

import type { SyncConfig } from './types/index.js';
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

// Prepare settings.json for pushing to the repo by stripping auto_install_extensions.
// That field is derived from extensions/index.json on pull, so storing it in the
// remote would create stale/conflicting data across machines.
async function prepareSettingsForPush(
    localSettingsPath: string,
    repoSettingsPath: string,
): Promise<void> {
    const raw = await fs.readFile(localSettingsPath, 'utf-8');
    const stripped = raw.replace(/\/\/[^\n]*/g, '');
    let settingsObj: Record<string, unknown> = {};
    try {
        settingsObj = JSON.parse(stripped);
    } catch {
        // If we can't parse it (e.g. complex comments), push as-is
        await fs.ensureDir(path.dirname(repoSettingsPath));
        await fs.copy(localSettingsPath, repoSettingsPath, { overwrite: true });
        return;
    }
    delete settingsObj['auto_install_extensions'];
    await fs.ensureDir(path.dirname(repoSettingsPath));
    await fs.writeFile(repoSettingsPath, JSON.stringify(settingsObj, null, 4), 'utf-8');
}

// Extension merge helper
async function applyRemoteSettings(
    repoSettings: string,
    repoExtensions: string,
    localSettingsPath: string,
    silent = false,
): Promise<void> {
    // Backup existing settings
    if (await fs.pathExists(localSettingsPath)) {
        await fs.copy(localSettingsPath, localSettingsPath + '.bak', { overwrite: true });
        if (!silent) p.log.info(`Backed up settings to ${color.dim(localSettingsPath + '.bak')}`);
    }

    let settingsJson = await fs.readFile(repoSettings, 'utf-8');

    // Merge auto_install_extensions from index.json into settings
    if (await fs.pathExists(repoExtensions)) {
        try {
            const indexJson = (await fs.readJson(repoExtensions)) as {
                extensions?: Record<string, { dev?: boolean }>;
            };

            const extensionIds = Object.keys(indexJson.extensions ?? {}).filter(
                id => !indexJson.extensions![id]?.dev,
            );

            if (extensionIds.length > 0) {
                const stripped = settingsJson.replace(/\/\/[^\n]*/g, '');
                let settingsObj: Record<string, unknown> = {};
                try {
                    settingsObj = JSON.parse(stripped);
                } catch {
                    if (!silent)
                        p.log.warn(
                            color.yellow(
                                'Could not parse settings.json — skipping extension merge.',
                            ),
                        );
                }

                // Preserve any existing entries (e.g. false entries for "never install"),
                // then add true for every extension recorded in index.json.
                const existing =
                    typeof settingsObj['auto_install_extensions'] === 'object' &&
                    settingsObj['auto_install_extensions'] !== null
                        ? (settingsObj['auto_install_extensions'] as Record<string, boolean>)
                        : {};

                const autoInstall: Record<string, boolean> = { ...existing };
                for (const id of extensionIds) {
                    // Only set to true if there is no explicit user preference already
                    if (!(id in autoInstall)) {
                        autoInstall[id] = true;
                    }
                }
                settingsObj['auto_install_extensions'] = autoInstall;
                settingsJson = JSON.stringify(settingsObj, null, 4);

                if (!silent)
                    p.log.info(
                        `Injected ${color.cyan(String(extensionIds.length))} extension(s) into ${color.dim('auto_install_extensions')}`,
                    );
            }
        } catch {
            if (!silent)
                p.log.warn(
                    color.yellow(
                        'Could not parse extensions/index.json — skipping extension merge.',
                    ),
                );
        }
    }

    await fs.ensureDir(path.dirname(localSettingsPath));
    await fs.writeFile(localSettingsPath, settingsJson, 'utf-8');
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
            await git.clone(config.syncRepo, tmp, ['--depth', '1', '--branch', config.branch]);
            spinner.stop('Remote fetched.');
        } catch {
            remoteExists = false;
            spinner.stop(color.yellow('Remote is empty or branch not found.'));
        }

        const files: Array<{ repoPath: string; localPath: string; label: string }> = [
            {
                repoPath: path.join(tmp, 'settings.json'),
                localPath: zedPaths.settings,
                label: 'settings.json',
            },
            {
                repoPath: path.join(tmp, 'extensions', 'index.json'),
                localPath: zedPaths.extensions,
                label: 'extensions/index.json',
            },
        ];

        let needsSync = false;

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
                needsSync = true;
                continue;
            }

            if (!localExists && remoteFileExists) {
                p.log.warn(
                    `${color.bold(file.label)}: ${color.cyan('remote only')} — not pulled yet`,
                );
                needsSync = true;
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
            } else if (remoteChanged && !localChanged) {
                p.log.warn(
                    `${color.bold(file.label)}: ${color.cyan('remote ahead')} — modified ${color.dim(remoteMtime.toLocaleString())}`,
                );
            } else {
                p.log.warn(
                    `${color.bold(file.label)}: ${color.yellow('conflict')} — both changed since last sync`,
                );
            }
            needsSync = true;
        }

        if (needsSync) {
            p.outro(`Run ${color.cyan('zedx sync')} to resolve.`);
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

    const repo = await p.text({
        message: 'GitHub repo URL (SSH or HTTPS)',
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
        await git.listRemote(['--heads', repo as string]);
        spinner.stop('Repo verified.');
    } catch {
        spinner.stop(
            color.yellow('Could not verify repo (may be empty or private — continuing anyway).'),
        );
    }

    const config: PersistedConfig = {
        syncRepo: (repo as string).trim(),
        branch: ((branch as string) || 'main').trim(),
    };

    await writeSyncConfig(config);

    p.outro(
        `${color.green('✓')} Sync config saved to ${color.cyan(ZEDX_CONFIG_PATH)}\n\n` +
            `  Run ${color.cyan('zedx sync')} to sync your Zed config.`,
    );
}

export type ConflictStrategy = 'local' | 'remote' | 'prompt';

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
            label: 'settings.json',
            hint: 'Zed editor settings',
        },
        {
            value: 'extensions',
            label: 'extensions/index.json',
            hint: 'Installed extensions list',
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
    const { silent = false, conflict = 'prompt', selectedFiles } = opts;

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
        p.intro(
            `${color.bgBlue(color.bold(' zedx sync '))} ${color.blue('Syncing Zed settings and extensions…')}`,
        );
    }

    const config = await requireSyncConfig();
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
            await git.clone(config.syncRepo, tmp, ['--depth', '1', '--branch', config.branch]);
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
                    label: 'settings.json',
                },
                {
                    key: 'extensions',
                    repoPath: path.join(tmp, 'extensions', 'index.json'),
                    localPath: zedPaths.extensions,
                    label: 'extensions/index.json',
                },
            ];

        const files = selectedFiles
            ? allFiles.filter(f => selectedFiles.includes(f.key))
            : allFiles;

        let anyChanges = false;

        for (const file of files) {
            const localExists = await fs.pathExists(file.localPath);
            const remoteFileExists = remoteExists && (await fs.pathExists(file.repoPath));

            // Both missing — skip
            if (!localExists && !remoteFileExists) {
                log.warn(`${file.label}: not found locally or remotely — skipping.`);
                continue;
            }

            // Remote doesn't have it yet — push local
            if (localExists && !remoteFileExists) {
                log.info(`${file.label}: ${color.green('pushing')} (not in remote yet)`);
                if (file.label === 'settings.json') {
                    await prepareSettingsForPush(file.localPath, file.repoPath);
                } else {
                    await fs.ensureDir(path.dirname(file.repoPath));
                    await fs.copy(file.localPath, file.repoPath, { overwrite: true });
                }
                anyChanges = true;
                continue;
            }

            // Local doesn't have it — pull remote
            if (!localExists && remoteFileExists) {
                log.info(`${file.label}: ${color.cyan('pulling')} (not found locally)`);
                if (file.label === 'settings.json') {
                    await applyRemoteSettings(
                        file.repoPath,
                        path.join(tmp, 'extensions', 'index.json'),
                        file.localPath,
                        silent,
                    );
                } else {
                    await fs.ensureDir(path.dirname(file.localPath));
                    await fs.copy(file.repoPath, file.localPath, { overwrite: true });
                }
                continue;
            }

            // Both exist — compare content
            const localContent = await fs.readFile(file.localPath, 'utf-8');
            const remoteContent = await fs.readFile(file.repoPath, 'utf-8');

            if (localContent === remoteContent) {
                log.success(`${file.label}: ${color.dim('already in sync')}`);
                continue;
            }

            // Detect which side changed since last sync via mtime
            const localMtime = (await fs.stat(file.localPath)).mtime;
            const remoteMtime = remoteFileExists
                ? (await fs.stat(file.repoPath)).mtime
                : new Date(0);

            const localChanged = !lastSync || localMtime > lastSync;
            const remoteChanged = !lastSync || remoteMtime > lastSync;

            if (localChanged && !remoteChanged) {
                // Only local changed → push
                log.info(`${file.label}: ${color.green('pushing')} (local is newer)`);
                if (file.label === 'settings.json') {
                    await prepareSettingsForPush(file.localPath, file.repoPath);
                } else {
                    await fs.ensureDir(path.dirname(file.repoPath));
                    await fs.copy(file.localPath, file.repoPath, { overwrite: true });
                }
                anyChanges = true;
            } else if (remoteChanged && !localChanged) {
                // Only remote changed → pull
                log.info(`${file.label}: ${color.cyan('pulling')} (remote is newer)`);
                if (file.label === 'settings.json') {
                    await applyRemoteSettings(
                        file.repoPath,
                        path.join(tmp, 'extensions', 'index.json'),
                        file.localPath,
                        silent,
                    );
                } else {
                    await fs.ensureDir(path.dirname(file.localPath));
                    await fs.copy(file.repoPath, file.localPath, { overwrite: true });
                }
            } else {
                // Both changed — resolve based on strategy
                // Determine the effective resolution:
                //   - explicit --local / --remote flag always wins
                //   - silent (daemon) mode falls back to local
                //   - otherwise prompt interactively
                let resolution: 'local' | 'remote';

                if (conflict === 'local' || conflict === 'remote') {
                    resolution = conflict;
                    log.warn(
                        `${file.label}: conflict — using ${color.bold(resolution)} (--${resolution} flag).`,
                    );
                } else if (silent) {
                    // Daemon can't prompt — local wins, will be pushed
                    resolution = 'local';
                    log.warn(
                        `${file.label}: conflict detected in unattended mode — keeping local.`,
                    );
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
                    if (!silent && conflict === 'prompt')
                        p.log.info(`${file.label}: ${color.green('keeping local, will push')}`);
                    if (file.label === 'settings.json') {
                        await prepareSettingsForPush(file.localPath, file.repoPath);
                    } else {
                        await fs.ensureDir(path.dirname(file.repoPath));
                        await fs.copy(file.localPath, file.repoPath, { overwrite: true });
                    }
                    anyChanges = true;
                } else {
                    if (!silent && conflict === 'prompt')
                        p.log.info(`${file.label}: ${color.cyan('applying remote')}`);
                    if (file.label === 'settings.json') {
                        await applyRemoteSettings(
                            file.repoPath,
                            path.join(tmp, 'extensions', 'index.json'),
                            file.localPath,
                            silent,
                        );
                    } else {
                        await fs.ensureDir(path.dirname(file.localPath));
                        await fs.copy(file.repoPath, file.localPath, { overwrite: true });
                    }
                }
            }
        }

        // 3. Commit + push if any local files were written to the repo
        if (anyChanges) {
            spinner.start('Pushing changes to remote...');
            await git.add(['settings.json', path.join('extensions', 'index.json')]);

            const status = await git.status();
            if (status.staged.length > 0) {
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
        }
    });

    // 4. Save last sync timestamp
    await writeSyncConfig({ ...config, lastSync: new Date().toISOString() });

    if (!silent) p.outro(`${color.green('✓')} Sync complete.`);
}

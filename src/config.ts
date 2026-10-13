import { spawnSync } from 'child_process';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import fs from 'fs-extra';
import color from 'picocolors';
import simpleGit from 'simple-git';

import { getAtPath, isPlainObject, listKeyPaths, parseJsonc, parseKeyPath } from './sync-merge.js';
import { SYNC_FILE_GROUPS, keymapRepoFile } from './sync.js';
import type { SyncConfig, ConflictStrategy } from './types/index.js';
import { resolveZedPaths } from './zed-paths.js';

const ZEDX_CONFIG_DIR = path.join(os.homedir(), '.config', 'zedx');
const ZEDX_CONFIG_PATH = path.join(ZEDX_CONFIG_DIR, 'config.json');

interface PersistedConfig extends SyncConfig {
    lastSync?: string;
}

async function readConfig(): Promise<PersistedConfig | null> {
    if (!(await fs.pathExists(ZEDX_CONFIG_PATH))) return null;
    return fs.readJson(ZEDX_CONFIG_PATH) as Promise<PersistedConfig>;
}

async function writeConfig(config: PersistedConfig): Promise<void> {
    await fs.ensureDir(ZEDX_CONFIG_DIR);
    await fs.writeJson(ZEDX_CONFIG_PATH, config, { spaces: 4 });
}

// zedx config conflict
export async function configConflict(direct?: ConflictStrategy): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx config conflict '))} ${color.blue('Set default conflict resolution strategy…')}`,
    );

    const existing = await readConfig();

    if (!existing) {
        p.log.error(
            color.red('No sync config found. Run ') +
                color.cyan('zedx sync init') +
                color.red(' first.'),
        );
        process.exit(1);
    }

    let strategy: ConflictStrategy;

    if (direct) {
        strategy = direct;
    } else {
        const selected = await p.select<ConflictStrategy>({
            message: 'When local and remote both changed, what should zedx sync do by default?',
            options: [
                {
                    value: 'ask',
                    label: 'Ask me each time',
                    hint: 'interactive prompt on every conflict',
                },
                {
                    value: 'local',
                    label: 'Keep local',
                    hint: 'local always wins, no prompt',
                },
                {
                    value: 'remote',
                    label: 'Use remote',
                    hint: 'remote always wins, no prompt',
                },
            ],
            initialValue: existing.conflictStrategy ?? 'ask',
        });

        if (p.isCancel(selected)) {
            p.cancel('Cancelled.');
            process.exit(0);
        }

        strategy = selected;
    }

    const updated: PersistedConfig = {
        ...existing,
        conflictStrategy: strategy,
    };

    await writeConfig(updated);

    p.outro(`${color.green('✓')} Default conflict strategy set to ${color.cyan(strategy)}.`);
}

// zedx config repo
export async function configRepo(): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx config repo '))} ${color.blue('Change your sync repo and branch…')}`,
    );

    const existing = await readConfig();

    const repo = await p.text({
        message: 'Git repo URL (SSH or HTTPS)',
        placeholder: 'https://github.com/you/zed-config.git',
        initialValue: existing?.syncRepo ?? '',
        validate: v => {
            if (!v?.trim()) return 'Repo URL is required';
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
        initialValue: existing?.branch ?? 'main',
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

    const updated: PersistedConfig = {
        ...existing,
        syncRepo: (repo as string).trim(),
        branch: ((branch as string) || 'main').trim(),
    };

    await writeConfig(updated);

    p.outro(
        `${color.green('✓')} Sync repo updated.\n\n` +
            `  Repo:   ${color.cyan(updated.syncRepo)}\n` +
            `  Branch: ${color.cyan(updated.branch)}`,
    );
}

// zedx config files
export async function configFiles(): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx config files '))} ${color.blue('Set default files to sync…')}`,
    );

    const existing = await readConfig();

    if (!existing) {
        p.log.error(
            color.red('No sync config found. Run ') +
                color.cyan('zedx sync init') +
                color.red(' first.'),
        );
        process.exit(1);
    }

    const selected = await p.multiselect({
        message: 'Which files should `zedx sync` touch by default?',
        options: SYNC_FILE_GROUPS,
        initialValues: existing.files ?? SYNC_FILE_GROUPS.map(g => g.value),
        required: true,
    });

    if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const updated: PersistedConfig = {
        ...existing,
        files: selected as string[],
    };

    await writeConfig(updated);

    p.outro(
        `${color.green('✓')} Default sync files set to ${color.cyan((selected as string[]).join(', '))}.\n\n` +
            `  ${color.dim('Use')} ${color.cyan('zedx sync select')} ${color.dim('for a one-off override.')}`,
    );
}

// zedx manages auto_install_extensions itself (it mirrors installed
// extensions on every sync), so it can't be kept per-machine.
const MANAGED_KEY = 'auto_install_extensions';

function isManagedKey(key: string): boolean {
    return parseKeyPath(key)[0] === MANAGED_KEY;
}

// Short hint showing a setting's current value next to its key.
function previewSetting(value: unknown): string {
    if (isPlainObject(value)) return '{…}';
    const text = JSON.stringify(value) ?? '';
    return text.length > 30 ? `${text.slice(0, 27)}...` : text;
}

// zedx config ignore
export async function configIgnore(): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx config ignore '))} ${color.blue('Keep settings keys per-machine…')}`,
    );

    const existing = await readConfig();

    if (!existing) {
        p.log.error(
            color.red('No sync config found. Run ') +
                color.cyan('zedx sync init') +
                color.red(' first.'),
        );
        process.exit(1);
    }

    const settingsPath = resolveZedPaths().settings;
    const settings = (await fs.pathExists(settingsPath))
        ? parseJsonc(await fs.readFile(settingsPath, 'utf-8'))
        : undefined;
    const settingsKeys = listKeyPaths(settings).filter(key => !isManagedKey(key));
    const current = (existing.ignoredSettings ?? []).filter(key => !isManagedKey(key));

    const selected = await p.autocompleteMultiselect<string>({
        message:
            'Which settings.json keys should stay per-machine? (none selected syncs everything)',
        placeholder: 'Type to search…',
        options: [
            ...current
                .filter(key => !settingsKeys.includes(key))
                .map(key => ({ value: key, label: key, hint: 'not set in settings.json' })),
            ...settingsKeys.map(key => ({
                value: key,
                label: key,
                hint: previewSetting(getAtPath(settings, parseKeyPath(key))),
            })),
        ],
        filter: (search, option) => option.value.toLowerCase().includes(search.toLowerCase()),
        initialValues: current,
        required: false,
        maxItems: 12,
    });

    if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const keys = selected;

    const { ignoredSettings: _previous, ...rest } = existing;
    const updated: PersistedConfig = keys.length > 0 ? { ...rest, ignoredSettings: keys } : rest;

    await writeConfig(updated);

    p.outro(
        keys.length > 0
            ? `${color.green('✓')} These settings.json keys now stay per-machine: ${color.cyan(keys.join(', '))}.`
            : `${color.green('✓')} No keys are ignored — settings.json syncs in full.`,
    );
}

export type KeymapMode = 'shared' | 'per-platform';

// zedx config keymap
export async function configKeymap(direct?: KeymapMode): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx config keymap '))} ${color.blue('Share or split keymaps across platforms…')}`,
    );

    const existing = await readConfig();

    if (!existing) {
        p.log.error(
            color.red('No sync config found. Run ') +
                color.cyan('zedx sync init') +
                color.red(' first.'),
        );
        process.exit(1);
    }

    let mode: KeymapMode;

    if (direct) {
        mode = direct;
    } else {
        const selected = await p.select<KeymapMode>({
            message: 'How should keymap.json sync between machines?',
            options: [
                {
                    value: 'shared',
                    label: 'One keymap for every machine',
                    hint: 'keymap.json',
                },
                {
                    value: 'per-platform',
                    label: 'One keymap per platform',
                    hint: `only syncs with machines on the same OS (${keymapRepoFile(true).name} here)`,
                },
            ],
            initialValue: existing.keymapPerPlatform ? 'per-platform' : 'shared',
        });

        if (p.isCancel(selected)) {
            p.cancel('Cancelled.');
            process.exit(0);
        }

        mode = selected;
    }

    const { keymapPerPlatform: _previous, ...rest } = existing;
    const updated: PersistedConfig =
        mode === 'per-platform' ? { ...rest, keymapPerPlatform: true } : rest;

    await writeConfig(updated);

    const repoFile = keymapRepoFile(mode === 'per-platform').name;
    p.outro(
        `${color.green('✓')} This machine now syncs its keymap as ${color.cyan(repoFile)} in the repo.\n\n` +
            `  ${color.dim('Set the same mode on your other machines so they sync the same file.')}`,
    );
}

// Launch Zed on a file, trying the `zed` CLI first and then the
// platform-specific fallbacks. Returns false when none could be started.
function openInZed(filePath: string): boolean {
    const candidates: [string, string[]][] = [['zed', [filePath]]];
    if (process.platform === 'darwin') candidates.push(['open', ['-a', 'Zed', filePath]]);
    if (process.platform === 'linux') candidates.push(['zeditor', [filePath]]);

    return candidates.some(([cmd, args]) => {
        const result = spawnSync(cmd, args, { stdio: 'ignore' });
        return !result.error && result.status === 0;
    });
}

// zedx config open
export async function configOpen(): Promise<void> {
    if (!(await fs.pathExists(ZEDX_CONFIG_PATH))) {
        p.log.error(
            color.red('No sync config found. Run ') +
                color.cyan('zedx sync init') +
                color.red(' first.'),
        );
        process.exit(1);
    }

    if (!openInZed(ZEDX_CONFIG_PATH)) {
        p.log.error(
            color.red('Could not open Zed. Make sure the ') +
                color.cyan('zed') +
                color.red(' CLI is installed (Zed → Install CLI).'),
        );
        p.log.info(`Config file: ${color.dim(ZEDX_CONFIG_PATH)}`);
        process.exit(1);
    }

    p.log.success(`Opened ${color.dim(ZEDX_CONFIG_PATH)} in Zed.`);
}

type ConfigOption = 'repo' | 'conflict' | 'files' | 'ignore' | 'keymap' | 'open';

// zedx config (interactive menu)
export async function runConfig(direct?: ConfigOption): Promise<void> {
    if (direct === 'repo') {
        await configRepo();
        return;
    }

    if (direct === 'conflict') {
        await configConflict();
        return;
    }

    if (direct === 'files') {
        await configFiles();
        return;
    }

    if (direct === 'ignore') {
        await configIgnore();
        return;
    }

    if (direct === 'keymap') {
        await configKeymap();
        return;
    }

    if (direct === 'open') {
        await configOpen();
        return;
    }

    console.log('');
    p.intro(`${color.bgBlue(color.bold(' zedx config '))} ${color.blue('Zedx settings')}`);

    const option = await p.select({
        message: 'What do you want to configure?',
        options: [
            {
                value: 'repo',
                label: 'Sync repo',
                hint: 'Change your git repo and branch for zedx sync',
            },
            {
                value: 'conflict',
                label: 'Conflict strategy',
                hint: 'What to do when local and remote both changed',
            },
            {
                value: 'files',
                label: 'Sync files',
                hint: 'Which files zedx sync touches by default',
            },
            {
                value: 'ignore',
                label: 'Per-machine settings',
                hint: 'settings.json keys that are never synced',
            },
            {
                value: 'keymap',
                label: 'Keymap per platform',
                hint: 'Share keymap.json everywhere or keep one per OS',
            },
            {
                value: 'open',
                label: 'Open config file',
                hint: 'Edit ~/.config/zedx/config.json in Zed',
            },
        ],
    });

    if (p.isCancel(option)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    if (option === 'repo') {
        await configRepo();
    } else if (option === 'conflict') {
        await configConflict();
    } else if (option === 'files') {
        await configFiles();
    } else if (option === 'ignore') {
        await configIgnore();
    } else if (option === 'keymap') {
        await configKeymap();
    } else if (option === 'open') {
        await configOpen();
    }
}

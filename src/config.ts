import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import fs from 'fs-extra';
import color from 'picocolors';
import simpleGit from 'simple-git';

import { parseJsonc, unsetKeys } from './sync-merge.js';
import { SYNC_FILE_GROUPS } from './sync.js';
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

    // No placeholder: clack submits the placeholder text when the answer is
    // left empty, which would make clearing the list impossible.
    const answer = await p.text({
        message: `settings.json keys to keep per-machine, comma-separated (e.g. ${color.dim('ui_font_size, terminal.font_size')}). Leave empty for none.`,
        initialValue: (existing.ignoredSettings ?? []).join(', '),
    });

    if (p.isCancel(answer)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const keys = [
        ...new Set(
            String(answer ?? '')
                .split(',')
                .map(key => key.trim())
                .filter(Boolean),
        ),
    ];

    if (keys.length > 0) {
        const settingsPath = resolveZedPaths().settings;
        const settingsSrc = (await fs.pathExists(settingsPath))
            ? await fs.readFile(settingsPath, 'utf-8')
            : '';
        const unset = unsetKeys(parseJsonc(settingsSrc), keys);
        if (unset.length > 0) {
            p.log.warn(
                `${color.yellow('Not set in your settings.json:')} ${color.cyan(unset.join(', '))}`,
            );
            const proceed = await p.confirm({
                message: 'Save these keys anyway?',
                initialValue: false,
            });
            if (p.isCancel(proceed) || !proceed) {
                p.cancel('Cancelled. Nothing was saved.');
                process.exit(0);
            }
        }
    }

    const { ignoredSettings: _previous, ...rest } = existing;
    const updated: PersistedConfig = keys.length > 0 ? { ...rest, ignoredSettings: keys } : rest;

    await writeConfig(updated);

    p.outro(
        keys.length > 0
            ? `${color.green('✓')} These settings.json keys now stay per-machine: ${color.cyan(keys.join(', '))}.`
            : `${color.green('✓')} No keys are ignored — settings.json syncs in full.`,
    );
}

type ConfigOption = 'repo' | 'conflict' | 'files' | 'ignore';

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
    }
}

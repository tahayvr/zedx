import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import fs from 'fs-extra';
import color from 'picocolors';
import simpleGit from 'simple-git';

import type { SyncConfig } from './types/index.js';

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
        await git.listRemote(['--heads', repo as string]);
        spinner.stop('Repo verified.');
    } catch {
        spinner.stop(
            color.yellow('Could not verify repo (may be empty or private — continuing anyway).'),
        );
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

type ConfigOption = 'repo';

// zedx config (interactive menu)
export async function runConfig(direct?: ConfigOption): Promise<void> {
    if (direct === 'repo') {
        await configRepo();
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
        ],
    });

    if (p.isCancel(option)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    if (option === 'repo') {
        await configRepo();
    }
}

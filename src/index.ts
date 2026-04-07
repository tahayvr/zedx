#!/usr/bin/env node

import { createRequire } from 'module';
import path from 'path';

import * as p from '@clack/prompts';
import { Command } from 'commander';
import fs from 'fs-extra';
import color from 'picocolors';

import { addTheme, addLanguage } from './add.js';
import { runCheck } from './check.js';
import { runConfig, configRepo, configConflict } from './config.js';
import { syncInstall, syncUninstall } from './daemon.js';
import { generateExtension } from './generator.js';
import { installDevExtension } from './install.js';
import { promptUser, promptThemeDetails, promptLanguageDetails } from './prompts.js';
import { addLsp } from './snippet.js';
import { syncInit, runSync, syncStatus, syncSelect } from './sync.js';
import type { ConflictStrategy } from './types/index.js';

const require = createRequire(import.meta.url);
const { version } = require('../package.json') as { version: string };

type BumpType = 'major' | 'minor' | 'patch';

function bumpVersion(version: string, type: BumpType): string {
    const [major, minor, patch] = version.split('.').map(Number);

    switch (type) {
        case 'major':
            return `${major + 1}.0.0`;
        case 'minor':
            return `${major}.${minor + 1}.0`;
        case 'patch':
            return `${major}.${minor}.${patch + 1}`;
    }
}

function getCallerDir(): string {
    return process.env.INIT_CWD || process.cwd();
}

async function bumpExtensionVersion(type: BumpType): Promise<void> {
    const callerDir = getCallerDir();
    const tomlPath = path.join(callerDir, 'extension.toml');

    if (!(await fs.pathExists(tomlPath))) {
        p.log.error(color.red('No extension.toml found in current directory.'));
        process.exit(1);
    }

    const content = await fs.readFile(tomlPath, 'utf-8');
    const versionMatch = content.match(/version\s*=\s*"(\d+\.\d+\.\d+)"/);

    if (!versionMatch) {
        p.log.error(color.red('Could not find version in extension.toml'));
        process.exit(1);
    }

    const currentVersion = versionMatch[1];
    const newVersion = bumpVersion(currentVersion, type);

    const newContent = content.replace(
        /version\s*=\s*"(\d+\.\d+\.\d+)"/,
        `version = "${newVersion}"`,
    );

    await fs.writeFile(tomlPath, newContent);

    p.log.success(color.green(`Bumped version from ${currentVersion} to ${newVersion}`));
}

function printWelcome(): void {
    const ascii = String.raw`
░        ░░        ░░       ░░░  ░░░░  ░
▒▒▒▒▒▒  ▒▒▒  ▒▒▒▒▒▒▒▒  ▒▒▒▒  ▒▒▒  ▒▒  ▒▒
▓▓▓▓  ▓▓▓▓▓      ▓▓▓▓  ▓▓▓▓  ▓▓▓▓    ▓▓▓
██  ███████  ████████  ████  ███  ██  ██
█        ██        ██       ███  ████  █
                                        
    `.trim();

    console.log('\n' + color.cyan(color.bold(ascii)) + '\n');
    console.log(color.bold('  The CLI toolkit for Zed Editor') + '\n');

    const syncCommands: [string, string][] = [
        ['zedx sync', 'Sync Zed settings via a git repo'],
        ['zedx sync init', 'Link a git repo as the sync target'],
        ['zedx sync select', 'Choose which files to sync interactively'],
        ['zedx sync status', 'Show sync state between local and remote'],
        ['zedx sync install', 'Install the OS daemon for auto-sync'],
        ['zedx sync uninstall', 'Remove the auto-sync daemon'],
        ['zedx config', 'Configure zedx settings'],
        ['zedx config repo', 'Change your sync repo and branch'],
        ['zedx config conflict', 'Set default conflict resolution strategy'],
    ];

    const extensionCommands: [string, string][] = [
        ['zedx create', 'Scaffold a new Zed extension'],
        ['zedx add theme <name>', 'Add a theme to an existing extension'],
        ['zedx add language <id>', 'Add a language to an existing extension'],
        ['zedx snippet add lsp', 'Wire up a language server into the extension'],
        ['zedx check', 'Validate your extension config'],
        ['zedx install', 'Install as a Zed dev extension'],
        ['zedx version <major|minor|patch>', 'Bump extension version'],
    ];

    const pad = 38;

    console.log(`  ${color.bold('Sync')}\n`);
    for (const [cmd, desc] of syncCommands) {
        console.log(`  ${color.cyan(cmd.padEnd(pad))}${color.dim(desc)}`);
    }

    console.log(`\n  ${color.bold('Extensions')}\n`);
    for (const [cmd, desc] of extensionCommands) {
        console.log(`  ${color.cyan(cmd.padEnd(pad))}${color.dim(desc)}`);
    }

    console.log(
        `\n  ${color.dim('Zedx Repo:')} ${color.underline(color.blue('https://github.com/tahayvr/zedx'))}\n`,
    );
}

async function runCreate(): Promise<void> {
    const options = await promptUser();

    if (options.types.includes('theme')) {
        const themeDetails = await promptThemeDetails();
        Object.assign(options, themeDetails);
    }

    if (options.types.includes('language')) {
        const languageDetails = await promptLanguageDetails();
        Object.assign(options, languageDetails);
    }

    const targetDir = path.join(getCallerDir(), options.id);
    await generateExtension(options, targetDir);

    p.outro(
        `${color.green('✓')} ${color.bold('Extension created successfully!')}\n` +
            `${color.gray('─'.repeat(40))}\n` +
            `${color.dim('Location:')} ${color.cyan(targetDir)}`,
    );

    p.outro(
        `${color.yellow('⚡')} ${color.bold('Next steps')}\n\n` +
            `  ${color.gray('1.')} Open Zed\n` +
            `  ${color.gray('2.')} ${color.white('Extensions > Install Dev Extension')}\n` +
            `  ${color.gray('3.')} Select ${color.cyan(options.id)} folder\n\n` +
            `${color.dim('Learn more:')} ${color.underline(color.blue('https://zed.dev/docs/extensions/developing-extensions'))}`,
    );
}

async function main() {
    const program = new Command();

    program.name('zedx').description('The CLI toolkit for Zed Editor.').version(`zedx v${version}`);

    program
        .command('create')
        .description('Scaffold a new Zed extension')
        .action(async () => {
            await runCreate();
        });

    program
        .command('version')
        .description('Bump the version of the extension')
        .argument('<type>', 'Version bump type: major, minor, or patch')
        .action(async (type: string) => {
            if (!['major', 'minor', 'patch'].includes(type)) {
                p.log.error(color.red('Invalid bump type. Use: major, minor, or patch'));
                process.exit(1);
            }
            await bumpExtensionVersion(type as BumpType);
        });

    program
        .command('check')
        .description('Validate extension config and show what is missing or incomplete')
        .action(async () => {
            await runCheck(getCallerDir());
        });

    program
        .command('install')
        .description('Install the current extension as a Zed dev extension')
        .action(async () => {
            await installDevExtension(getCallerDir());
        });

    const addCmd = program
        .command('add')
        .description('Add a theme or language to an existing extension');

    addCmd
        .command('theme <name>')
        .description('Add a new theme to the extension')
        .action(async (name: string) => {
            await addTheme(getCallerDir(), name);
        });

    addCmd
        .command('language <id>')
        .description('Add a new language to the extension')
        .action(async (id: string) => {
            await addLanguage(getCallerDir(), id);
        });

    const snippetCmd = program
        .command('snippet')
        .description('Inject a code snippet into an existing extension');

    snippetCmd
        .command('add lsp')
        .description('Wire up a language server (Rust + WASM) into the extension')
        .action(async () => {
            await addLsp(getCallerDir());
        });

    const syncCmd = program
        .command('sync')
        .description('Sync your Zed configs via a Git repo')
        .option('--local', 'On conflict, always keep the local version')
        .option('--remote', 'On conflict, always use the remote version')
        .action(async (opts: { local?: boolean; remote?: boolean }) => {
            if (opts.local && opts.remote) {
                p.log.error(color.red('--local and --remote are mutually exclusive.'));
                process.exit(1);
            }
            const conflict: ConflictStrategy | undefined = opts.local
                ? 'local'
                : opts.remote
                  ? 'remote'
                  : undefined;
            await runSync({ conflict });
        });

    syncCmd
        .command('init')
        .description('Link a Git repo as the sync target')
        .action(async () => {
            await syncInit();
        });

    syncCmd
        .command('status')
        .description('Show sync state between local Zed config and the remote repo')
        .action(async () => {
            await syncStatus();
        });

    syncCmd
        .command('select')
        .description('Interactively choose which files to sync')
        .action(async () => {
            await syncSelect();
        });

    syncCmd
        .command('install')
        .description('Install the OS daemon to auto-sync when Zed config changes')
        .action(async () => {
            await syncInstall();
        });

    syncCmd
        .command('uninstall')
        .description('Remove the OS daemon')
        .action(async () => {
            await syncUninstall();
        });

    const configCmd = program
        .command('config')
        .description('Configure zedx settings')
        .action(async () => {
            await runConfig();
        });

    configCmd
        .command('repo')
        .description('Change your sync repo and branch')
        .action(async () => {
            await configRepo();
        });

    configCmd
        .command('conflict')
        .description('Set the default conflict resolution strategy for zedx sync')
        .option('--ask', 'Set strategy to ask (interactive prompt)')
        .option('--local', 'Set strategy to local (local always wins)')
        .option('--remote', 'Set strategy to remote (remote always wins)')
        .action(async (opts: { ask?: boolean; local?: boolean; remote?: boolean }) => {
            const flags = [opts.ask, opts.local, opts.remote].filter(Boolean).length;
            if (flags > 1) {
                p.log.error(color.red('Only one of --ask, --local, --remote can be set.'));
                process.exit(1);
            }
            const direct: ConflictStrategy | undefined = opts.ask
                ? 'ask'
                : opts.local
                  ? 'local'
                  : opts.remote
                    ? 'remote'
                    : undefined;
            await configConflict(direct);
        });

    const argv = process.argv.filter(arg => arg !== '--');

    if (argv.length <= 2) {
        printWelcome();
        return;
    }

    program.parse(argv);
}

main().catch(console.error);

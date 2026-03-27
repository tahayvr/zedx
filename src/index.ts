#!/usr/bin/env node

import path from 'path';
import * as p from '@clack/prompts';
import color from 'picocolors';
import { Command } from 'commander';
import fs from 'fs-extra';
import { promptUser, promptThemeDetails, promptLanguageDetails } from './prompts.js';
import { generateExtension } from './generator.js';
import { runCheck } from './check.js';
import { addTheme, addLanguage } from './add.js'
import { syncInit, runSync, syncStatus } from './sync.js';
import { syncInstall, syncUninstall } from './daemon.js';

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
		`version = "${newVersion}"`
	);

	await fs.writeFile(tomlPath, newContent);

	p.log.success(color.green(`Bumped version from ${currentVersion} to ${newVersion}`));
}

async function main() {
	const program = new Command();

	program.name('zedx').description('Boilerplate generator for Zed Editor extensions.');

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

	const syncCmd = program
		.command('sync')
		.description('Sync Zed settings and extensions via a GitHub repo')
		.action(async () => {
			await runSync()
		})

	syncCmd
		.command('init')
		.description('Link a GitHub repo as the sync target')
		.action(async () => {
			await syncInit()
		})

	syncCmd
		.command('status')
		.description('Show sync state between local Zed config and the remote repo')
		.action(async () => {
			await syncStatus()
		})

	syncCmd
		.command('install')
		.description('Install the OS daemon to auto-sync when Zed config changes')
		.action(async () => {
			await syncInstall()
		})

	syncCmd
		.command('uninstall')
		.description('Remove the OS daemon')
		.action(async () => {
			await syncUninstall()
		})

	if (process.argv.length <= 2) {
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
				`${color.dim('Location:')} ${color.cyan(targetDir)}`
		);

		p.outro(
			`${color.yellow('⚡')} ${color.bold('Next steps')}\n\n` +
				`  ${color.gray('1.')} Open Zed\n` +
				`  ${color.gray('2.')} ${color.white('Extensions > Install Dev Extension')}\n` +
				`  ${color.gray('3.')} Select ${color.cyan(options.id)} folder\n\n` +
				`${color.dim('Learn more:')} ${color.underline(color.blue('https://zed.dev/docs/extensions/developing-extensions'))}`
		);

		return;
	}

	program.parse(process.argv);
}

main().catch(console.error);

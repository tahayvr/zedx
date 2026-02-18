import * as p from '@clack/prompts';
import color from 'picocolors';
import type { ExtensionOptions, ExtensionType, License } from './types/index.js';

export async function promptUser(): Promise<ExtensionOptions> {
	p.intro(
		`${color.bgBlue(color.bold(' zedx '))} ${color.blue('Boilerplate generator for Zed Editor extensions.')}`
	);

	const nameDefault = 'my-zed-extension';
	const name = await p.text({
		message: 'Project name:',
		placeholder: nameDefault
	});
	if (p.isCancel(name)) {
		p.cancel('Cancelled.');
		process.exit(0);
	}
	const nameValue = name || nameDefault;

	const idDefault = nameValue.toLowerCase().replace(/\s+/g, '-');
	const id = await p.text({
		message: 'Extension ID:',
		placeholder: idDefault,
		validate: (value: string | undefined) => {
			if (value && value.includes(' ')) return 'ID cannot contain spaces';
			if (value && value !== value.toLowerCase()) return 'ID must be lowercase';
		}
	});
	if (p.isCancel(id)) {
		p.cancel('Cancelled.');
		process.exit(0);
	}
	const idValue = id || idDefault;

	const descriptionDefault = 'A Zed theme';
	const description = await p.text({
		message: 'Description:',
		placeholder: descriptionDefault
	});
	if (p.isCancel(description)) {
		p.cancel('Cancelled.');
		process.exit(0);
	}
	const descriptionValue = description || descriptionDefault;

	const author = await p.text({
		message: 'Author name:',
		placeholder: 'name <username@example.com>',
		validate: (value: string | undefined) => {
			if (!value || value.length === 0) return 'Author is required';
		}
	});
	if (p.isCancel(author)) {
		p.cancel('Cancelled.');
		process.exit(0);
	}

	const repositoryDefault = `https://github.com/username/zed-theme.git`;
	const repository = await p.text({
		message: 'GitHub repository URL:',
		initialValue: repositoryDefault
	});
	if (p.isCancel(repository)) {
		p.cancel('Cancelled.');
		process.exit(0);
	}
	const repositoryValue = repository || repositoryDefault;

	const license = await p.select({
		message: 'License:',
		options: [
			{ value: 'Apache-2.0', label: 'Apache 2.0' },
			{ value: 'BSD-2-Clause', label: 'BSD 2-Clause' },
			{ value: 'BSD-3-Clause', label: 'BSD 3-Clause' },
			{ value: 'GPL-3.0', label: 'GNU GPLv3' },
			{ value: 'LGPL-3.0', label: 'GNU LGPLv3' },
			{ value: 'MIT', label: 'MIT' },
			{ value: 'Zlib', label: 'zlib' }
		],
		initialValue: 'MIT'
	});
	if (p.isCancel(license)) {
		p.cancel('Cancelled.');
		process.exit(0);
	}

	const options: ExtensionOptions = {
		name: nameValue,
		id: idValue,
		description: descriptionValue,
		author: String(author),
		repository: repositoryValue,
		license: license as License,
		types: ['theme'] as ExtensionType[]
	};

	return options;
}

export async function promptThemeDetails(): Promise<{
	themeName: string;
	appearance: 'light' | 'dark' | 'both';
}> {
	const themeName = await p.text({
		message: 'Theme name:',
		placeholder: 'My Theme'
	});
	if (p.isCancel(themeName)) {
		p.cancel('Cancelled.');
		process.exit(0);
	}

	const appearance = await p.select({
		message: 'Appearance:',
		options: [
			{ value: 'dark', label: 'Dark' },
			{ value: 'light', label: 'Light' },
			{ value: 'both', label: 'Both (Dark & Light)' }
		],
		initialValue: 'dark'
	});
	if (p.isCancel(appearance)) {
		p.cancel('Cancelled.');
		process.exit(0);
	}

	return {
		themeName: String(themeName),
		appearance: appearance as 'light' | 'dark' | 'both'
	};
}

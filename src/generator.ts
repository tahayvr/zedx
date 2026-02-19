import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';
import ejs from 'ejs';
import type { ExtensionOptions, LanguageOptions } from './types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = __dirname.includes('/src/');
const PROJECT_ROOT = isDev ? path.join(__dirname, '..') : __dirname;
const TEMPLATE_DIR = path.join(PROJECT_ROOT, 'templates');

async function renderTemplate(
	templatePath: string,
	data: Record<string, unknown>
): Promise<string> {
	const template = await fs.readFile(templatePath, 'utf-8');
	return ejs.render(template, data);
}

export async function generateExtension(
	options: ExtensionOptions,
	targetDir: string
): Promise<void> {
	await fs.ensureDir(targetDir);

	const extData = {
		...options,
		grammarRepo: (options as LanguageOptions).grammarRepo || '',
		grammarRev: (options as LanguageOptions).grammarRev || '',
		languageName: (options as LanguageOptions).languageName || 'My Language'
	};

	const extToml = await renderTemplate(
		path.join(TEMPLATE_DIR, 'base/extension.toml.ejs'),
		extData as unknown as Record<string, unknown>
	);
	await fs.writeFile(path.join(targetDir, 'extension.toml'), extToml);

	const readmeData = {
		...extData,
		languageId: (options as LanguageOptions).languageId || 'my-language'
	};
	const readme = await renderTemplate(
		path.join(TEMPLATE_DIR, 'base/readme.md.ejs'),
		readmeData as unknown as Record<string, unknown>
	);
	await fs.writeFile(path.join(targetDir, 'README.md'), readme);

	const licensePath = path.join(TEMPLATE_DIR, 'base/licenses', options.license);
	let licenseContent = await fs.readFile(licensePath, 'utf-8');
	licenseContent = licenseContent.replaceAll('{{YEAR}}', new Date().getFullYear().toString());
	licenseContent = licenseContent.replaceAll('{{AUTHOR}}', options.author);
	await fs.writeFile(path.join(targetDir, 'LICENSE'), licenseContent);

	if (options.types.includes('theme')) {
		await generateTheme(options, targetDir);
	}

	if (options.types.includes('language')) {
		await generateLanguage(options as LanguageOptions, targetDir);
	}
}

async function generateTheme(options: ExtensionOptions, targetDir: string): Promise<void> {
	const themeDir = path.join(targetDir, 'themes');
	await fs.ensureDir(themeDir);

	const appearance = (options as Record<string, unknown>).appearance || 'dark';
	const appearances = appearance === 'both' ? ['dark', 'light'] : [appearance];

	const themeData = {
		...options,
		themeName: (options as Record<string, unknown>).themeName || 'My Theme',
		appearances
	};

	const themeJson = await renderTemplate(
		path.join(TEMPLATE_DIR, 'theme/theme.json.ejs'),
		themeData as Record<string, unknown>
	);
	await fs.writeFile(path.join(themeDir, `${options.id}.json`), themeJson);
}

async function generateLanguage(options: LanguageOptions, targetDir: string): Promise<void> {
	const languageDir = path.join(targetDir, 'languages', options.languageId);
	await fs.ensureDir(languageDir);

	const data = {
		...options,
		pathSuffixes: options.pathSuffixes || [],
		lineComments: options.lineComments || ['//', '#']
	};

	const configToml = await renderTemplate(
		path.join(TEMPLATE_DIR, 'language/config.toml.ejs'),
		data as unknown as Record<string, unknown>
	);
	await fs.writeFile(path.join(languageDir, 'config.toml'), configToml);

	const queryFiles = [
		'highlights.scm',
		'brackets.scm',
		'outline.scm',
		'indents.scm',
		'injections.scm',
		'overrides.scm',
		'textobjects.scm',
		'redactions.scm',
		'runnables.scm'
	];

	for (const file of queryFiles) {
		const templatePath = path.join(TEMPLATE_DIR, 'language', file);
		if (await fs.pathExists(templatePath)) {
			let content = await fs.readFile(templatePath, 'utf-8');
			content = ejs.render(content, data as unknown as Record<string, unknown>);
			await fs.writeFile(path.join(languageDir, file), content);
		}
	}
}

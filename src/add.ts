import path from 'path';
import { fileURLToPath } from 'url';

import * as p from '@clack/prompts';
import ejs from 'ejs';
import fs from 'fs-extra';
import color from 'picocolors';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = __dirname.includes('/src/');
const PROJECT_ROOT = isDev ? path.join(__dirname, '..') : __dirname;
const TEMPLATE_DIR = path.join(PROJECT_ROOT, 'templates');

async function renderTemplate(
    templatePath: string,
    data: Record<string, unknown>,
): Promise<string> {
    const template = await fs.readFile(templatePath, 'utf-8');
    return ejs.render(template, data);
}

function tomlGet(content: string, key: string): string | undefined {
    const match = content.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'));
    return match?.[1];
}

function slugify(name: string): string {
    return name
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');
}

export async function addTheme(callerDir: string, themeName: string): Promise<void> {
    p.intro(
        `${color.bgBlue(color.bold(' zedx add theme '))} ${color.blue('Adding a theme to your extension…')}`,
    );

    const tomlPath = path.join(callerDir, 'extension.toml');
    if (!(await fs.pathExists(tomlPath))) {
        p.log.error(color.red('No extension.toml found. Run zedx from an extension directory.'));
        process.exit(1);
    }

    const tomlContent = await fs.readFile(tomlPath, 'utf-8');
    const extensionId = tomlGet(tomlContent, 'id') ?? 'extension';
    const author =
        tomlGet(tomlContent, 'authors') ??
        tomlContent.match(/^authors\s*=\s*\["([^"]+)"\]/m)?.[1] ??
        '';

    const appearance = await p.select({
        message: 'Appearance:',
        options: [
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'both', label: 'Both (Dark & Light)' },
        ],
        initialValue: 'dark',
    });
    if (p.isCancel(appearance)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const appearances = appearance === 'both' ? ['dark', 'light'] : [appearance as string];
    const themeSlug = slugify(themeName);
    const themeFile = `${themeSlug}.json`;
    const themesDir = path.join(callerDir, 'themes');
    const themePath = path.join(themesDir, themeFile);

    if (await fs.pathExists(themePath)) {
        p.log.error(color.red(`themes/${themeFile} already exists.`));
        process.exit(1);
    }

    await fs.ensureDir(themesDir);

    const themeJson = await renderTemplate(path.join(TEMPLATE_DIR, 'theme/theme.json.ejs'), {
        id: extensionId,
        author,
        themeName,
        appearances,
    } as Record<string, unknown>);
    await fs.writeFile(themePath, themeJson);

    p.log.success(`Created ${color.cyan(`themes/${themeFile}`)}`);
    p.outro(
        `${color.green('✓')} Theme added.\n` +
            `${color.dim('Run')} ${color.cyan('zedx check')} ${color.dim('to validate your extension.')}`,
    );
}

export async function addLanguage(callerDir: string, languageId: string): Promise<void> {
    p.intro(
        `${color.bgBlue(color.bold(' zedx add language '))} ${color.blue('Adding a language to your extension…')}`,
    );

    const tomlPath = path.join(callerDir, 'extension.toml');
    if (!(await fs.pathExists(tomlPath))) {
        p.log.error(color.red('No extension.toml found. Run zedx from an extension directory.'));
        process.exit(1);
    }

    const tomlContent = await fs.readFile(tomlPath, 'utf-8');

    // Check for duplicate
    const alreadyExists =
        new RegExp(`^\\[grammars\\.${languageId}\\]`, 'm').test(tomlContent) ||
        new RegExp(`^#\\s*\\[grammars\\.${languageId}\\]`, 'm').test(tomlContent);
    if (alreadyExists) {
        p.log.error(color.red(`Language "${languageId}" already exists in extension.toml.`));
        process.exit(1);
    }

    const languageName = await p.text({
        message: 'Language display name:',
        placeholder: languageId,
    });
    if (p.isCancel(languageName)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }
    const languageNameValue = String(languageName || languageId);

    const langDir = path.join(callerDir, 'languages', languageId);
    if (await fs.pathExists(langDir)) {
        p.log.error(color.red(`languages/${languageId}/ already exists.`));
        process.exit(1);
    }
    await fs.ensureDir(langDir);

    // Write config.toml
    const data = {
        languageName: languageNameValue,
        languageId,
        pathSuffixes: [],
        lineComments: ['//', '#'],
        grammarRepo: '',
        grammarRev: '',
    };

    const configToml = await renderTemplate(
        path.join(TEMPLATE_DIR, 'language/config.toml.ejs'),
        data as unknown as Record<string, unknown>,
    );
    await fs.writeFile(path.join(langDir, 'config.toml'), configToml);
    p.log.success(`Created ${color.cyan(`languages/${languageId}/config.toml`)}`);

    // Write .scm query files
    const queryFiles = [
        'highlights.scm',
        'brackets.scm',
        'outline.scm',
        'indents.scm',
        'injections.scm',
        'overrides.scm',
        'textobjects.scm',
        'redactions.scm',
        'runnables.scm',
    ];
    for (const file of queryFiles) {
        const templatePath = path.join(TEMPLATE_DIR, 'language', file);
        if (await fs.pathExists(templatePath)) {
            const content = ejs.render(
                await fs.readFile(templatePath, 'utf-8'),
                data as unknown as Record<string, unknown>,
            );
            await fs.writeFile(path.join(langDir, file), content);
        }
    }
    p.log.success(`Created ${color.cyan(`languages/${languageId}/`)} query files`);

    // Append grammar block to extension.toml
    const grammarBlock =
        `\n# [grammars.${languageId}]\n` +
        `# repository = "https://github.com/user/tree-sitter-${languageId}"\n` +
        `# rev = "main"\n` +
        `\n# [language_servers.${languageId}-lsp]\n` +
        `# name = "${languageNameValue} LSP"\n` +
        `# languages = ["${languageNameValue}"]\n`;

    await fs.appendFile(tomlPath, grammarBlock);
    p.log.success(`Updated ${color.cyan('extension.toml')} with grammar block`);

    p.outro(
        `${color.green('✓')} Language added.\n` +
            `${color.dim('Run')} ${color.cyan('zedx check')} ${color.dim('to validate your extension.')}`,
    );
}

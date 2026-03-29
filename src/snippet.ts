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

function toPascalCase(str: string): string {
    return str
        .replace(/[-_\s]+(.)/g, (_, c: string) => c.toUpperCase())
        .replace(/^(.)/, (c: string) => c.toUpperCase());
}

function detectLanguages(callerDir: string): string[] {
    try {
        const langsDir = path.join(callerDir, 'languages');
        if (!fs.pathExistsSync(langsDir)) return [];
        return fs
            .readdirSync(langsDir, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => d.name);
    } catch {
        return [];
    }
}

export async function addLsp(callerDir: string): Promise<void> {
    p.intro(
        `${color.bgBlue(color.bold(' zedx snippet add lsp '))} ${color.blue('Wiring up a language server…')}`,
    );

    const tomlPath = path.join(callerDir, 'extension.toml');
    if (!(await fs.pathExists(tomlPath))) {
        p.log.error(color.red('No extension.toml found. Run zedx from an extension directory.'));
        process.exit(1);
    }

    const tomlContent = await fs.readFile(tomlPath, 'utf-8');
    const extensionId = tomlGet(tomlContent, 'id') ?? 'my-extension';
    const extensionName = tomlGet(tomlContent, 'name') ?? extensionId;

    // --- LSP server name ---
    const lspNameDefault = `${extensionName} LSP`;
    const lspName = await p.text({
        message: 'Language server display name:',
        placeholder: lspNameDefault,
    });
    if (p.isCancel(lspName)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }
    const lspNameValue = String(lspName || lspNameDefault);

    // Derive a TOML-safe ID from the display name
    const lspId = lspNameValue
        .toLowerCase()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '');

    // --- Check for duplicate ---
    if (new RegExp(`^\\[language_servers\\.${lspId}\\]`, 'm').test(tomlContent)) {
        p.log.error(color.red(`[language_servers.${lspId}] already exists in extension.toml.`));
        process.exit(1);
    }

    // --- Language association ---
    const detectedLanguages = detectLanguages(callerDir);
    let languageName: string;

    if (detectedLanguages.length > 0) {
        const choice = await p.select({
            message: 'Which language does this LSP serve?',
            options: [
                ...detectedLanguages.map(l => ({
                    value: l,
                    label: toPascalCase(l),
                })),
                { value: '__custom__', label: 'Enter manually' },
            ],
        });
        if (p.isCancel(choice)) {
            p.cancel('Cancelled.');
            process.exit(0);
        }
        if (choice === '__custom__') {
            const custom = await p.text({
                message: 'Language name (must match name in config.toml):',
                placeholder: extensionName,
            });
            if (p.isCancel(custom)) {
                p.cancel('Cancelled.');
                process.exit(0);
            }
            languageName = String(custom || extensionName);
        } else {
            languageName = toPascalCase(String(choice));
        }
    } else {
        const custom = await p.text({
            message: 'Language name (must match name in config.toml):',
            placeholder: extensionName,
        });
        if (p.isCancel(custom)) {
            p.cancel('Cancelled.');
            process.exit(0);
        }
        languageName = String(custom || extensionName);
    }

    // --- LSP binary command ---
    const lspCommand = await p.text({
        message: 'LSP binary command (the executable name or path):',
        placeholder: `${lspId}-server`,
    });
    if (p.isCancel(lspCommand)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }
    const lspCommandValue = String(lspCommand || `${lspId}-server`);

    // --- Append [language_servers.*] block to extension.toml ---
    const lspTomlBlock =
        `\n[language_servers.${lspId}]\n` +
        `name = "${lspNameValue}"\n` +
        `languages = ["${languageName}"]\n`;

    await fs.appendFile(tomlPath, lspTomlBlock);
    p.log.success(`Updated ${color.cyan('extension.toml')} with [language_servers.${lspId}]`);

    // --- Add lib.path to extension.toml if not present ---
    const updatedToml = await fs.readFile(tomlPath, 'utf-8');
    if (!/^lib\s*=/m.test(updatedToml)) {
        await fs.appendFile(tomlPath, `\nlib.path = "extension.wasm"\n`);
        p.log.success(`Updated ${color.cyan('extension.toml')} with lib.path`);
    }

    const structName = toPascalCase(extensionId).replace(/-/g, '');

    // --- Generate Cargo.toml if not present ---
    const cargoPath = path.join(callerDir, 'Cargo.toml');
    if (!(await fs.pathExists(cargoPath))) {
        const cargoToml = await renderTemplate(path.join(TEMPLATE_DIR, 'lsp/Cargo.toml.ejs'), {
            extensionId,
        } as Record<string, unknown>);
        await fs.writeFile(cargoPath, cargoToml);
        p.log.success(`Created ${color.cyan('Cargo.toml')}`);
    } else {
        p.log.warn(`${color.yellow('Cargo.toml already exists')} — skipped`);
    }

    // --- Generate src/lib.rs if not present ---
    const srcDir = path.join(callerDir, 'src');
    const libRsPath = path.join(srcDir, 'lib.rs');
    if (!(await fs.pathExists(libRsPath))) {
        await fs.ensureDir(srcDir);
        const libRs = await renderTemplate(path.join(TEMPLATE_DIR, 'lsp/lib.rs.ejs'), {
            structName,
            lspCommand: lspCommandValue,
        } as Record<string, unknown>);
        await fs.writeFile(libRsPath, libRs);
        p.log.success(`Created ${color.cyan('src/lib.rs')}`);
    } else {
        p.log.warn(`${color.yellow('src/lib.rs already exists')} — skipped`);
    }

    p.outro(
        `${color.green('✓')} LSP snippet added.\n\n` +
            `  ${color.dim('1.')} Edit ${color.cyan('src/lib.rs')} — implement ${color.white('language_server_command')}\n` +
            `  ${color.dim('2.')} Edit ${color.cyan('Cargo.toml')} — pin ${color.white('zed_extension_api')} to latest version\n` +
            `  ${color.dim('3.')} ${color.dim('Docs:')} ${color.underline(color.blue('https://zed.dev/docs/extensions/languages#language-servers'))}`,
    );
}

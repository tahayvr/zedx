import path from 'path';

import * as p from '@clack/prompts';
import fs from 'fs-extra';
import color from 'picocolors';
import { parse as parseToml, TomlError } from 'smol-toml';

import {
    ACCEPTED_LICENSES,
    detectLicense,
    isLicenseFileName,
    isPinnedRevision,
    isRegistryVersion,
    validateExtensionId,
} from './registry-rules.js';

interface Issue {
    file: string;
    message: string;
    hint?: string;
}

export interface ValidationResult {
    file: string;
    issues: Issue[];
}

export interface ExtensionManifest {
    toml: Record<string, unknown>;
    content: string;
}

function tomlString(table: Record<string, unknown>, key: string): string | undefined {
    const value = table[key];
    return typeof value === 'string' ? value : undefined;
}

// Read and parse extension.toml, exiting with a clear error when it is
// missing or malformed — nothing else can be validated without it.
export async function loadExtensionManifest(callerDir: string): Promise<ExtensionManifest> {
    const tomlPath = path.join(callerDir, 'extension.toml');

    if (!(await fs.pathExists(tomlPath))) {
        p.log.error(color.red('No extension.toml found in current directory.'));
        p.log.info(`Run ${color.cyan('zedx')} to scaffold a new extension first.`);
        process.exit(1);
    }

    const tomlContent = await fs.readFile(tomlPath, 'utf-8');

    try {
        return { toml: parseToml(tomlContent) as Record<string, unknown>, content: tomlContent };
    } catch (err) {
        const message = err instanceof TomlError ? err.message : String(err);
        p.log.error(color.red(`extension.toml is not valid TOML: ${message}`));
        process.exit(1);
    }
}

// Everything `zedx check` looks at: scaffold placeholders that were never
// filled in, plus the rules Zed's extension registry enforces on submission.
export async function validateExtension(
    callerDir: string,
    manifest: ExtensionManifest,
): Promise<ValidationResult[]> {
    const { toml, content: tomlContent } = manifest;

    const extensionId = tomlString(toml, 'id');
    const extensionName = tomlString(toml, 'name');
    const version = tomlString(toml, 'version');
    const repository = tomlString(toml, 'repository');

    const results: ValidationResult[] = [];

    // ── extension.toml ────────────────────────────────────────────────────────

    const extIssues: Issue[] = [];

    if (!extensionId) {
        extIssues.push({
            file: 'extension.toml',
            message: 'Missing required field: id',
        });
    } else {
        const idError = validateExtensionId(extensionId);
        if (idError) {
            extIssues.push({
                file: 'extension.toml',
                message: `id "${extensionId}" is not valid: ${idError}`,
                hint: "Zed's extension registry rejects IDs that break this rule",
            });
        }
    }

    if (!extensionName) {
        extIssues.push({
            file: 'extension.toml',
            message: 'Missing required field: name',
        });
    }

    if (!version || !isRegistryVersion(version)) {
        extIssues.push({
            file: 'extension.toml',
            message: `version must be in the form major.minor.patch (found ${version ? `"${version}"` : 'none'})`,
        });
    }

    if (!repository || repository.includes('username')) {
        extIssues.push({
            file: 'extension.toml',
            message: 'repository still uses the default placeholder URL',
            hint: 'Set it to your actual Git repository URL',
        });
    }

    // Detect language entries via the parsed [grammars.*] table. Commented-out
    // placeholder blocks (from the scaffold) aren't part of the parsed TOML at
    // all, so those still need a raw-text scan to detect and report on.
    const grammarsTable = (toml['grammars'] as Record<string, unknown> | undefined) ?? {};
    const languageIds = Object.keys(grammarsTable);
    const commentedGrammarMatches = [...tomlContent.matchAll(/^#\s*\[grammars\.(\S+)\]/gm)];
    const hasLanguage = languageIds.length > 0 || commentedGrammarMatches.length > 0;

    if (commentedGrammarMatches.length > 0 && languageIds.length === 0) {
        const ids = commentedGrammarMatches.map(m => m[1]);
        extIssues.push({
            file: 'extension.toml',
            message: `Grammar section is commented out for: ${ids.join(', ')}`,
            hint: 'Uncomment [grammars.<id>] and set a real tree-sitter repository URL and rev',
        });
    }

    for (const [grammarId, entry] of Object.entries(grammarsTable)) {
        const grammar = (entry as Record<string, unknown> | undefined) ?? {};
        const rev = tomlString(grammar, 'rev') ?? tomlString(grammar, 'commit');
        if (!rev || !isPinnedRevision(rev)) {
            extIssues.push({
                file: 'extension.toml',
                message: `Grammar "${grammarId}": rev ${rev ? `"${rev}"` : '(missing)'} is not a commit SHA`,
                hint: 'Pin rev to a commit SHA of the grammar repository so the build is reproducible',
            });
        }
    }

    // Detect theme entries by looking for themes/ directory
    const themesDir = path.join(callerDir, 'themes');
    const hasTheme = await fs.pathExists(themesDir);

    const iconThemesDir = path.join(callerDir, 'icon_themes');
    const hasIconTheme = await fs.pathExists(iconThemesDir);

    // Theme and icon theme extensions may not ship anything else.
    const provides: string[] = [];
    if (hasTheme) provides.push('themes');
    if (hasIconTheme) provides.push('icon themes');
    if (hasLanguage || (await fs.pathExists(path.join(callerDir, 'languages')))) {
        provides.push('languages');
    }
    if (await fs.pathExists(path.join(callerDir, 'Cargo.toml'))) provides.push('Rust code');
    if ('snippets' in toml) provides.push('snippets');

    if ((hasTheme || hasIconTheme) && provides.length > 1) {
        extIssues.push({
            file: 'extension.toml',
            message: `Theme and icon theme extensions must provide nothing else, but this one has: ${provides.join(', ')}`,
            hint: 'Split it into one extension per kind before publishing',
        });
    } else if (extensionId && hasTheme && !extensionId.includes('theme')) {
        extIssues.push({
            file: 'extension.toml',
            message: `id "${extensionId}" does not say this is a theme`,
            hint: 'Theme extension IDs should indicate it, e.g. by ending in -theme',
        });
    } else if (extensionId && hasIconTheme && !extensionId.includes('icon')) {
        extIssues.push({
            file: 'extension.toml',
            message: `id "${extensionId}" does not say this is an icon theme`,
            hint: 'Icon theme extension IDs should indicate it, e.g. by ending in -icon-theme or -icons',
        });
    }

    results.push({ file: 'extension.toml', issues: extIssues });

    // ── license ───────────────────────────────────────────────────────────────

    const licenseFiles: string[] = [];
    for (const name of await fs.readdir(callerDir)) {
        if (!isLicenseFileName(name)) continue;
        const stat = await fs.stat(path.join(callerDir, name)).catch(() => null);
        if (stat?.isFile()) licenseFiles.push(name);
    }

    const acceptedHint = `Accepted: ${ACCEPTED_LICENSES.join(', ')}`;
    if (licenseFiles.length === 0) {
        results.push({
            file: 'LICENSE',
            issues: [
                {
                    file: 'LICENSE',
                    message: 'No license file found at the extension root',
                    hint: `The registry requires one. ${acceptedHint}`,
                },
            ],
        });
    }

    for (const name of licenseFiles) {
        const licenseText = await fs.readFile(path.join(callerDir, name), 'utf-8');
        if (!detectLicense(licenseText)) {
            results.push({
                file: name,
                issues: [
                    {
                        file: name,
                        message: 'Not recognised as a license the registry accepts',
                        hint: acceptedHint,
                    },
                ],
            });
        }
    }

    // ── theme validation ──────────────────────────────────────────────────────

    if (hasTheme) {
        const themeIssues: Issue[] = [];
        const themeFiles = (await fs.readdir(themesDir)).filter(f => f.endsWith('.json'));

        if (themeFiles.length === 0) {
            themeIssues.push({
                file: 'themes/',
                message: 'No .json theme files found in themes/ directory',
            });
        }

        for (const themeFile of themeFiles) {
            const themePath = path.join(themesDir, themeFile);
            const themeIssuesForFile: Issue[] = [];

            let themeJson: Record<string, unknown>;
            try {
                themeJson = await fs.readJson(themePath);
            } catch {
                themeIssuesForFile.push({
                    file: `themes/${themeFile}`,
                    message: 'Invalid JSON — file could not be parsed',
                });
                results.push({ file: `themes/${themeFile}`, issues: themeIssuesForFile });
                continue;
            }

            const themes = themeJson['themes'] as Array<Record<string, unknown>> | undefined;
            if (!themes || themes.length === 0) {
                themeIssuesForFile.push({
                    file: `themes/${themeFile}`,
                    message: 'No theme variants found under the "themes" key',
                });
            } else {
                for (const variant of themes) {
                    const variantName = String(variant['name'] ?? 'unknown');
                    const style = variant['style'] as Record<string, unknown> | undefined;
                    if (!style) {
                        themeIssuesForFile.push({
                            file: `themes/${themeFile}`,
                            message: `Variant "${variantName}": missing "style" block`,
                        });
                        continue;
                    }

                    // Check for placeholder-like neutral grays that indicate untouched scaffold
                    const background = style['background'] as string | undefined;
                    const placeholderBgs = ['#1e1e1e', '#f5f5f5', '#ffffff', '#000000'];
                    if (background && placeholderBgs.includes(background.toLowerCase())) {
                        themeIssuesForFile.push({
                            file: `themes/${themeFile}`,
                            message: `Variant "${variantName}": background color is still the scaffold placeholder (${background})`,
                            hint: 'Replace with your actual theme colors',
                        });
                    }

                    // Check that syntax block is populated
                    const syntax = style['syntax'] as Record<string, unknown> | undefined;
                    if (!syntax || Object.keys(syntax).length === 0) {
                        themeIssuesForFile.push({
                            file: `themes/${themeFile}`,
                            message: `Variant "${variantName}": "syntax" block is empty or missing`,
                            hint: 'Add syntax token color definitions',
                        });
                    }
                }
            }

            themeIssues.push(...themeIssuesForFile);
        }

        results.push({ file: 'themes/', issues: themeIssues });
    }

    // ── icon theme validation ─────────────────────────────────────────────────

    if (hasIconTheme) {
        const iconThemeFiles = (await fs.readdir(iconThemesDir)).filter(f => f.endsWith('.json'));

        if (iconThemeFiles.length === 0) {
            results.push({
                file: 'icon_themes/',
                issues: [
                    {
                        file: 'icon_themes/',
                        message: 'No .json icon theme files found in icon_themes/ directory',
                    },
                ],
            });
        }

        for (const iconThemeFile of iconThemeFiles) {
            const iconThemePath = path.join(iconThemesDir, iconThemeFile);
            const iconThemeIssues: Issue[] = [];

            let iconThemeJson: Record<string, unknown>;
            try {
                iconThemeJson = await fs.readJson(iconThemePath);
            } catch {
                results.push({
                    file: `icon_themes/${iconThemeFile}`,
                    issues: [
                        {
                            file: `icon_themes/${iconThemeFile}`,
                            message: 'Invalid JSON — file could not be parsed',
                        },
                    ],
                });
                continue;
            }

            const variants = iconThemeJson['themes'] as Array<Record<string, unknown>> | undefined;
            if (!variants || variants.length === 0) {
                iconThemeIssues.push({
                    file: `icon_themes/${iconThemeFile}`,
                    message: 'No theme variants found under the "themes" key',
                });
            } else {
                for (const variant of variants) {
                    const variantName = String(variant['name'] ?? 'unknown');

                    const fileIcons = variant['file_icons'] as
                        | Record<string, { path?: string }>
                        | undefined;
                    const fileSuffixes = variant['file_suffixes'] as
                        | Record<string, string>
                        | undefined;
                    const fileStems = variant['file_stems'] as Record<string, string> | undefined;

                    if (
                        (!fileSuffixes || Object.keys(fileSuffixes).length === 0) &&
                        (!fileStems || Object.keys(fileStems).length === 0)
                    ) {
                        iconThemeIssues.push({
                            file: `icon_themes/${iconThemeFile}`,
                            message: `Variant "${variantName}": no file_suffixes or file_stems mappings — every file will fall back to the default icon`,
                            hint: 'Add entries like { "rs": "rust" } to file_suffixes, matching keys in file_icons',
                        });
                    }

                    if (!fileIcons?.['default']) {
                        iconThemeIssues.push({
                            file: `icon_themes/${iconThemeFile}`,
                            message: `Variant "${variantName}": file_icons has no "default" entry — files without a mapping won't get an icon from this theme`,
                            hint: 'Add "default": { "path": "./icons/file.svg" } to file_icons',
                        });
                    }

                    // Verify every icon path referenced anywhere in the variant
                    // actually exists on disk, relative to the extension root.
                    const referencedPaths = new Set<string>();
                    for (const group of [
                        variant['directory_icons'],
                        variant['chevron_icons'],
                    ] as Array<Record<string, string> | undefined>) {
                        if (!group) continue;
                        for (const p of Object.values(group)) {
                            if (typeof p === 'string') referencedPaths.add(p);
                        }
                    }
                    if (fileIcons) {
                        for (const icon of Object.values(fileIcons)) {
                            if (icon?.path) referencedPaths.add(icon.path);
                        }
                    }

                    for (const iconPath of referencedPaths) {
                        const resolvedPath = path.join(callerDir, iconPath);
                        if (!(await fs.pathExists(resolvedPath))) {
                            iconThemeIssues.push({
                                file: `icon_themes/${iconThemeFile}`,
                                message: `Variant "${variantName}": referenced icon "${iconPath}" does not exist`,
                                hint: 'Fix the path or add the missing SVG file',
                            });
                        }
                    }
                }
            }

            results.push({ file: `icon_themes/${iconThemeFile}`, issues: iconThemeIssues });
        }
    }

    // ── language validation ───────────────────────────────────────────────────

    if (hasLanguage) {
        // Collect all language IDs from both uncommented and commented grammar sections
        const allLanguageIds = [...languageIds, ...commentedGrammarMatches.map(m => m[1])];

        for (const langId of allLanguageIds) {
            const langDir = path.join(callerDir, 'languages', langId);
            const langIssues: Issue[] = [];

            if (!(await fs.pathExists(langDir))) {
                langIssues.push({
                    file: `languages/${langId}/`,
                    message: `Language directory does not exist`,
                    hint: `Expected at ${path.join('languages', langId)}`,
                });
                results.push({ file: `languages/${langId}/`, issues: langIssues });
                continue;
            }

            // config.toml checks
            const configPath = path.join(langDir, 'config.toml');
            const configIssues: Issue[] = [];

            if (!(await fs.pathExists(configPath))) {
                configIssues.push({
                    file: `languages/${langId}/config.toml`,
                    message: 'config.toml is missing',
                });
            } else {
                const configContent = await fs.readFile(configPath, 'utf-8');

                let languageConfig: Record<string, unknown> | null = null;
                try {
                    languageConfig = parseToml(configContent) as Record<string, unknown>;
                } catch (err) {
                    const message = err instanceof TomlError ? err.message : String(err);
                    configIssues.push({
                        file: `languages/${langId}/config.toml`,
                        message: `config.toml is not valid TOML: ${message}`,
                    });
                }

                if (languageConfig && !('name' in languageConfig)) {
                    configIssues.push({
                        file: `languages/${langId}/config.toml`,
                        message: 'Missing required field: name',
                    });
                }

                if (languageConfig && !('grammar' in languageConfig)) {
                    configIssues.push({
                        file: `languages/${langId}/config.toml`,
                        message: 'Missing required field: grammar',
                    });
                }

                // path_suffixes is commented out in scaffold — flag it
                if (languageConfig && !('path_suffixes' in languageConfig)) {
                    configIssues.push({
                        file: `languages/${langId}/config.toml`,
                        message:
                            "path_suffixes is not set — files won't be associated with this language",
                        hint: 'Uncomment and fill in path_suffixes (e.g., ["myl"])',
                    });
                }

                // line_comments is commented out in scaffold — flag it
                if (languageConfig && !('line_comments' in languageConfig)) {
                    configIssues.push({
                        file: `languages/${langId}/config.toml`,
                        message: "line_comments is not set — toggle-comment keybind won't work",
                        hint: 'Uncomment and set line_comments (e.g., ["// "])',
                    });
                }
            }

            results.push({ file: `languages/${langId}/config.toml`, issues: configIssues });

            // highlights.scm checks
            const highlightsPath = path.join(langDir, 'highlights.scm');
            const highlightIssues: Issue[] = [];

            if (!(await fs.pathExists(highlightsPath))) {
                highlightIssues.push({
                    file: `languages/${langId}/highlights.scm`,
                    message: 'highlights.scm is missing',
                    hint: 'Without it, no syntax highlighting will appear',
                });
            } else {
                const highlightsContent = await fs.readFile(highlightsPath, 'utf-8');
                // Count non-comment, non-empty lines with actual query patterns
                const activeLines = highlightsContent
                    .split('\n')
                    .filter(l => l.trim() && !l.trim().startsWith(';'));
                if (activeLines.length <= 3) {
                    highlightIssues.push({
                        file: `languages/${langId}/highlights.scm`,
                        message:
                            'Only scaffold starter patterns present — no real grammar queries added yet',
                        hint: "Add tree-sitter queries matching your language's grammar node types",
                    });
                }
            }

            results.push({ file: `languages/${langId}/highlights.scm`, issues: highlightIssues });
        }
    }

    return results;
}

// Print issues grouped by file. Returns how many there were.
export function reportIssues(results: ValidationResult[]): number {
    const fileGroups = results.filter(r => r.issues.length > 0);

    for (const group of fileGroups) {
        p.log.warn(`${color.yellow(color.bold(group.issues[0].file))}`);
        for (const issue of group.issues) {
            process.stdout.write(`  ${color.red('✗')} ${issue.message}\n`);
            if (issue.hint) {
                process.stdout.write(`    ${color.dim('→')} ${color.dim(issue.hint)}\n`);
            }
        }
        process.stdout.write('\n');
    }

    return results.flatMap(r => r.issues).length;
}

export async function runCheck(callerDir: string): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx check '))} ${color.blue('Validating extension config…')}`,
    );

    const manifest = await loadExtensionManifest(callerDir);
    const issueCount = reportIssues(await validateExtension(callerDir, manifest));

    if (issueCount === 0) {
        p.log.success(color.green('No issues found. Your extension config looks good!'));
        p.outro(
            `${color.dim('Load it in Zed:')} Extensions ${color.dim('>')} Install Dev Extension`,
        );
        return;
    }

    p.outro(
        `${color.red(`${issueCount} issue${issueCount === 1 ? '' : 's'} found`)} — fix the above before publishing`,
    );
    // Non-zero so the check can gate a CI job or a publish.
    process.exit(1);
}

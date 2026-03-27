import fs from 'fs-extra'
import path from 'path'
import * as p from '@clack/prompts'
import color from 'picocolors'

interface Issue {
    file: string
    message: string
    hint?: string
}

interface ValidationResult {
    file: string
    issues: Issue[]
}

// Minimal TOML key extraction — handles `key = "value"` and `key = ["a", "b"]`
function tomlGet(content: string, key: string): string | undefined {
    const match = content.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, 'm'))
    return match?.[1]
}

function tomlHasUncommentedKey(content: string, key: string): boolean {
    return new RegExp(`^${key}\\s*=`, 'm').test(content)
}


export async function runCheck(callerDir: string): Promise<void> {
    p.intro(`${color.bgBlue(color.bold(' zedx check '))} ${color.blue('Validating extension config…')}`)

    const tomlPath = path.join(callerDir, 'extension.toml')

    if (!(await fs.pathExists(tomlPath))) {
        p.log.error(color.red('No extension.toml found in current directory.'))
        p.log.info(`Run ${color.cyan('zedx')} to scaffold a new extension first.`)
        process.exit(1)
    }

    const tomlContent = await fs.readFile(tomlPath, 'utf-8')
    const extensionId = tomlGet(tomlContent, 'id')
    const extensionName = tomlGet(tomlContent, 'name')
    const repository = tomlGet(tomlContent, 'repository')

    const results: ValidationResult[] = []

    // ── extension.toml ────────────────────────────────────────────────────────

    const extIssues: Issue[] = []

    if (!extensionId) {
        extIssues.push({
            file: 'extension.toml',
            message: 'Missing required field: id',
        })
    }

    if (!extensionName) {
        extIssues.push({
            file: 'extension.toml',
            message: 'Missing required field: name',
        })
    }

    if (!repository || repository.includes('username')) {
        extIssues.push({
            file: 'extension.toml',
            message: 'repository still uses the default placeholder URL',
            hint: 'Set it to your actual GitHub repository URL',
        })
    }

    // Detect language entries by looking for uncommented [grammars.*] sections
    const grammarMatches = [...tomlContent.matchAll(/^\[grammars\.(\S+)\]/gm)]
    const commentedGrammarMatches = [...tomlContent.matchAll(/^#\s*\[grammars\.(\S+)\]/gm)]
    const languageIds = grammarMatches.map(m => m[1])
    const hasLanguage = languageIds.length > 0 || commentedGrammarMatches.length > 0

    if (commentedGrammarMatches.length > 0 && grammarMatches.length === 0) {
        const ids = commentedGrammarMatches.map(m => m[1])
        extIssues.push({
            file: 'extension.toml',
            message: `Grammar section is commented out for: ${ids.join(', ')}`,
            hint: 'Uncomment [grammars.<id>] and set a real tree-sitter repository URL and rev',
        })
    }

    // Detect theme entries by looking for themes/ directory
    const themesDir = path.join(callerDir, 'themes')
    const hasTheme = await fs.pathExists(themesDir)

    results.push({ file: 'extension.toml', issues: extIssues })

    // ── theme validation ──────────────────────────────────────────────────────

    if (hasTheme) {
        const themeIssues: Issue[] = []
        const themeFiles = (await fs.readdir(themesDir)).filter(f => f.endsWith('.json'))

        if (themeFiles.length === 0) {
            themeIssues.push({
                file: 'themes/',
                message: 'No .json theme files found in themes/ directory',
            })
        }

        for (const themeFile of themeFiles) {
            const themePath = path.join(themesDir, themeFile)
            const themeIssuesForFile: Issue[] = []

            let themeJson: Record<string, unknown>
            try {
                themeJson = await fs.readJson(themePath)
            } catch {
                themeIssuesForFile.push({
                    file: `themes/${themeFile}`,
                    message: 'Invalid JSON — file could not be parsed',
                })
                results.push({ file: `themes/${themeFile}`, issues: themeIssuesForFile })
                continue
            }

            const themes = themeJson['themes'] as Array<Record<string, unknown>> | undefined
            if (!themes || themes.length === 0) {
                themeIssuesForFile.push({
                    file: `themes/${themeFile}`,
                    message: 'No theme variants found under the "themes" key',
                })
            } else {
                for (const variant of themes) {
                    const variantName = String(variant['name'] ?? 'unknown')
                    const style = variant['style'] as Record<string, unknown> | undefined
                    if (!style) {
                        themeIssuesForFile.push({
                            file: `themes/${themeFile}`,
                            message: `Variant "${variantName}": missing "style" block`,
                        })
                        continue
                    }

                    // Check for placeholder-like neutral grays that indicate untouched scaffold
                    const background = style['background'] as string | undefined
                    const placeholderBgs = ['#1e1e1e', '#f5f5f5', '#ffffff', '#000000']
                    if (background && placeholderBgs.includes(background.toLowerCase())) {
                        themeIssuesForFile.push({
                            file: `themes/${themeFile}`,
                            message: `Variant "${variantName}": background color is still the scaffold placeholder (${background})`,
                            hint: 'Replace with your actual theme colors',
                        })
                    }

                    // Check that syntax block is populated
                    const syntax = style['syntax'] as Record<string, unknown> | undefined
                    if (!syntax || Object.keys(syntax).length === 0) {
                        themeIssuesForFile.push({
                            file: `themes/${themeFile}`,
                            message: `Variant "${variantName}": "syntax" block is empty or missing`,
                            hint: 'Add syntax token color definitions',
                        })
                    }
                }
            }

            themeIssues.push(...themeIssuesForFile)
        }

        results.push({ file: 'themes/', issues: themeIssues })
    }

    // ── language validation ───────────────────────────────────────────────────

    if (hasLanguage) {
        // Collect all language IDs from both uncommented and commented grammar sections
        const allLanguageIds = [
            ...grammarMatches.map(m => m[1]),
            ...commentedGrammarMatches.map(m => m[1]),
        ]

        for (const langId of allLanguageIds) {
            const langDir = path.join(callerDir, 'languages', langId)
            const langIssues: Issue[] = []

            if (!(await fs.pathExists(langDir))) {
                langIssues.push({
                    file: `languages/${langId}/`,
                    message: `Language directory does not exist`,
                    hint: `Expected at ${path.join('languages', langId)}`,
                })
                results.push({ file: `languages/${langId}/`, issues: langIssues })
                continue
            }

            // config.toml checks
            const configPath = path.join(langDir, 'config.toml')
            const configIssues: Issue[] = []

            if (!(await fs.pathExists(configPath))) {
                configIssues.push({
                    file: `languages/${langId}/config.toml`,
                    message: 'config.toml is missing',
                })
            } else {
                const configContent = await fs.readFile(configPath, 'utf-8')

                if (!tomlHasUncommentedKey(configContent, 'name')) {
                    configIssues.push({
                        file: `languages/${langId}/config.toml`,
                        message: 'Missing required field: name',
                    })
                }

                if (!tomlHasUncommentedKey(configContent, 'grammar')) {
                    configIssues.push({
                        file: `languages/${langId}/config.toml`,
                        message: 'Missing required field: grammar',
                    })
                }

                // path_suffixes is commented out in scaffold — flag it
                if (!tomlHasUncommentedKey(configContent, 'path_suffixes')) {
                    configIssues.push({
                        file: `languages/${langId}/config.toml`,
                        message: 'path_suffixes is not set — files won\'t be associated with this language',
                        hint: 'Uncomment and fill in path_suffixes (e.g., ["myl"])',
                    })
                }

                // line_comments is commented out in scaffold — flag it
                if (!tomlHasUncommentedKey(configContent, 'line_comments')) {
                    configIssues.push({
                        file: `languages/${langId}/config.toml`,
                        message: 'line_comments is not set — toggle-comment keybind won\'t work',
                        hint: 'Uncomment and set line_comments (e.g., ["// "])',
                    })
                }
            }

            results.push({ file: `languages/${langId}/config.toml`, issues: configIssues })

            // highlights.scm checks
            const highlightsPath = path.join(langDir, 'highlights.scm')
            const highlightIssues: Issue[] = []

            if (!(await fs.pathExists(highlightsPath))) {
                highlightIssues.push({
                    file: `languages/${langId}/highlights.scm`,
                    message: 'highlights.scm is missing',
                    hint: 'Without it, no syntax highlighting will appear',
                })
            } else {
                const highlightsContent = await fs.readFile(highlightsPath, 'utf-8')
                // Count non-comment, non-empty lines with actual query patterns
                const activeLines = highlightsContent
                    .split('\n')
                    .filter(l => l.trim() && !l.trim().startsWith(';'))
                if (activeLines.length <= 3) {
                    highlightIssues.push({
                        file: `languages/${langId}/highlights.scm`,
                        message: 'Only scaffold starter patterns present — no real grammar queries added yet',
                        hint: 'Add tree-sitter queries matching your language\'s grammar node types',
                    })
                }
            }

            results.push({ file: `languages/${langId}/highlights.scm`, issues: highlightIssues })
        }
    }

    // ── render results ────────────────────────────────────────────────────────

    const allIssues = results.flatMap(r => r.issues)
    const fileGroups = results.filter(r => r.issues.length > 0)

    if (fileGroups.length === 0) {
        p.log.success(color.green('No issues found. Your extension config looks good!'))
        p.outro(
            `${color.dim('Load it in Zed:')} Extensions ${color.dim('>')} Install Dev Extension`
        )
        return
    }

    for (const group of fileGroups) {
        p.log.warn(`${color.yellow(color.bold(group.issues[0].file))}`)
        for (const issue of group.issues) {
            process.stdout.write(`  ${color.red('✗')} ${issue.message}\n`)
            if (issue.hint) {
                process.stdout.write(`    ${color.dim('→')} ${color.dim(issue.hint)}\n`)
            }
        }
        process.stdout.write('\n')
    }

    const issueCount = allIssues.length
    p.outro(
        `${color.red(`${issueCount} issue${issueCount === 1 ? '' : 's'} found`)} — fix the above before publishing`
    )
}

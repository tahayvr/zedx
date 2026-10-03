import path from 'path';
import { fileURLToPath } from 'url';

import * as p from '@clack/prompts';
import ejs from 'ejs';
import fs from 'fs-extra';
import color from 'picocolors';
import simpleGit from 'simple-git';
import { parse as parseToml } from 'smol-toml';

import { loadExtensionManifest, reportIssues, validateExtension } from './check.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isDev = __dirname.includes('/src/');
const PROJECT_ROOT = isDev ? path.join(__dirname, '..') : __dirname;
const TEMPLATE_DIR = path.join(PROJECT_ROOT, 'templates');

const REGISTRY_REPO = 'zed-industries/extensions';
const REGISTRY_INDEX_URL = `https://raw.githubusercontent.com/${REGISTRY_REPO}/main/extensions.toml`;
const REGISTRY_TIMEOUT_MS = 8000;
const PUBLISHING_GUIDE_URL = 'https://zed.dev/docs/extensions/publishing/publishing-guide';
const WORKFLOW_PATH = path.join('.github', 'workflows', 'release.yml');

interface RegistryEntry {
    version?: string;
    submodule?: string;
}

function tomlString(table: Record<string, unknown>, key: string): string | undefined {
    const value = table[key];
    return typeof value === 'string' ? value : undefined;
}

// The registry's entry for this extension: null when it isn't published yet,
// undefined when the registry couldn't be read (offline, rate-limited).
async function fetchRegistryEntry(id: string): Promise<RegistryEntry | null | undefined> {
    try {
        const response = await fetch(REGISTRY_INDEX_URL, {
            signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
        });
        if (!response.ok) return undefined;

        const registry = parseToml(await response.text()) as Record<string, unknown>;
        const entry = registry[id];
        if (!entry || typeof entry !== 'object') return null;

        const table = entry as Record<string, unknown>;
        return { version: tomlString(table, 'version'), submodule: tomlString(table, 'submodule') };
    } catch {
        return undefined;
    }
}

// The extension's directory relative to its git root, '' when it is the root.
// The registry needs it as `path` when the extension lives in a subdirectory.
async function extensionSubPath(callerDir: string, repoRoot: string): Promise<string> {
    const [extensionDir, root] = await Promise.all([fs.realpath(callerDir), fs.realpath(repoRoot)]);
    return path.relative(root, extensionDir).split(path.sep).join('/');
}

// zedx publish
export async function runPublish(callerDir: string): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx publish '))} ${color.blue('Preparing a registry submission…')}`,
    );

    const manifest = await loadExtensionManifest(callerDir);
    const issueCount = reportIssues(await validateExtension(callerDir, manifest));
    if (issueCount > 0) {
        p.outro(
            `${color.red(`${issueCount} issue${issueCount === 1 ? '' : 's'} found`)} — fix the above, then run ${color.cyan('zedx publish')} again`,
        );
        process.exit(1);
    }
    p.log.success('Extension passes zedx check.');

    // validateExtension has already rejected a missing id, version or repository.
    const id = tomlString(manifest.toml, 'id') ?? '';
    const version = tomlString(manifest.toml, 'version') ?? '';
    const repository = tomlString(manifest.toml, 'repository') ?? '';

    // The registry pins a pushed commit of a public HTTPS repo as a submodule.
    const git = simpleGit(callerDir);
    if (!(await git.checkIsRepo())) {
        p.log.error(
            color.red(
                'Not a git repository — the registry adds your extension as a git submodule.',
            ),
        );
        process.exit(1);
    }

    const status = await git.status();
    const blockers: string[] = [];
    if (!repository.startsWith('https://')) {
        blockers.push(
            'repository in extension.toml must be an HTTPS URL; the registry does not accept SSH URLs.',
        );
    }
    if (!status.isClean()) {
        blockers.push('There are uncommitted changes. The registry pins a commit, so commit them.');
    }
    if (!status.current || status.detached) {
        blockers.push('HEAD is detached. The submitted commit has to be on a branch.');
    } else if (!status.tracking) {
        blockers.push(`Branch ${status.current} has no upstream. Push it first.`);
    } else if (status.ahead > 0) {
        blockers.push(
            `${status.ahead} commit${status.ahead === 1 ? ' is' : 's are'} not pushed yet.`,
        );
    }

    if (blockers.length > 0) {
        for (const blocker of blockers) p.log.error(color.red(blocker));
        p.outro(`Fix the above, then run ${color.cyan('zedx publish')} again`);
        process.exit(1);
    }
    p.log.success('Git state is ready: clean, on a branch, and pushed.');

    const repoRoot = (await git.revparse(['--show-toplevel'])).trim();
    const subPath = await extensionSubPath(callerDir, repoRoot);

    const spinner = p.spinner();
    spinner.start('Looking up the extension registry...');
    const entry = await fetchRegistryEntry(id);
    if (entry === undefined) {
        spinner.stop(color.yellow('Could not read the registry — assuming a first submission.'));
    } else if (entry === null) {
        spinner.stop(`${color.cyan(id)} is not in the registry yet — this is a first submission.`);
    } else {
        spinner.stop(`${color.cyan(id)} is published at v${entry.version ?? '?'}.`);
    }

    if (entry && entry.version === version) {
        p.log.error(
            color.red(`v${version} is already in the registry.`) +
                ` Bump it with ${color.cyan('zedx version patch|minor|major')}, commit and push, then run this again.`,
        );
        process.exit(1);
    }

    const submodule = entry?.submodule ?? `extensions/${id}`;
    const fork = `your fork of ${REGISTRY_REPO}`;

    if (entry) {
        p.note(
            `In ${fork} (synced with upstream):\n\n` +
                `1. Move the submodule to your latest commit:\n` +
                `     git submodule update --init --remote ${submodule}\n` +
                `     git add ${submodule}\n\n` +
                `2. In extensions.toml, under [${id}], set:\n` +
                `     version = "${version}"\n\n` +
                `3. Commit and open a pull request against ${REGISTRY_REPO}.`,
            `Update ${id} to v${version}`,
        );
    } else {
        const tomlEntry =
            `     [${id}]\n` +
            `     submodule = "${submodule}"\n` +
            (subPath ? `     path = "${subPath}"\n` : '') +
            `     version = "${version}"`;

        p.note(
            `In ${fork}:\n\n` +
                `1. Add the extension as a submodule:\n` +
                `     git submodule add ${repository} ${submodule}\n` +
                `     git add ${submodule}\n\n` +
                `2. Add this entry to extensions.toml:\n` +
                `${tomlEntry}\n\n` +
                `3. Run pnpm sort-extensions, commit, and open a pull request\n` +
                `   against ${REGISTRY_REPO}.`,
            `Submit ${id} v${version}`,
        );
    }

    p.outro(
        `${color.dim('One extension per pull request. Full guide:')} ${color.underline(color.blue(PUBLISHING_GUIDE_URL))}\n\n` +
            `  ${color.dim('Run')} ${color.cyan('zedx publish workflow')} ${color.dim('to have later updates opened for you on each release tag.')}`,
    );
}

// zedx publish workflow
export async function publishWorkflow(callerDir: string): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx publish workflow '))} ${color.blue('Adding a release workflow…')}`,
    );

    const manifest = await loadExtensionManifest(callerDir);
    const id = tomlString(manifest.toml, 'id');
    if (!id) {
        p.log.error(color.red('Could not read extension id from extension.toml.'));
        process.exit(1);
    }

    // Workflows only run from the repository root, which isn't always the
    // extension directory.
    const git = simpleGit(callerDir);
    const repoRoot = (await git.checkIsRepo())
        ? (await git.revparse(['--show-toplevel'])).trim()
        : callerDir;
    const workflowPath = path.join(repoRoot, WORKFLOW_PATH);

    if (await fs.pathExists(workflowPath)) {
        const overwrite = await p.confirm({
            message: `${WORKFLOW_PATH} already exists. Replace it?`,
            initialValue: false,
        });
        if (p.isCancel(overwrite) || !overwrite) {
            p.cancel('Cancelled.');
            process.exit(0);
        }
    }

    const pushTo = await p.text({
        message: `Your fork of ${REGISTRY_REPO} (owner/repo):`,
        placeholder: 'your-name/extensions',
        validate: value => {
            if (!/^[\w.-]+\/[\w.-]+$/.test((value ?? '').trim())) return 'Use the form owner/repo';
        },
    });
    if (p.isCancel(pushTo)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const template = await fs.readFile(path.join(TEMPLATE_DIR, 'publish/release.yml.ejs'), 'utf-8');
    await fs.outputFile(workflowPath, ejs.render(template, { id, pushTo: String(pushTo).trim() }));
    p.log.success(`Created ${color.cyan(WORKFLOW_PATH)}`);

    p.outro(
        `${color.yellow('⚡')} ${color.bold('Next steps')}\n\n` +
            `  ${color.gray('1.')} Add a ${color.white('COMMITTER_TOKEN')} secret to this repository: a personal access\n` +
            `     token with the ${color.white('repo')} and ${color.white('workflow')} scopes\n` +
            `  ${color.gray('2.')} Release with ${color.cyan('zedx version patch|minor|major')}, commit, then push a\n` +
            `     matching tag, e.g. ${color.white('git tag v1.2.3 && git push --tags')}\n\n` +
            `  ${color.dim('The workflow opens update pull requests only. The first submission is manual:')}\n` +
            `  ${color.dim('run')} ${color.cyan('zedx publish')} ${color.dim('for the steps.')}`,
    );
}

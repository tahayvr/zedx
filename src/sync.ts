import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import fs from 'fs-extra';
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser';
import color from 'picocolors';
import simpleGit, { type SimpleGit } from 'simple-git';

import { createPrivateRepo, ghStatus } from './github.js';
import {
    applyMergeEdits,
    detectIndent,
    diffLines,
    equalIgnoring,
    IDENTITY_TRANSFORM,
    ignoredKeysTransform,
    isPlainObject,
    mergeJson,
    parseJsonc,
    type FileTransform,
    type MergeConflict,
} from './sync-merge.js';
import type { SyncConfig, ConflictStrategy, ZedPaths } from './types/index.js';
import { resolveZedPaths } from './zed-paths.js';

export { detectIndent } from './sync-merge.js';

const ZEDX_CONFIG_DIR = path.join(os.homedir(), '.config', 'zedx');
const ZEDX_CONFIG_PATH = path.join(ZEDX_CONFIG_DIR, 'config.json');
// Copy of every tracked file as of the last successful sync. Its presence is
// how a later run tells "deleted on one side" from "never synced", and the
// settings.json copy is the common ancestor for key-level merges.
const ZEDX_BASE_DIR = path.join(ZEDX_CONFIG_DIR, 'base');
// Names the repo and branch the base was taken from. A base from anywhere
// else says nothing about what was deleted here.
const ZEDX_BASE_SOURCE_PATH = path.join(ZEDX_BASE_DIR, '.source');
// Local files are copied here before a sync overwrites or deletes them. Kept
// outside Zed's config dir because Zed loads every file in themes/.
export const ZEDX_BACKUP_DIR = path.join(ZEDX_CONFIG_DIR, 'backups');
// How many changed lines of a whole-file conflict to preview before asking.
const DIFF_PREVIEW_LINES = 40;

// Config helpers
interface PersistedConfig extends SyncConfig {
    lastSync?: string; // ISO timestamp of the last successful sync
}

async function readSyncConfig(): Promise<PersistedConfig | null> {
    if (!(await fs.pathExists(ZEDX_CONFIG_PATH))) {
        return null;
    }
    return fs.readJson(ZEDX_CONFIG_PATH) as Promise<PersistedConfig>;
}

export async function requireSyncConfig(): Promise<PersistedConfig> {
    const config = await readSyncConfig();
    if (!config) {
        p.log.error(
            color.red('No sync config found. Run ') +
                color.cyan('zedx sync init') +
                color.red(' first.'),
        );
        process.exit(1);
    }
    return config;
}

async function writeSyncConfig(config: PersistedConfig): Promise<void> {
    await fs.ensureDir(ZEDX_CONFIG_DIR);
    await fs.writeJson(ZEDX_CONFIG_PATH, config, { spaces: 4 });
}

// Temp dir helper
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zedx-sync-'));
    try {
        return await fn(tmp);
    } finally {
        await fs.remove(tmp);
    }
}

// A single trackable file in the sync loop — either one of the fixed
// settings/keymap/tasks files, or one dynamically discovered snippet file.
export interface SyncFileEntry {
    key: string;
    repoPath: string;
    localPath: string;
    label: string;
}

// List *.json filenames directly inside a directory (empty if the directory
// doesn't exist). Used to discover snippet files, which — unlike
// settings/keymap/tasks — aren't a fixed, known set of names.
async function listJsonFiles(dir: string): Promise<string[]> {
    if (!(await fs.pathExists(dir))) return [];
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
        .filter(e => e.isFile() && e.name.endsWith('.json'))
        .map(e => e.name)
        .sort();
}

// Build one SyncFileEntry per filename present on either side (or in the
// base, so a file deleted on both sides still gets its base entry cleaned up).
// Snippets and local themes live as arbitrarily-named collections of files
// rather than one fixed file, so the entry list has to be discovered from
// disk instead of being hardcoded.
async function buildDirFileEntries(
    dirs: { local: string; remote: string; base?: string },
    keyPrefix: string,
    label: string,
): Promise<SyncFileEntry[]> {
    const [localFiles, remoteFiles, baseFiles] = await Promise.all([
        listJsonFiles(dirs.local),
        listJsonFiles(dirs.remote),
        dirs.base ? listJsonFiles(dirs.base) : [],
    ]);
    const names = [...new Set([...localFiles, ...remoteFiles, ...baseFiles])].sort();

    return names.map(name => ({
        key: `${keyPrefix}:${name}`,
        repoPath: path.join(dirs.remote, name),
        localPath: path.join(dirs.local, name),
        label: `${label}: ${name}`,
    }));
}

export async function buildSnippetFileEntries(
    localSnippetsDir: string,
    remoteSnippetsDir: string,
    baseSnippetsDir?: string,
): Promise<SyncFileEntry[]> {
    return buildDirFileEntries(
        { local: localSnippetsDir, remote: remoteSnippetsDir, base: baseSnippetsDir },
        'snippet',
        'Snippet',
    );
}

export async function buildThemeFileEntries(
    localThemesDir: string,
    remoteThemesDir: string,
    baseThemesDir?: string,
): Promise<SyncFileEntry[]> {
    return buildDirFileEntries(
        { local: localThemesDir, remote: remoteThemesDir, base: baseThemesDir },
        'theme',
        'Theme',
    );
}

const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, { id: string; label: string }>> = {
    darwin: { id: 'macos', label: 'macOS' },
    linux: { id: 'linux', label: 'Linux' },
    win32: { id: 'windows', label: 'Windows' },
};

// Where the keymap lives in the sync repo: one shared keymap.json, or one
// file per OS when keymaps are kept per platform.
export function keymapRepoFile(
    perPlatform: boolean,
    platform: NodeJS.Platform = process.platform,
): { name: string; label: string } {
    const names = PLATFORM_NAMES[platform];
    if (!perPlatform || !names) return { name: 'keymap.json', label: 'Key bindings' };
    return { name: `keymap.${names.id}.json`, label: `Key bindings (${names.label})` };
}

// Every file a sync could touch, mapped between the Zed config dir and a
// checkout of the sync repo.
async function collectSyncFiles(
    zedPaths: ZedPaths,
    repoDir: string,
    config: SyncConfig,
): Promise<SyncFileEntry[]> {
    const fixed = (key: string, name: string, localPath: string, label: string) => ({
        key,
        repoPath: path.join(repoDir, name),
        localPath,
        label,
    });

    const [snippetEntries, themeEntries] = await Promise.all([
        buildSnippetFileEntries(
            zedPaths.snippetsDir,
            path.join(repoDir, 'snippets'),
            path.join(ZEDX_BASE_DIR, 'snippets'),
        ),
        buildThemeFileEntries(
            zedPaths.themesDir,
            path.join(repoDir, 'themes'),
            path.join(ZEDX_BASE_DIR, 'themes'),
        ),
    ]);
    const keymap = keymapRepoFile(config.keymapPerPlatform ?? false);

    return [
        fixed('settings', 'settings.json', zedPaths.settings, 'Settings'),
        fixed('keymap', keymap.name, zedPaths.keymap, keymap.label),
        fixed('tasks', 'tasks.json', zedPaths.tasks, 'Tasks'),
        fixed('debug', 'debug.json', zedPaths.debug, 'Debug scenarios'),
        fixed('agents', 'AGENTS.md', zedPaths.agents, 'Agent rules'),
        ...snippetEntries,
        ...themeEntries,
    ];
}

// The selectable file groups, shared between `zedx sync select` and
// `zedx config files` so the two commands never drift out of sync with each
// other. 'snippets' and 'themes' are group keys, not literal files — each
// matches every dynamically discovered `snippet:<filename>` /
// `theme:<filename>` entry (see filterSyncFiles).
export const SYNC_FILE_GROUPS: Array<{ value: string; label: string; hint: string }> = [
    { value: 'settings', label: 'Settings', hint: 'settings.json' },
    { value: 'keymap', label: 'Key bindings', hint: 'keymap.json' },
    { value: 'tasks', label: 'Tasks', hint: 'tasks.json' },
    { value: 'debug', label: 'Debug scenarios', hint: 'debug.json' },
    { value: 'agents', label: 'Agent rules', hint: 'AGENTS.md' },
    { value: 'snippets', label: 'Snippets', hint: 'snippets/*.json' },
    { value: 'themes', label: 'Local themes', hint: 'themes/*.json' },
];

// Entry-key prefix of each directory-backed group, mapped to its group key.
const DIR_GROUP_KEYS: Record<string, string> = {
    'snippet:': 'snippets',
    'theme:': 'themes',
};

// Filter a file list down to the selected group keys. `undefined` means "no
// selection configured" — sync/show everything. Individual snippet and theme
// entries (key `snippet:<filename>` / `theme:<filename>`) are matched by
// their group key, since their exact filenames aren't known ahead of time.
export function filterSyncFiles<T extends { key: string }>(
    allFiles: T[],
    selectedKeys: string[] | undefined,
): T[] {
    if (!selectedKeys) return allFiles;
    return allFiles.filter(
        f =>
            selectedKeys.includes(f.key) ||
            Object.entries(DIR_GROUP_KEYS).some(
                ([prefix, group]) => f.key.startsWith(prefix) && selectedKeys.includes(group),
            ),
    );
}

// Pure decision matrix for what to do with a single tracked file, given its
// local/remote existence and (when both exist) content + mtime state. Kept
// side-effect free so the branching logic can be tested without spinning up
// real git repos or the filesystem.
export type FileSyncDecision =
    | 'both-missing'
    | 'push-new'
    | 'pull-new'
    | 'in-sync'
    | 'push-local-newer'
    | 'pull-remote-newer'
    | 'conflict'
    | 'delete-remote'
    | 'delete-local'
    | 'conflict-local-deleted'
    | 'conflict-remote-deleted';

export function decideFileSync(params: {
    localExists: boolean;
    remoteFileExists: boolean;
    contentsEqual: boolean;
    localMtime: Date;
    remoteMtime: Date;
    lastSync: Date | null;
    // True when an earlier run left this file in sync, so a side that is now
    // missing was deleted rather than never there.
    previouslySynced?: boolean;
}): FileSyncDecision {
    const { localExists, remoteFileExists, contentsEqual, localMtime, remoteMtime, lastSync } =
        params;
    const previouslySynced = params.previouslySynced ?? false;

    if (!localExists && !remoteFileExists) return 'both-missing';

    // No lastSync (first sync) means both sides are treated as changed,
    // which — when both exist and differ — falls through to 'conflict'.
    const localChanged = !lastSync || localMtime > lastSync;
    const remoteChanged = !lastSync || remoteMtime > lastSync;

    // One side is gone. A deletion only propagates when the surviving side
    // hasn't changed since; otherwise the two intents conflict.
    if (localExists && !remoteFileExists) {
        if (!previouslySynced) return 'push-new';
        return localChanged ? 'conflict-remote-deleted' : 'delete-local';
    }
    if (!localExists && remoteFileExists) {
        if (!previouslySynced) return 'pull-new';
        return remoteChanged ? 'conflict-local-deleted' : 'delete-remote';
    }
    if (contentsEqual) return 'in-sync';

    if (localChanged && !remoteChanged) return 'push-local-newer';
    if (remoteChanged && !localChanged) return 'pull-remote-newer';
    return 'conflict';
}

// Effective conflict-resolution strategy, given the persisted/CLI strategy and
// whether we're running unattended (daemon mode can't prompt).
export type ConflictResolution = 'local' | 'remote' | 'ask';

export function resolveConflictStrategy(
    conflict: ConflictStrategy,
    silent: boolean,
): ConflictResolution {
    if (conflict === 'local' || conflict === 'remote') return conflict;
    if (silent) return 'local';
    return 'ask';
}

// Reconcile auto_install_extensions in settings.json against the live
// extensions/index.json so that:
//   - newly installed extensions (present in index, missing from the list) are added as true
//   - uninstalled extensions (absent from index, set to true in the list) are removed
//   - entries explicitly set to false by the user are always preserved (user intent)
//
// Uses jsonc-parser to edit in place, so existing comments and formatting in
// settings.json are preserved across reconciles.
export async function reconcileAutoInstallExtensions(
    localSettingsPath: string,
    localExtensionsIndexPath: string,
    silent = false,
): Promise<void> {
    if (!(await fs.pathExists(localExtensionsIndexPath))) return;
    if (!(await fs.pathExists(localSettingsPath))) return;

    const raw = await fs.readFile(localSettingsPath, 'utf-8');
    const errors: ParseError[] = [];
    const parsed = parse(raw, errors, { allowTrailingComma: true, allowEmptyContent: true });
    if (errors.length > 0 || (parsed !== undefined && typeof parsed !== 'object')) {
        if (!silent)
            p.log.warn(
                color.yellow('Could not parse settings.json — skipping extension reconciliation.'),
            );
        return;
    }
    const settingsObj = (parsed ?? {}) as Record<string, unknown>;

    let installedIds: string[] = [];
    try {
        const indexJson = (await fs.readJson(localExtensionsIndexPath)) as {
            extensions?: Record<string, { dev?: boolean }>;
        };
        installedIds = Object.keys(indexJson.extensions ?? {}).filter(
            id => !indexJson.extensions![id]?.dev,
        );
    } catch {
        if (!silent)
            p.log.warn(
                color.yellow(
                    'Could not parse extensions/index.json — skipping extension reconciliation.',
                ),
            );
        return;
    }

    const existing =
        typeof settingsObj['auto_install_extensions'] === 'object' &&
        settingsObj['auto_install_extensions'] !== null
            ? (settingsObj['auto_install_extensions'] as Record<string, boolean>)
            : {};

    const installedSet = new Set(installedIds);
    const reconciled: Record<string, boolean> = {};

    // Keep all explicit false entries (user said "never install this")
    for (const [id, val] of Object.entries(existing)) {
        if (val === false) reconciled[id] = false;
    }
    // Add every currently installed extension as true
    for (const id of installedIds) {
        reconciled[id] = true;
    }

    const added = installedIds.filter(id => !(id in existing));
    const removed = Object.keys(existing).filter(
        id => existing[id] === true && !installedSet.has(id),
    );

    if (added.length === 0 && removed.length === 0) return;

    const formattingOptions = detectIndent(raw);
    const edits = modify(raw, ['auto_install_extensions'], reconciled, { formattingOptions });
    const next = applyEdits(raw, edits);

    await fs.ensureDir(path.dirname(localSettingsPath));
    await fs.writeFile(localSettingsPath, next, 'utf-8');

    if (!silent) {
        if (added.length > 0)
            p.log.info(
                `Added ${color.cyan(String(added.length))} new extension(s) to ${color.dim('auto_install_extensions')}: ${added.join(', ')}`,
            );
        if (removed.length > 0)
            p.log.info(
                `Removed ${color.cyan(String(removed.length))} uninstalled extension(s) from ${color.dim('auto_install_extensions')}: ${removed.join(', ')}`,
            );
    }
}

function gitErrorMessage(err: unknown): string {
    return (err instanceof Error ? err.message : String(err)).trim();
}

// Clone the sync branch into `dir`. Returns false when the remote has no such
// branch yet (an empty repo, or the first push to a new branch) and throws on
// any other failure, so a network or auth problem is never mistaken for an
// empty remote.
export async function cloneRemote(config: SyncConfig, dir: string): Promise<boolean> {
    let heads: string;
    try {
        heads = await simpleGit().listRemote([
            '--heads',
            config.syncRepo,
            `refs/heads/${config.branch}`,
        ]);
    } catch (err) {
        throw new Error(`Could not reach ${config.syncRepo}:\n${gitErrorMessage(err)}`, {
            cause: err,
        });
    }
    if (!heads.trim()) return false;

    try {
        await simpleGit(dir).clone(config.syncRepo, dir, ['--branch', config.branch]);
    } catch (err) {
        throw new Error(`Could not clone ${config.syncRepo}:\n${gitErrorMessage(err)}`, {
            cause: err,
        });
    }
    return true;
}

async function readIfExists(filePath: string): Promise<string | null> {
    return (await fs.pathExists(filePath)) ? fs.readFile(filePath, 'utf-8') : null;
}

// What one sync (or status) run knows about the two sides.
interface SyncContext {
    git: SimpleGit;
    repoDir: string;
    remoteExists: boolean;
    lastSync: Date | null;
    ignoredSettings: string[];
    // The base was recorded against this repo and branch.
    baseUsable: boolean;
    // No tracked file exists on that side: a new or reset machine (or a wiped
    // repo), where a missing file means "not there yet" rather than "deleted".
    localLooksFresh: boolean;
    remoteLooksFresh: boolean;
}

interface FileState {
    local: string | null;
    remote: string | null;
    base: string | null;
    transform: FileTransform;
    decision: FileSyncDecision;
    localMtime: Date;
    remoteMtime: Date;
}

function baseSource(config: SyncConfig): string {
    return `${config.syncRepo}#${config.branch}`;
}

async function noneExist(paths: string[]): Promise<boolean> {
    const existing = await Promise.all(paths.map(filePath => fs.pathExists(filePath)));
    return !existing.some(Boolean);
}

async function buildSyncContext(
    config: PersistedConfig,
    repoDir: string,
    remoteExists: boolean,
    allFiles: SyncFileEntry[],
): Promise<SyncContext> {
    const recordedSource = await readIfExists(ZEDX_BASE_SOURCE_PATH);

    return {
        git: simpleGit(repoDir),
        repoDir,
        remoteExists,
        lastSync: config.lastSync ? new Date(config.lastSync) : null,
        ignoredSettings: config.ignoredSettings ?? [],
        baseUsable: remoteExists && recordedSource === baseSource(config),
        localLooksFresh: await noneExist(allFiles.map(f => f.localPath)),
        remoteLooksFresh: await noneExist(allFiles.map(f => f.repoPath)),
    };
}

// Read both sides of a tracked file and run them through the decision matrix.
// `simulatedLocal` stands in for the on-disk content when a caller wants to
// know what a sync would do after rewriting the file, without rewriting it.
async function inspectFile(
    file: SyncFileEntry,
    ctx: SyncContext,
    simulatedLocal?: string,
): Promise<FileState> {
    const transform =
        file.key === 'settings' ? ignoredKeysTransform(ctx.ignoredSettings) : IDENTITY_TRANSFORM;
    const relPath = path.relative(ctx.repoDir, file.repoPath);

    const onDisk = await readIfExists(file.localPath);
    const local = simulatedLocal ?? onDisk;
    const remote = ctx.remoteExists ? await readIfExists(file.repoPath) : null;
    const base = ctx.baseUsable ? await readIfExists(path.join(ZEDX_BASE_DIR, relPath)) : null;

    const contentsEqual = local !== null && remote !== null && transform.equal(local, remote);

    let localMtime = new Date(0);
    let remoteMtime = new Date(0);

    if (!contentsEqual) {
        if (onDisk !== null) {
            // A simulated rewrite counts as modified now, as the real one would be.
            localMtime = local === onDisk ? (await fs.stat(file.localPath)).mtime : new Date();
        }
        if (remote !== null) {
            // Use the git commit timestamp for the remote file — the temp dir
            // mtime is just when git checked it out, not when it was actually
            // changed, so it can't be used for comparison.
            try {
                const gitLog = await ctx.git.log({
                    file: relPath,
                    maxCount: 1,
                    format: { date: '%cI' },
                });
                if (gitLog.latest?.date) remoteMtime = new Date(gitLog.latest.date);
            } catch {
                // fall back to epoch — remote will appear unchanged
            }
        }
    }

    const decision = decideFileSync({
        localExists: local !== null,
        remoteFileExists: remote !== null,
        contentsEqual,
        localMtime,
        remoteMtime,
        lastSync: ctx.lastSync,
        previouslySynced:
            base !== null &&
            !(local === null && ctx.localLooksFresh) &&
            !(remote === null && ctx.remoteLooksFresh),
    });

    return { local, remote, base, transform, decision, localMtime, remoteMtime };
}

// Compact one-line rendering of a settings value for conflict prompts.
function previewValue(value: unknown): string {
    if (value === undefined) return color.dim('(not set)');
    const text = JSON.stringify(value);
    return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

export function printDiff(
    local: string,
    remote: string,
    labels: { local: string; remote: string } = { local: 'local', remote: 'remote' },
): void {
    const diff = diffLines(local, remote);
    if (!diff) {
        p.log.message(color.dim('(too many differences to preview)'));
        return;
    }

    const changed = diff.filter(line => line.type !== 'same');
    const width = Math.max(labels.local.length, labels.remote.length);
    const lines = changed
        .slice(0, DIFF_PREVIEW_LINES)
        .map(line =>
            line.type === 'local'
                ? color.green(`${labels.local.padEnd(width)} │ ${line.text}`)
                : color.cyan(`${labels.remote.padEnd(width)} │ ${line.text}`),
        );
    if (changed.length > DIFF_PREVIEW_LINES) {
        lines.push(color.dim(`… ${changed.length - DIFF_PREVIEW_LINES} more changed lines`));
    }
    p.log.message(lines.join('\n'));
}

// zedx sync status
export async function syncStatus(): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx sync status '))} ${color.blue('Checking sync state…')}`,
    );

    const config = await requireSyncConfig();
    const zedPaths = resolveZedPaths();

    p.log.info(`Repo:   ${color.dim(config.syncRepo)} ${color.dim(`(${config.branch})`)}`);
    if (config.lastSync) {
        p.log.info(`Last sync: ${color.dim(new Date(config.lastSync).toLocaleString())}`);
    } else {
        p.log.info(`Last sync: ${color.dim('never')}`);
    }

    const spinner = p.spinner();

    await withTempDir(async tmp => {
        spinner.start(`Fetching ${config.syncRepo}...`);
        let remoteExists: boolean;
        try {
            remoteExists = await cloneRemote(config, tmp);
        } catch (err) {
            spinner.stop(color.red('Could not fetch the remote.'));
            throw err;
        }
        spinner.stop(
            remoteExists ? 'Remote fetched.' : color.yellow('Remote branch does not exist yet.'),
        );

        const allFiles = await collectSyncFiles(zedPaths, tmp, config);

        // Only report on the files an actual `zedx sync` would touch.
        const files = filterSyncFiles(allFiles, config.files);

        const ctx = await buildSyncContext(config, tmp, remoteExists, allFiles);
        const { lastSync } = ctx;

        // Track per-file actions needed for the outro message
        const toPush: string[] = [];
        const toPull: string[] = [];
        const toResolve: string[] = [];

        for (const file of files) {
            // Mirror runSync's reconcile-before-compare step so status reflects
            // what an actual `zedx sync` would do, without mutating the real
            // settings.json — reconcile a scratch copy instead.
            let simulatedLocal: string | undefined;
            if (file.key === 'settings' && (await fs.pathExists(file.localPath))) {
                const indexStat = await fs.stat(zedPaths.extensionsIndex).catch(() => null);
                if (!lastSync || (indexStat && indexStat.mtime > lastSync)) {
                    const scratchPath = path.join(tmp, '.status-settings-scratch.json');
                    await fs.copy(file.localPath, scratchPath);
                    await reconcileAutoInstallExtensions(
                        scratchPath,
                        zedPaths.extensionsIndex,
                        true,
                    );
                    simulatedLocal = await fs.readFile(scratchPath, 'utf-8');
                }
            }

            const { decision, localMtime, remoteMtime } = await inspectFile(
                file,
                ctx,
                simulatedLocal,
            );

            switch (decision) {
                case 'both-missing':
                    p.log.info(
                        `${color.bold(file.label)}: ${color.dim('not present on either side')}`,
                    );
                    break;
                case 'push-new':
                    p.log.warn(
                        `${color.bold(file.label)}: ${color.green('local only')} — not pushed yet`,
                    );
                    toPush.push(file.label);
                    break;
                case 'pull-new':
                    p.log.warn(
                        `${color.bold(file.label)}: ${color.cyan('remote only')} — not pulled yet`,
                    );
                    toPull.push(file.label);
                    break;
                case 'in-sync':
                    p.log.success(`${color.bold(file.label)}: in sync`);
                    break;
                case 'push-local-newer':
                    p.log.warn(
                        `${color.bold(file.label)}: ${color.green('local ahead')} — modified ${color.dim(localMtime.toLocaleString())}`,
                    );
                    toPush.push(file.label);
                    break;
                case 'pull-remote-newer':
                    p.log.warn(
                        `${color.bold(file.label)}: ${color.cyan('remote ahead')} — modified ${color.dim(remoteMtime.toLocaleString())}`,
                    );
                    toPull.push(file.label);
                    break;
                case 'delete-remote':
                    p.log.warn(
                        `${color.bold(file.label)}: ${color.green('deleted locally')} — will be removed from remote`,
                    );
                    toPush.push(file.label);
                    break;
                case 'delete-local':
                    p.log.warn(
                        `${color.bold(file.label)}: ${color.cyan('deleted on remote')} — local copy will be removed`,
                    );
                    toPull.push(file.label);
                    break;
                case 'conflict':
                    p.log.warn(
                        `${color.bold(file.label)}: ${color.yellow('conflict')} — both changed since last sync`,
                    );
                    toResolve.push(file.label);
                    break;
                case 'conflict-local-deleted':
                    p.log.warn(
                        `${color.bold(file.label)}: ${color.yellow('conflict')} — deleted locally, changed on remote`,
                    );
                    toResolve.push(file.label);
                    break;
                case 'conflict-remote-deleted':
                    p.log.warn(
                        `${color.bold(file.label)}: ${color.yellow('conflict')} — deleted on remote, changed locally`,
                    );
                    toResolve.push(file.label);
                    break;
            }
        }

        const singleAction = [toPush, toPull, toResolve].filter(a => a.length > 0).length === 1;
        const needsSync = toPush.length > 0 || toPull.length > 0 || toResolve.length > 0;

        if (needsSync) {
            if (singleAction && toPush.length > 0) {
                p.outro(
                    `Run ${color.cyan('zedx sync')} to push ${toPush.map(l => color.bold(l)).join(', ')} to remote.`,
                );
            } else if (singleAction && toPull.length > 0) {
                p.outro(
                    `Run ${color.cyan('zedx sync')} to pull ${toPull.map(l => color.bold(l)).join(', ')} from remote.`,
                );
            } else {
                p.outro(`Run ${color.cyan('zedx sync')} to resolve.`);
            }
        } else {
            p.outro('Everything is in sync.');
        }
    });
}

// zedx sync init
// Ask for a repo name and create it as a private repo with gh. Returns the
// clone URL; exits when gh fails.
async function createRepoWithGh(): Promise<string> {
    const name = await p.text({
        message: 'Repo name',
        placeholder: 'zed-config',
        defaultValue: 'zed-config',
        validate: v => {
            if (v && !/^[\w.-]+$/.test(v)) return 'Use letters, numbers, ".", "-", or "_"';
        },
    });

    if (p.isCancel(name)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const spinner = p.spinner();
    spinner.start(`Creating private repo ${name}...`);
    const result = createPrivateRepo(name);
    if ('error' in result) {
        spinner.stop(color.red('Could not create the repo.'));
        p.log.error(result.error);
        p.log.info(
            `Run ${color.cyan('zedx sync init')} again and choose an existing repo instead.`,
        );
        process.exit(1);
    }
    spinner.stop(`Created ${color.cyan(result.url)}`);
    return result.url;
}

export async function syncInit(): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx sync init '))} ${color.blue('Linking a git repo as the sync target…')}`,
    );

    const existing = await readSyncConfig();
    if (existing) {
        p.log.warn(
            `Sync is already configured.\n\n` +
                `  Repo:   ${color.cyan(existing.syncRepo)}\n` +
                `  Branch: ${color.cyan(existing.branch)}\n\n` +
                `  Run ${color.cyan('zedx config')} to make changes.`,
        );
        process.exit(0);
    }

    let repoUrl: string | undefined;
    let branchName = 'main';

    const gh = ghStatus();

    if (gh === 'ready') {
        const where = await p.select({
            message: 'Where should your Zed config live?',
            options: [
                {
                    value: 'create',
                    label: 'Create a new private GitHub repo',
                    hint: 'uses the GitHub CLI',
                },
                { value: 'existing', label: 'Use an existing repo' },
            ],
        });

        if (p.isCancel(where)) {
            p.cancel('Cancelled.');
            process.exit(0);
        }

        if (where === 'create') {
            repoUrl = await createRepoWithGh();
        }
    } else if (gh === 'logged-out') {
        p.log.info(
            color.dim(
                `Tip: run ${color.cyan('gh auth login')} first and zedx can create a private repo for you.`,
            ),
        );
    } else {
        p.log.info(
            color.dim(
                'Tip: with the GitHub CLI (gh) installed and logged in, zedx can create a private repo for you.',
            ),
        );
    }

    if (!repoUrl) {
        const repo = await p.text({
            message: 'Git repo URL (SSH or HTTPS)',
            placeholder: 'https://github.com/you/zed-config.git',
            validate: v => {
                if (!v?.trim()) return 'Repo URL is required';
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
            await Promise.race([
                git.listRemote(['--heads', repo as string]),
                new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('timeout')), 8000),
                ),
            ]);
            spinner.stop('Repo verified.');
        } catch {
            spinner.stop(color.red('Could not reach repo. Check the URL and your credentials.'));
            process.exit(1);
        }

        repoUrl = (repo as string).trim();
        branchName = ((branch as string) || 'main').trim();
    }

    const config: PersistedConfig = {
        syncRepo: repoUrl,
        branch: branchName,
        conflictStrategy: 'ask',
    };

    await writeSyncConfig(config);

    p.outro(
        `${color.green('✓')} Sync config saved to ${color.cyan(ZEDX_CONFIG_PATH)}\n\n` +
            `  Run ${color.cyan('zedx sync')} to sync your Zed config.`,
    );
}

export type { ConflictStrategy } from './types/index.js';

// zedx sync select
export async function syncSelect(): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx sync select '))} ${color.blue('Choose which files to sync…')}`,
    );

    await requireSyncConfig();

    const selected = await p.multiselect({
        message: 'Select files to sync',
        options: SYNC_FILE_GROUPS,
        required: true,
    });

    if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const selectedFiles = selected as string[];

    await runSync({ selectedFiles });
}

// zedx sync
export async function runSync(
    opts: { silent?: boolean; conflict?: ConflictStrategy; selectedFiles?: string[] } = {},
): Promise<void> {
    const { silent = false, selectedFiles } = opts;

    const config = await requireSyncConfig();

    // Conflict priority: explicit CLI flag > persisted config > default (ask)
    const conflict: ConflictStrategy = opts.conflict ?? config.conflictStrategy ?? 'ask';
    const strategy = resolveConflictStrategy(conflict, silent);
    const ignoredSettings = config.ignoredSettings ?? [];

    // In silent mode (daemon/watch), route all UI through plain console.log
    // Interactive conflict prompts fall back to "local wins".
    const log = {
        info: (msg: string) => {
            if (!silent) p.log.info(msg);
        },
        warn: (msg: string) => {
            if (!silent) p.log.warn(msg);
            else console.error(`[zedx] warn: ${msg}`);
        },
        success: (msg: string) => {
            if (!silent) p.log.success(msg);
        },
    };

    if (!silent) {
        console.log('');
        p.intro(`${color.bgBlue(color.bold(' zedx sync '))} ${color.blue('Syncing Zed config…')}`);
    }

    const zedPaths = resolveZedPaths();

    // Spinner shim: in silent mode just log to stderr so daemons can capture it
    const spinner = silent
        ? {
              start: (m: string) => console.error(`[zedx] ${m}`),
              stop: (m: string) => console.error(`[zedx] ${m}`),
          }
        : p.spinner();

    await withTempDir(async tmp => {
        // 1. Clone the remote repo
        const git = simpleGit(tmp);

        spinner.start(`Fetching ${config.syncRepo}...`);
        let remoteExists: boolean;
        try {
            remoteExists = await cloneRemote(config, tmp);
        } catch (err) {
            spinner.stop(color.red('Could not fetch the remote — nothing was changed.'));
            throw err;
        }

        if (remoteExists) {
            spinner.stop('Remote fetched.');
        } else {
            spinner.stop('Remote branch does not exist yet — will push fresh.');
            await git.init();
            // `git init` picks its own default branch name; the push below
            // needs the configured one.
            await git.raw(['symbolic-ref', 'HEAD', `refs/heads/${config.branch}`]);
            await git.addRemote('origin', config.syncRepo);
        }

        // 2. Determine what changed for each file
        const allFiles = await collectSyncFiles(zedPaths, tmp, config);

        // An explicit --select-style call wins; otherwise fall back to the
        // persisted default from `zedx config files` (undefined means sync
        // everything).
        const files = filterSyncFiles(allFiles, selectedFiles ?? config.files);

        const ctx = await buildSyncContext(config, tmp, remoteExists, allFiles);
        const { lastSync } = ctx;
        // A base recorded against another repo or branch (or a remote that
        // has no branch yet) describes nothing here; start it over.
        if (!ctx.baseUsable) await fs.remove(ZEDX_BASE_DIR);

        const relPath = (file: SyncFileEntry) => path.relative(tmp, file.repoPath);

        let anyChanges = false;
        const removedFromRepo: string[] = [];
        // Files this run left identical on both sides (or gone from both).
        const settled: SyncFileEntry[] = [];

        const backupLocal = async (file: SyncFileEntry) => {
            const backupPath = path.join(ZEDX_BACKUP_DIR, relPath(file));
            await fs.copy(file.localPath, backupPath, { overwrite: true });
            if (!silent) p.log.info(`Backed up ${file.label} to ${color.dim(backupPath)}`);
        };
        const writeRepo = async (file: SyncFileEntry, content: string) => {
            await fs.outputFile(file.repoPath, content, 'utf-8');
            anyChanges = true;
        };
        const writeLocal = async (file: SyncFileEntry, content: string, backup: boolean) => {
            if (backup) await backupLocal(file);
            await fs.outputFile(file.localPath, content, 'utf-8');
        };
        const removeRepo = async (file: SyncFileEntry) => {
            await fs.remove(file.repoPath);
            removedFromRepo.push(relPath(file));
            anyChanges = true;
        };
        const removeLocal = async (file: SyncFileEntry) => {
            await backupLocal(file);
            await fs.remove(file.localPath);
        };

        // Settle a conflict between the two sides: by strategy when one is
        // set (or the run is unattended), otherwise by asking.
        const pickSide = async (
            file: SyncFileEntry,
            situation: string,
            options: { local: string; remote: string },
            hints: { local?: string; remote?: string } = {},
        ): Promise<'local' | 'remote'> => {
            if (strategy !== 'ask') {
                log.warn(
                    conflict === 'ask'
                        ? `${file.label} ${situation} — unattended run, keeping local.`
                        : `${file.label} ${situation} — using ${color.bold(strategy)}.`,
                );
                return strategy;
            }

            p.log.warn(color.yellow(`${file.label} ${situation}`));
            const choice = await p.select({
                message: `What should happen to ${color.bold(file.label)}?`,
                options: [
                    { value: 'local', label: options.local, hint: hints.local },
                    { value: 'remote', label: options.remote, hint: hints.remote },
                ],
            });
            if (p.isCancel(choice)) {
                p.cancel('Cancelled.');
                process.exit(0);
            }
            return choice as 'local' | 'remote';
        };

        // Key-level merge of settings.json: changes made on one side only are
        // combined, and only keys both sides changed need a decision. Returns
        // null when the file can't be merged that way, so the caller falls
        // back to choosing a whole file.
        const mergeSettings = async (
            local: string,
            remote: string,
            base: string | null,
        ): Promise<{ text: string; summary: string } | null> => {
            const localValue = parseJsonc(local);
            const remoteValue = parseJsonc(remote);
            if (!isPlainObject(localValue) || !isPlainObject(remoteValue)) return null;
            // Same values, different text (comments, formatting): nothing to
            // merge key by key.
            if (equalIgnoring(localValue, remoteValue, ignoredSettings)) return null;

            const baseValue = base === null ? undefined : parseJsonc(base);
            const { edits, conflicts } = mergeJson(
                baseValue,
                localValue,
                remoteValue,
                ignoredSettings,
            );

            let fromRemote: MergeConflict[] = [];
            if (conflicts.length > 0 && strategy === 'remote') {
                fromRemote = conflicts;
            } else if (conflicts.length > 0 && strategy === 'ask') {
                p.log.warn(
                    color.yellow(
                        `Settings: ${conflicts.length} key${conflicts.length === 1 ? '' : 's'} changed on both sides`,
                    ),
                );
                p.log.message(
                    conflicts
                        .map(
                            c =>
                                `${color.bold(c.keyPath.join('.'))}\n` +
                                `  ${color.green('local ')} ${previewValue(c.local)}\n` +
                                `  ${color.cyan('remote')} ${previewValue(c.remote)}`,
                        )
                        .join('\n'),
                );

                const choice = await p.select({
                    message: 'Which side should win for these keys?',
                    options: [
                        { value: 'local', label: 'Keep local for all' },
                        { value: 'remote', label: 'Use remote for all' },
                        ...(conflicts.length > 1
                            ? [{ value: 'each', label: 'Choose for each key' }]
                            : []),
                    ],
                });
                if (p.isCancel(choice)) {
                    p.cancel('Cancelled.');
                    process.exit(0);
                }

                if (choice === 'remote') {
                    fromRemote = conflicts;
                } else if (choice === 'each') {
                    for (const c of conflicts) {
                        const side = await p.select({
                            message: `${color.bold(c.keyPath.join('.'))}`,
                            options: [
                                { value: 'local', label: `Local: ${previewValue(c.local)}` },
                                { value: 'remote', label: `Remote: ${previewValue(c.remote)}` },
                            ],
                        });
                        if (p.isCancel(side)) {
                            p.cancel('Cancelled.');
                            process.exit(0);
                        }
                        if (side === 'remote') fromRemote.push(c);
                    }
                }
            } else if (conflicts.length > 0) {
                log.warn(
                    `Settings: ${conflicts.length} key(s) changed on both sides — keeping local for those.`,
                );
            }

            const text = applyMergeEdits(local, [
                ...edits,
                ...fromRemote.map(c => ({ keyPath: c.keyPath, value: c.remote })),
            ]);
            const summary =
                `${edits.length} change${edits.length === 1 ? '' : 's'} from remote` +
                (conflicts.length > 0
                    ? `, ${conflicts.length} conflict${conflicts.length === 1 ? '' : 's'} resolved`
                    : '');
            return { text, summary };
        };

        for (const file of files) {
            // Reconcile auto_install_extensions before content comparison so newly
            // installed/uninstalled extensions show up as drift and follow the normal
            // push path, rather than being swallowed by the "already in sync" check.
            // Gated on the extensions index mtime so most syncs skip the parse entirely.
            if (file.key === 'settings' && (await fs.pathExists(file.localPath))) {
                const indexStat = await fs.stat(zedPaths.extensionsIndex).catch(() => null);
                if (!lastSync || (indexStat && indexStat.mtime > lastSync)) {
                    await reconcileAutoInstallExtensions(
                        file.localPath,
                        zedPaths.extensionsIndex,
                        silent,
                    );
                }
            }

            const state = await inspectFile(file, ctx);
            const { transform, localMtime, remoteMtime } = state;
            // Each decision implies which sides exist; the fallbacks only
            // keep the types honest.
            const local = state.local ?? '';
            const remote = state.remote ?? '';

            switch (state.decision) {
                case 'both-missing':
                    // Most of the tracked files are optional; nothing to do
                    // or report when neither side has one.
                    break;

                case 'push-new':
                    log.info(`${file.label}: ${color.green('pushing')} (not in remote yet)`);
                    await writeRepo(file, transform.toRemote(local, null));
                    break;

                case 'pull-new':
                    log.info(`${file.label}: ${color.cyan('pulling')} (not found locally)`);
                    await writeLocal(file, transform.toLocal(remote, null), false);
                    break;

                case 'in-sync':
                    log.success(`${file.label}: ${color.dim('already in sync')}`);
                    break;

                case 'push-local-newer':
                    log.info(`${file.label}: ${color.green('pushing')} (local is newer)`);
                    await writeRepo(file, transform.toRemote(local, remote));
                    break;

                case 'pull-remote-newer':
                    log.info(`${file.label}: ${color.cyan('pulling')} (remote is newer)`);
                    await writeLocal(file, transform.toLocal(remote, local), true);
                    break;

                case 'delete-remote':
                    log.info(
                        `${file.label}: ${color.green('removing from remote')} (deleted locally)`,
                    );
                    await removeRepo(file);
                    break;

                case 'delete-local':
                    log.info(
                        `${file.label}: ${color.cyan('removing local copy')} (deleted on remote)`,
                    );
                    await removeLocal(file);
                    break;

                case 'conflict-local-deleted': {
                    const side = await pickSide(
                        file,
                        'was deleted locally but changed on the remote',
                        { local: 'Delete it on the remote too', remote: 'Restore it from remote' },
                    );
                    if (side === 'local') await removeRepo(file);
                    else await writeLocal(file, transform.toLocal(remote, null), false);
                    break;
                }

                case 'conflict-remote-deleted': {
                    const side = await pickSide(
                        file,
                        'was deleted on the remote but changed locally',
                        { local: 'Keep it and push it again', remote: 'Delete the local copy' },
                    );
                    if (side === 'local') await writeRepo(file, transform.toRemote(local, null));
                    else await removeLocal(file);
                    break;
                }

                case 'conflict': {
                    if (file.key === 'settings') {
                        const merged = await mergeSettings(local, remote, state.base);
                        if (merged) {
                            if (merged.text !== local) await writeLocal(file, merged.text, true);
                            const nextRemote = transform.toRemote(merged.text, remote);
                            if (nextRemote !== remote) await writeRepo(file, nextRemote);
                            log.info(
                                `${file.label}: ${color.magenta('merged')} (${merged.summary})`,
                            );
                            break;
                        }
                    }

                    if (strategy === 'ask') printDiff(local, remote);
                    const side = await pickSide(
                        file,
                        'changed on both sides',
                        { local: 'Keep local', remote: 'Use remote' },
                        {
                            local: `modified ${localMtime.toLocaleString()}`,
                            remote: `modified ${remoteMtime.toLocaleString()}`,
                        },
                    );
                    if (side === 'local') await writeRepo(file, transform.toRemote(local, remote));
                    else await writeLocal(file, transform.toLocal(remote, local), true);
                    break;
                }
            }

            settled.push(file);
        }

        // 3. Commit + push if any local files were written to the repo
        if (anyChanges) {
            spinner.start('Pushing changes to remote...');
            try {
                // Only stage paths this sync could have touched — `files`
                // includes every tracked key regardless of whether it exists,
                // and `git add` throws on a pathspec that matches nothing.
                // Removed files are staged by path too, which records the
                // deletion.
                const stageable: string[] = [...removedFromRepo];
                for (const f of files) {
                    if (await fs.pathExists(f.repoPath)) stageable.push(relPath(f));
                }
                if (stageable.length > 0) await git.raw(['add', '-A', '--', ...stageable]);

                const status = await git.status();
                if (status.staged.length > 0) {
                    if (!(await git.raw(['config', 'user.name']).catch(() => ''))) {
                        await git.addConfig('user.name', 'zedx');
                    }
                    if (!(await git.raw(['config', 'user.email']).catch(() => ''))) {
                        await git.addConfig('user.email', 'zedx@localhost');
                    }

                    const timestamp = new Date().toISOString();
                    await git.commit(`sync: ${timestamp} from ${os.hostname()}`);
                    try {
                        await git.push('origin', config.branch, ['--set-upstream']);
                    } catch {
                        await git.push('origin', config.branch);
                    }
                    spinner.stop('Pushed.');
                } else {
                    spinner.stop('Nothing staged to push.');
                }
            } catch (err) {
                spinner.stop(color.red('Failed to push changes.'));
                const message = err instanceof Error ? err.message : String(err);
                if (silent) {
                    console.error(`[zedx] error: ${message}`);
                } else {
                    p.log.error(color.red(message));
                }
                throw err;
            }
        }

        // 4. Record what both sides now agree on, for the next run's deletion
        // detection and settings merge.
        await fs.outputFile(ZEDX_BASE_SOURCE_PATH, baseSource(config), 'utf-8');
        for (const file of settled) {
            const basePath = path.join(ZEDX_BASE_DIR, relPath(file));
            if (await fs.pathExists(file.repoPath)) {
                await fs.copy(file.repoPath, basePath, { overwrite: true });
            } else {
                await fs.remove(basePath);
            }
        }
    });

    // 5. Save last sync timestamp
    await writeSyncConfig({ ...config, lastSync: new Date().toISOString() });

    if (!silent) p.outro(`${color.green('✓')} Sync complete.`);
}

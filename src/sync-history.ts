import path from 'path';

import * as p from '@clack/prompts';
import fs from 'fs-extra';
import color from 'picocolors';
import simpleGit from 'simple-git';

import { ignoredKeysTransform } from './sync-merge.js';
import { ZEDX_BACKUP_DIR, cloneRemote, printDiff, requireSyncConfig, withTempDir } from './sync.js';
import type { ZedPaths } from './types/index.js';
import { resolveZedPaths } from './zed-paths.js';

// Separators for `git log` output that can't appear in commit subjects or paths.
const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';
const LOG_FORMAT = `${RECORD_SEP}%H${FIELD_SEP}%cI${FIELD_SEP}%s`;

export interface HistoryFile {
    // A (added), M (modified), D (deleted), …
    status: string;
    path: string;
}

export interface HistoryEntry {
    hash: string;
    date: Date;
    // The machine that made the sync commit, when the subject names one.
    host: string | null;
    files: HistoryFile[];
}

// Parse `git log --name-status` output written with LOG_FORMAT.
export function parseHistory(output: string): HistoryEntry[] {
    return output
        .split(RECORD_SEP)
        .filter(record => record.trim())
        .map(record => {
            const [header, ...fileLines] = record.split('\n');
            const [hash, date, subject] = header.split(FIELD_SEP);
            const files = fileLines
                .filter(line => line.trim())
                .map(line => {
                    // Renames and copies list the old path first; keep the new one.
                    const [status, ...paths] = line.split('\t');
                    return { status: status.charAt(0), path: paths[paths.length - 1] };
                });
            return {
                hash,
                date: new Date(date),
                host: subject.match(/ from (.+)$/)?.[1] ?? null,
                files,
            };
        });
}

// Where a file from the sync repo lives in Zed's config dir, or null when the
// repo path isn't one zedx syncs. Every keymap variant (shared or per
// platform) maps to the one keymap.json Zed reads.
export function localPathForRepoFile(repoPath: string, zedPaths: ZedPaths): string | null {
    const fixed: Record<string, string> = {
        'settings.json': zedPaths.settings,
        'tasks.json': zedPaths.tasks,
        'debug.json': zedPaths.debug,
        'AGENTS.md': zedPaths.agents,
    };
    if (fixed[repoPath]) return fixed[repoPath];
    if (/^keymap(\.(macos|linux|windows))?\.json$/.test(repoPath)) return zedPaths.keymap;

    const dir = repoPath.match(/^(snippets|themes)\/([^/]+\.json)$/);
    if (dir) {
        return path.join(dir[1] === 'snippets' ? zedPaths.snippetsDir : zedPaths.themesDir, dir[2]);
    }
    return null;
}

function formatDate(date: Date): string {
    return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function describeEntry(entry: HistoryEntry): string {
    return `${formatDate(entry.date)}${entry.host ? ` · ${entry.host}` : ''}`;
}

async function readHistory(repoDir: string, file?: string): Promise<HistoryEntry[]> {
    const args = ['log', `--format=${LOG_FORMAT}`, '--name-status', '--no-renames'];
    const output = await simpleGit(repoDir).raw(file ? [...args, '--', file] : args);
    return parseHistory(output);
}

// Clone the sync repo into a temp dir for the length of `fn`. Exits with a
// message when nothing has been synced yet.
async function withSyncRepo<T>(fn: (repoDir: string) => Promise<T>): Promise<T> {
    const config = await requireSyncConfig();
    return withTempDir(async tmp => {
        const spinner = p.spinner();
        spinner.start(`Fetching ${config.syncRepo}...`);
        let remoteExists: boolean;
        try {
            remoteExists = await cloneRemote(config, tmp);
        } catch (err) {
            spinner.stop(color.red('Could not fetch the remote.'));
            throw err;
        }
        if (!remoteExists) {
            spinner.stop(color.yellow('Remote branch does not exist yet.'));
            p.outro(`Nothing has been synced yet. Run ${color.cyan('zedx sync')} first.`);
            process.exit(0);
        }
        spinner.stop('Remote fetched.');
        return fn(tmp);
    });
}

// zedx sync history [file]
export async function syncHistory(file?: string, limit = 20): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx sync history '))} ${color.blue(file ? `Changes to ${file}…` : 'Recent syncs…')}`,
    );

    const zedPaths = resolveZedPaths();

    await withSyncRepo(async repoDir => {
        const entries = (await readHistory(repoDir, file))
            .map(entry => ({
                ...entry,
                files: entry.files.filter(f => localPathForRepoFile(f.path, zedPaths) !== null),
            }))
            .filter(entry => entry.files.length > 0);

        if (entries.length === 0) {
            p.outro(file ? `No synced changes to ${color.cyan(file)}.` : 'No syncs yet.');
            return;
        }

        const statusMark: Record<string, string> = {
            A: color.green('+'),
            D: color.red('-'),
        };

        for (const entry of entries.slice(0, limit)) {
            const files = entry.files
                .map(f => `${statusMark[f.status] ?? color.yellow('~')}${f.path}`)
                .join(', ');
            p.log.message(
                `${color.bold(describeEntry(entry))} ${color.dim(entry.hash.slice(0, 7))}\n${files}`,
            );
        }

        const more =
            entries.length > limit ? `${entries.length - limit} older syncs not shown. ` : '';
        p.outro(
            `${color.dim(more)}${color.dim('Restore an older version with')} ${color.cyan('zedx sync restore')}`,
        );
    });
}

// zedx sync restore [file]
export async function syncRestore(file?: string): Promise<void> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx sync restore '))} ${color.blue('Bring back an earlier version…')}`,
    );

    const config = await requireSyncConfig();
    const zedPaths = resolveZedPaths();

    await withSyncRepo(async repoDir => {
        const history = await readHistory(repoDir);
        const repoFiles = [...new Set(history.flatMap(entry => entry.files.map(f => f.path)))]
            .filter(f => localPathForRepoFile(f, zedPaths) !== null)
            .sort();

        let repoFile = file;
        if (repoFile && !repoFiles.includes(repoFile)) {
            p.log.error(
                color.red(`${repoFile} has no synced history. Files with history: `) +
                    color.cyan(repoFiles.join(', ') || 'none'),
            );
            process.exit(1);
        }
        if (!repoFile) {
            const picked = await p.autocomplete<string>({
                message: 'Which file do you want to restore?',
                placeholder: 'Type to search…',
                options: repoFiles.map(f => ({ value: f, label: f })),
                maxItems: 12,
            });
            if (p.isCancel(picked)) {
                p.cancel('Cancelled.');
                process.exit(0);
            }
            repoFile = picked;
        }

        const localPath = localPathForRepoFile(repoFile, zedPaths) as string;
        const backupPath = path.join(ZEDX_BACKUP_DIR, repoFile);
        const hasBackup = await fs.pathExists(backupPath);

        // Versions where the file existed after the commit, newest first.
        const versions = history.filter(entry =>
            entry.files.some(f => f.path === repoFile && f.status !== 'D'),
        );

        const BACKUP = 'backup';
        const version = await p.select<string>({
            message: `Which version of ${repoFile}?`,
            options: [
                ...(hasBackup
                    ? [
                          {
                              value: BACKUP,
                              label: 'Local backup',
                              hint: `what this machine had before a sync last replaced it (${formatDate((await fs.stat(backupPath)).mtime)})`,
                          },
                      ]
                    : []),
                ...versions.map(entry => ({
                    value: entry.hash,
                    label: describeEntry(entry),
                    hint: entry.hash.slice(0, 7),
                })),
            ],
            maxItems: 12,
        });
        if (p.isCancel(version)) {
            p.cancel('Cancelled.');
            process.exit(0);
        }

        const restored =
            version === BACKUP
                ? await fs.readFile(backupPath, 'utf-8')
                : await simpleGit(repoDir).show([`${version}:${repoFile}`]);
        const current = (await fs.pathExists(localPath))
            ? await fs.readFile(localPath, 'utf-8')
            : null;

        // Keys kept per-machine stay as they are on this machine.
        const content =
            repoFile === 'settings.json'
                ? ignoredKeysTransform(config.ignoredSettings ?? []).toLocal(restored, current)
                : restored;

        if (content === current) {
            p.outro(`${color.green('✓')} ${repoFile} already matches that version.`);
            return;
        }

        if (current !== null) {
            printDiff(current, content, { local: 'now', remote: 'restore' });
        }

        const confirmed = await p.confirm({
            message: `Replace ${color.dim(localPath)} with this version?`,
            initialValue: false,
        });
        if (p.isCancel(confirmed) || !confirmed) {
            p.cancel('Cancelled. Nothing was changed.');
            process.exit(0);
        }

        if (current !== null) {
            await fs.copy(localPath, backupPath, { overwrite: true });
            p.log.info(`Backed up the current version to ${color.dim(backupPath)}`);
        }
        await fs.outputFile(localPath, content, 'utf-8');

        p.outro(
            `${color.green('✓')} Restored ${color.cyan(repoFile)}.\n\n` +
                `  ${color.dim('Run')} ${color.cyan('zedx sync')} ${color.dim('to send it to your other machines.')}`,
        );
    });
}

import os from 'os';
import path from 'path';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    buildSnippetFileEntries,
    decideFileSync,
    detectIndent,
    reconcileAutoInstallExtensions,
    resolveConflictStrategy,
} from './sync.js';

describe('detectIndent', () => {
    it('detects 4-space indent', () => {
        const src = '{\n    "a": 1\n}\n';
        expect(detectIndent(src)).toEqual({ insertSpaces: true, tabSize: 4 });
    });

    it('detects 2-space indent', () => {
        const src = '{\n  "a": 1\n}\n';
        expect(detectIndent(src)).toEqual({ insertSpaces: true, tabSize: 2 });
    });

    it('detects tab indent', () => {
        const src = '{\n\t"a": 1\n}\n';
        expect(detectIndent(src)).toEqual({ insertSpaces: false, tabSize: 1 });
    });

    it('falls back to 2 spaces when no indent is found', () => {
        expect(detectIndent('{}')).toEqual({ insertSpaces: true, tabSize: 2 });
    });
});

describe('reconcileAutoInstallExtensions', () => {
    let tmp: string;
    let settingsPath: string;
    let indexPath: string;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zedx-test-'));
        settingsPath = path.join(tmp, 'settings.json');
        indexPath = path.join(tmp, 'extensions', 'index.json');
        await fs.ensureDir(path.dirname(indexPath));
    });

    afterEach(async () => {
        await fs.remove(tmp);
    });

    async function writeIndex(ids: Record<string, { dev?: boolean }>): Promise<void> {
        await fs.writeJson(indexPath, { extensions: ids });
    }

    it('adds newly installed extensions as true', async () => {
        await fs.writeFile(settingsPath, '{\n    "auto_install_extensions": {}\n}\n', 'utf-8');
        await writeIndex({ rust: {}, python: {} });

        await reconcileAutoInstallExtensions(settingsPath, indexPath, true);

        const result = await fs.readJson(settingsPath);
        expect(result.auto_install_extensions).toEqual({ rust: true, python: true });
    });

    it('removes uninstalled extensions that were set to true', async () => {
        await fs.writeFile(
            settingsPath,
            '{\n    "auto_install_extensions": {\n        "rust": true,\n        "python": true\n    }\n}\n',
            'utf-8',
        );
        await writeIndex({ rust: {} });

        await reconcileAutoInstallExtensions(settingsPath, indexPath, true);

        const result = await fs.readJson(settingsPath);
        expect(result.auto_install_extensions).toEqual({ rust: true });
    });

    it('preserves entries explicitly set to false', async () => {
        await fs.writeFile(
            settingsPath,
            '{\n    "auto_install_extensions": {\n        "rust": true,\n        "java": false\n    }\n}\n',
            'utf-8',
        );
        await writeIndex({ rust: {}, python: {} });

        await reconcileAutoInstallExtensions(settingsPath, indexPath, true);

        const result = await fs.readJson(settingsPath);
        expect(result.auto_install_extensions).toEqual({
            java: false,
            rust: true,
            python: true,
        });
    });

    it('ignores extensions flagged as dev', async () => {
        await fs.writeFile(settingsPath, '{}\n', 'utf-8');
        await writeIndex({ rust: {}, 'my-dev-ext': { dev: true } });

        await reconcileAutoInstallExtensions(settingsPath, indexPath, true);

        const result = await fs.readJson(settingsPath);
        expect(result.auto_install_extensions).toEqual({ rust: true });
    });

    it('preserves comments and formatting in settings.json', async () => {
        const original = [
            '{',
            '    // user-tuned settings',
            '    "theme": "One Dark", /* keep this */',
            '    "auto_install_extensions": {',
            '        "rust": true',
            '    }',
            '}',
            '',
        ].join('\n');
        await fs.writeFile(settingsPath, original, 'utf-8');
        await writeIndex({ rust: {}, python: {} });

        await reconcileAutoInstallExtensions(settingsPath, indexPath, true);

        const next = await fs.readFile(settingsPath, 'utf-8');
        expect(next).toContain('// user-tuned settings');
        expect(next).toContain('/* keep this */');
        expect(next).toContain('"theme": "One Dark"');
        expect(next).toContain('"python": true');
    });

    it('matches existing indentation when rewriting', async () => {
        const original = '{\n  "auto_install_extensions": {\n    "rust": true\n  }\n}\n';
        await fs.writeFile(settingsPath, original, 'utf-8');
        await writeIndex({ rust: {}, python: {} });

        await reconcileAutoInstallExtensions(settingsPath, indexPath, true);

        const next = await fs.readFile(settingsPath, 'utf-8');
        expect(next).toContain('\n    "rust": true');
        expect(next).not.toContain('\n        "rust": true');
    });

    it('is a no-op when nothing changed', async () => {
        const original = '{\n    "auto_install_extensions": {\n        "rust": true\n    }\n}\n';
        await fs.writeFile(settingsPath, original, 'utf-8');
        await writeIndex({ rust: {} });
        const before = (await fs.stat(settingsPath)).mtimeMs;

        await new Promise(resolve => setTimeout(resolve, 10));
        await reconcileAutoInstallExtensions(settingsPath, indexPath, true);

        const after = (await fs.stat(settingsPath)).mtimeMs;
        expect(after).toBe(before);
    });

    it('skips reconciliation when settings.json has parse errors', async () => {
        const original = '{ this is not valid json';
        await fs.writeFile(settingsPath, original, 'utf-8');
        await writeIndex({ rust: {} });

        await reconcileAutoInstallExtensions(settingsPath, indexPath, true);

        const next = await fs.readFile(settingsPath, 'utf-8');
        expect(next).toBe(original);
    });

    it('does nothing when the extensions index does not exist', async () => {
        const original = '{\n    "theme": "One Dark"\n}\n';
        await fs.writeFile(settingsPath, original, 'utf-8');

        await reconcileAutoInstallExtensions(
            settingsPath,
            path.join(tmp, 'missing', 'index.json'),
            true,
        );

        const next = await fs.readFile(settingsPath, 'utf-8');
        expect(next).toBe(original);
    });

    it('does nothing when settings.json does not exist', async () => {
        await writeIndex({ rust: {} });
        const missing = path.join(tmp, 'missing-settings.json');

        await reconcileAutoInstallExtensions(missing, indexPath, true);

        expect(await fs.pathExists(missing)).toBe(false);
    });
});

describe('decideFileSync', () => {
    const lastSync = new Date('2024-01-01T00:00:00Z');
    const before = new Date('2023-12-31T00:00:00Z');
    const after = new Date('2024-01-02T00:00:00Z');

    // A default set of params representing "both exist, content differs,
    // nothing changed since lastSync" — individual tests override just the
    // fields they care about.
    const base = {
        localExists: true,
        remoteFileExists: true,
        contentsEqual: false,
        localMtime: before,
        remoteMtime: before,
        lastSync,
    };

    it('reports both-missing when neither side has the file', () => {
        expect(decideFileSync({ ...base, localExists: false, remoteFileExists: false })).toBe(
            'both-missing',
        );
    });

    it('reports push-new when only local exists', () => {
        expect(decideFileSync({ ...base, remoteFileExists: false })).toBe('push-new');
    });

    it('reports push-new even if content/mtime fields are irrelevant', () => {
        expect(
            decideFileSync({
                ...base,
                remoteFileExists: false,
                contentsEqual: true,
                localMtime: after,
            }),
        ).toBe('push-new');
    });

    it('reports pull-new when only remote exists', () => {
        expect(decideFileSync({ ...base, localExists: false })).toBe('pull-new');
    });

    it('reports in-sync when contents are equal, regardless of mtimes', () => {
        expect(
            decideFileSync({
                ...base,
                contentsEqual: true,
                localMtime: after,
                remoteMtime: before,
            }),
        ).toBe('in-sync');
    });

    it('reports push-local-newer when only local changed since lastSync', () => {
        expect(decideFileSync({ ...base, localMtime: after, remoteMtime: before })).toBe(
            'push-local-newer',
        );
    });

    it('reports pull-remote-newer when only remote changed since lastSync', () => {
        expect(decideFileSync({ ...base, localMtime: before, remoteMtime: after })).toBe(
            'pull-remote-newer',
        );
    });

    it('reports conflict when both changed since lastSync', () => {
        expect(decideFileSync({ ...base, localMtime: after, remoteMtime: after })).toBe('conflict');
    });

    it('reports conflict when neither mtime moved but content still differs', () => {
        // Clock-skew / manual-edit-without-mtime-bump edge case — falls back
        // to conflict rather than silently picking a side.
        expect(decideFileSync({ ...base, localMtime: before, remoteMtime: before })).toBe(
            'conflict',
        );
    });

    it('treats a mtime exactly equal to lastSync as unchanged', () => {
        expect(decideFileSync({ ...base, localMtime: lastSync, remoteMtime: before })).toBe(
            'conflict',
        );
    });

    it('treats both sides as changed when there is no lastSync yet', () => {
        expect(
            decideFileSync({ ...base, lastSync: null, localMtime: before, remoteMtime: before }),
        ).toBe('conflict');
    });
});

describe('resolveConflictStrategy', () => {
    it('honors an explicit local strategy even when silent', () => {
        expect(resolveConflictStrategy('local', true)).toBe('local');
        expect(resolveConflictStrategy('local', false)).toBe('local');
    });

    it('honors an explicit remote strategy even when silent', () => {
        expect(resolveConflictStrategy('remote', true)).toBe('remote');
        expect(resolveConflictStrategy('remote', false)).toBe('remote');
    });

    it('falls back to local when asking is not possible (silent/daemon mode)', () => {
        expect(resolveConflictStrategy('ask', true)).toBe('local');
    });

    it('defers to an interactive prompt when not silent and strategy is ask', () => {
        expect(resolveConflictStrategy('ask', false)).toBe('ask');
    });
});

describe('buildSnippetFileEntries', () => {
    let tmp: string;
    let localDir: string;
    let remoteDir: string;

    beforeEach(async () => {
        tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'zedx-snippets-test-'));
        localDir = path.join(tmp, 'local-snippets');
        remoteDir = path.join(tmp, 'remote-snippets');
    });

    afterEach(async () => {
        await fs.remove(tmp);
    });

    it('returns an empty list when neither directory exists', async () => {
        expect(await buildSnippetFileEntries(localDir, remoteDir)).toEqual([]);
    });

    it('includes files present only locally', async () => {
        await fs.ensureDir(localDir);
        await fs.writeFile(path.join(localDir, 'python.json'), '{}');

        const entries = await buildSnippetFileEntries(localDir, remoteDir);

        expect(entries).toEqual([
            {
                key: 'snippet:python.json',
                repoPath: path.join(remoteDir, 'python.json'),
                localPath: path.join(localDir, 'python.json'),
                label: 'Snippet: python.json',
            },
        ]);
    });

    it('includes files present only remotely', async () => {
        await fs.ensureDir(remoteDir);
        await fs.writeFile(path.join(remoteDir, 'rust.json'), '{}');

        const entries = await buildSnippetFileEntries(localDir, remoteDir);

        expect(entries).toEqual([
            {
                key: 'snippet:rust.json',
                repoPath: path.join(remoteDir, 'rust.json'),
                localPath: path.join(localDir, 'rust.json'),
                label: 'Snippet: rust.json',
            },
        ]);
    });

    it('deduplicates files present on both sides and sorts by filename', async () => {
        await fs.ensureDir(localDir);
        await fs.ensureDir(remoteDir);
        await fs.writeFile(path.join(localDir, 'python.json'), '{}');
        await fs.writeFile(path.join(remoteDir, 'python.json'), '{}');
        await fs.writeFile(path.join(localDir, 'javascript.json'), '{}');

        const entries = await buildSnippetFileEntries(localDir, remoteDir);

        expect(entries.map(e => e.key)).toEqual(['snippet:javascript.json', 'snippet:python.json']);
    });

    it('ignores non-json files and subdirectories', async () => {
        await fs.ensureDir(localDir);
        await fs.writeFile(path.join(localDir, 'python.json'), '{}');
        await fs.writeFile(path.join(localDir, 'README.md'), 'notes');
        await fs.ensureDir(path.join(localDir, 'nested'));

        const entries = await buildSnippetFileEntries(localDir, remoteDir);

        expect(entries.map(e => e.key)).toEqual(['snippet:python.json']);
    });
});

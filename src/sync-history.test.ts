import path from 'path';

import { describe, expect, it } from 'vitest';

import { localPathForRepoFile, parseHistory } from './sync-history.js';
import type { ZedPaths } from './types/index.js';

const zedPaths: ZedPaths = {
    settings: '/zed/settings.json',
    keymap: '/zed/keymap.json',
    tasks: '/zed/tasks.json',
    debug: '/zed/debug.json',
    agents: '/zed/AGENTS.md',
    snippetsDir: '/zed/snippets',
    themesDir: '/zed/themes',
    extensionsIndex: '/data/extensions/index.json',
};

describe('parseHistory', () => {
    const log = [
        '\x1eaaa111\x1f2026-10-13T11:00:00-07:00\x1fsync: 2026-10-13T18:00:00.000Z from taha-mbp',
        '',
        'M\tsettings.json',
        'A\tsnippets/rust.json',
        '\x1ebbb222\x1f2026-10-12T09:00:00-07:00\x1fsync: 2026-10-12T16:00:00.000Z',
        '',
        'D\tthemes/old.json',
        '',
    ].join('\n');

    it('reads each commit with its date, machine, and changed files', () => {
        const [first, second] = parseHistory(log);
        expect(first.hash).toBe('aaa111');
        expect(first.date.toISOString()).toBe('2026-10-13T18:00:00.000Z');
        expect(first.host).toBe('taha-mbp');
        expect(first.files).toEqual([
            { status: 'M', path: 'settings.json' },
            { status: 'A', path: 'snippets/rust.json' },
        ]);
        expect(second.files).toEqual([{ status: 'D', path: 'themes/old.json' }]);
    });

    it('leaves the machine empty for commits made before it was recorded', () => {
        expect(parseHistory(log)[1].host).toBeNull();
    });

    it('returns nothing for empty output', () => {
        expect(parseHistory('')).toEqual([]);
    });
});

describe('localPathForRepoFile', () => {
    it('maps the fixed files', () => {
        expect(localPathForRepoFile('settings.json', zedPaths)).toBe('/zed/settings.json');
        expect(localPathForRepoFile('AGENTS.md', zedPaths)).toBe('/zed/AGENTS.md');
    });

    it('maps the shared and every per-platform keymap to keymap.json', () => {
        for (const name of ['keymap.json', 'keymap.macos.json', 'keymap.windows.json']) {
            expect(localPathForRepoFile(name, zedPaths)).toBe('/zed/keymap.json');
        }
    });

    it('maps snippets and themes into their folders', () => {
        expect(localPathForRepoFile('snippets/rust.json', zedPaths)).toBe(
            path.join('/zed/snippets', 'rust.json'),
        );
        expect(localPathForRepoFile('themes/mine.json', zedPaths)).toBe(
            path.join('/zed/themes', 'mine.json'),
        );
    });

    it('ignores files zedx does not sync', () => {
        expect(localPathForRepoFile('README.md', zedPaths)).toBeNull();
        expect(localPathForRepoFile('keymap.freebsd.json', zedPaths)).toBeNull();
        expect(localPathForRepoFile('snippets/nested/x.json', zedPaths)).toBeNull();
    });
});

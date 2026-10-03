import { describe, expect, it } from 'vitest';

import {
    applyMergeEdits,
    deepEqual,
    diffLines,
    equalIgnoring,
    IDENTITY_TRANSFORM,
    ignoredKeysTransform,
    mergeJson,
    parseJsonc,
    parseKeyPath,
} from './sync-merge.js';

describe('parseJsonc', () => {
    it('parses JSON with comments and trailing commas', () => {
        expect(parseJsonc('{\n  // font\n  "ui_font_size": 16,\n}')).toEqual({ ui_font_size: 16 });
    });

    it('returns undefined for a syntax error or an empty file', () => {
        expect(parseJsonc('{ "a": ')).toBeUndefined();
        expect(parseJsonc('')).toBeUndefined();
    });
});

describe('deepEqual', () => {
    it('compares nested objects regardless of key order', () => {
        expect(deepEqual({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toBe(true);
    });

    it('treats arrays as ordered', () => {
        expect(deepEqual([1, 2], [2, 1])).toBe(false);
    });

    it('distinguishes a missing key from an explicit null', () => {
        expect(deepEqual({ a: null }, {})).toBe(false);
    });
});

describe('parseKeyPath', () => {
    it('splits dotted paths and trims whitespace', () => {
        expect(parseKeyPath(' terminal . font_size ')).toEqual(['terminal', 'font_size']);
    });
});

describe('equalIgnoring', () => {
    it('disregards the ignored keys on both sides', () => {
        const a = { theme: 'One', ui_font_size: 16, terminal: { font_size: 12, shell: 'zsh' } };
        const b = { theme: 'One', ui_font_size: 20, terminal: { font_size: 15, shell: 'zsh' } };

        expect(equalIgnoring(a, b, ['ui_font_size', 'terminal.font_size'])).toBe(true);
        expect(equalIgnoring(a, b, ['ui_font_size'])).toBe(false);
    });
});

describe('ignoredKeysTransform', () => {
    it('is the identity transform when nothing is ignored', () => {
        expect(ignoredKeysTransform([])).toBe(IDENTITY_TRANSFORM);
        expect(IDENTITY_TRANSFORM.equal('a', 'a')).toBe(true);
        expect(IDENTITY_TRANSFORM.equal('a', 'b')).toBe(false);
    });

    const transform = ignoredKeysTransform(['ui_font_size', 'terminal.font_size']);
    const local = '{\n  // my theme\n  "theme": "One Dark",\n  "ui_font_size": 20\n}\n';

    it('keeps an ignored key out of a first push', () => {
        const pushed = transform.toRemote(local, null);

        expect(parseJsonc(pushed)).toEqual({ theme: 'One Dark' });
        expect(pushed).toContain('// my theme');
    });

    it("leaves the remote's own value for an ignored key in place when pushing", () => {
        const remote = '{\n  "theme": "Old",\n  "ui_font_size": 14\n}\n';

        expect(parseJsonc(transform.toRemote(local, remote))).toEqual({
            theme: 'One Dark',
            ui_font_size: 14,
        });
    });

    it('keeps the local value for an ignored key when pulling', () => {
        const remote = '{\n  "theme": "Gruvbox",\n  "ui_font_size": 14\n}\n';

        expect(parseJsonc(transform.toLocal(remote, local))).toEqual({
            theme: 'Gruvbox',
            ui_font_size: 20,
        });
    });

    it('does not pull an ignored key the local side never set', () => {
        const remote =
            '{\n  "theme": "Gruvbox",\n  "terminal": { "font_size": 15, "shell": "zsh" }\n}\n';

        expect(parseJsonc(transform.toLocal(remote, '{\n  "theme": "One Dark"\n}\n'))).toEqual({
            theme: 'Gruvbox',
            terminal: { shell: 'zsh' },
        });
    });

    it('compares the two sides without the ignored keys', () => {
        expect(transform.equal(local, '{ "theme": "One Dark", "ui_font_size": 14 }')).toBe(true);
        expect(transform.equal(local, '{ "theme": "Gruvbox" }')).toBe(false);
    });

    it('leaves a file it cannot parse untouched', () => {
        expect(transform.toRemote('{ "theme": ', null)).toBe('{ "theme": ');
        expect(transform.equal('{ "theme": ', '{}')).toBe(false);
    });
});

describe('mergeJson', () => {
    const base = { theme: 'One', tab_size: 4, terminal: { shell: 'zsh', font_size: 12 } };

    it('takes a change made only on the remote', () => {
        const { edits, conflicts } = mergeJson(base, base, { ...base, theme: 'Gruvbox' });

        expect(edits).toEqual([{ keyPath: ['theme'], value: 'Gruvbox' }]);
        expect(conflicts).toEqual([]);
    });

    it('keeps a change made only locally', () => {
        expect(mergeJson(base, { ...base, tab_size: 2 }, base)).toEqual({
            edits: [],
            conflicts: [],
        });
    });

    it('combines changes to different keys from both sides', () => {
        const local = { ...base, tab_size: 2 };
        const remote = { ...base, terminal: { shell: 'fish', font_size: 12 } };

        expect(mergeJson(base, local, remote)).toEqual({
            edits: [{ keyPath: ['terminal', 'shell'], value: 'fish' }],
            conflicts: [],
        });
    });

    it('reports a conflict when both sides changed the same key differently', () => {
        const { edits, conflicts } = mergeJson(
            base,
            { ...base, theme: 'Nord' },
            { ...base, theme: 'Gruvbox' },
        );

        expect(edits).toEqual([]);
        expect(conflicts).toEqual([{ keyPath: ['theme'], local: 'Nord', remote: 'Gruvbox' }]);
    });

    it('does not report a conflict when both sides made the same change', () => {
        const changed = { ...base, theme: 'Nord' };

        expect(mergeJson(base, changed, changed)).toEqual({ edits: [], conflicts: [] });
    });

    it('carries over a key the remote deleted', () => {
        const { tab_size: _removed, ...remote } = base;

        expect(mergeJson(base, base, remote).edits).toEqual([
            { keyPath: ['tab_size'], value: undefined },
        ]);
    });

    it('reports a conflict when one side deleted a key the other changed', () => {
        const { tab_size: _removed, ...remote } = base;

        expect(mergeJson(base, { ...base, tab_size: 8 }, remote).conflicts).toEqual([
            { keyPath: ['tab_size'], local: 8, remote: undefined },
        ]);
    });

    it('treats arrays as single values', () => {
        const { conflicts } = mergeJson({ fonts: ['a'] }, { fonts: ['a', 'b'] }, { fonts: ['c'] });

        expect(conflicts).toEqual([{ keyPath: ['fonts'], local: ['a', 'b'], remote: ['c'] }]);
    });

    it('without a base, keeps one-sided keys and flags every differing key', () => {
        const { edits, conflicts } = mergeJson(
            undefined,
            { theme: 'Nord', vim_mode: true },
            { theme: 'Gruvbox', tab_size: 2 },
        );

        expect(edits).toEqual([{ keyPath: ['tab_size'], value: 2 }]);
        expect(conflicts).toEqual([{ keyPath: ['theme'], local: 'Nord', remote: 'Gruvbox' }]);
    });

    it('leaves ignored keys out of the merge entirely', () => {
        const result = mergeJson(
            base,
            { ...base, theme: 'Nord' },
            { ...base, theme: 'Gruvbox', tab_size: 2 },
            ['theme'],
        );

        expect(result).toEqual({ edits: [{ keyPath: ['tab_size'], value: 2 }], conflicts: [] });
    });
});

describe('applyMergeEdits', () => {
    const src = '{\n    // editor\n    "theme": "One",\n    "tab_size": 4\n}\n';

    it('changes, adds and removes keys while keeping comments and indentation', () => {
        const out = applyMergeEdits(src, [
            { keyPath: ['theme'], value: 'Gruvbox' },
            { keyPath: ['terminal', 'shell'], value: 'fish' },
            { keyPath: ['tab_size'], value: undefined },
        ]);

        expect(parseJsonc(out)).toEqual({ theme: 'Gruvbox', terminal: { shell: 'fish' } });
        expect(out).toContain('// editor');
        expect(out).toContain('    "theme": "Gruvbox"');
    });

    it('ignores the removal of a key that is not there', () => {
        expect(applyMergeEdits(src, [{ keyPath: ['missing', 'key'], value: undefined }])).toBe(src);
    });
});

describe('diffLines', () => {
    it('marks lines that exist on one side only', () => {
        expect(diffLines('a\nb\nc', 'a\nx\nc')).toEqual([
            { type: 'same', text: 'a' },
            { type: 'local', text: 'b' },
            { type: 'remote', text: 'x' },
            { type: 'same', text: 'c' },
        ]);
    });

    it('handles additions at the end', () => {
        expect(diffLines('a', 'a\nb')).toEqual([
            { type: 'same', text: 'a' },
            { type: 'remote', text: 'b' },
        ]);
    });

    it('reports no changes for identical input', () => {
        expect(diffLines('a\nb', 'a\nb')?.every(line => line.type === 'same')).toBe(true);
    });
});

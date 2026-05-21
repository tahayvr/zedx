import os from 'os';
import path from 'path';

import fs from 'fs-extra';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { detectIndent, reconcileAutoInstallExtensions } from './sync.js';

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

import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveZedPaths } from './zed-paths.js';

const HOME = path.join('home', 'testuser');

function setPlatform(platform: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('resolveZedPaths', () => {
    const originalPlatform = process.platform;
    const originalEnv = { ...process.env };

    beforeEach(() => {
        vi.spyOn(os, 'homedir').mockReturnValue(HOME);
        delete process.env.XDG_DATA_HOME;
        delete process.env.FLATPAK_XDG_DATA_HOME;
        delete process.env.APPDATA;
        delete process.env.LOCALAPPDATA;
    });

    afterEach(() => {
        setPlatform(originalPlatform);
        process.env = { ...originalEnv };
        vi.restoreAllMocks();
    });

    it('resolves macOS paths under ~/.config/zed, with the extensions index under Application Support', () => {
        setPlatform('darwin');
        const paths = resolveZedPaths();

        const configDir = path.join(HOME, '.config', 'zed');
        expect(paths.settings).toBe(path.join(configDir, 'settings.json'));
        expect(paths.keymap).toBe(path.join(configDir, 'keymap.json'));
        expect(paths.tasks).toBe(path.join(configDir, 'tasks.json'));
        expect(paths.snippetsDir).toBe(path.join(configDir, 'snippets'));
        expect(paths.extensionsIndex).toBe(
            path.join(HOME, 'Library', 'Application Support', 'Zed', 'extensions', 'index.json'),
        );
    });

    it('resolves Linux paths under ~/.config/zed, with the extensions index under ~/.local/share by default', () => {
        setPlatform('linux');
        const paths = resolveZedPaths();

        const configDir = path.join(HOME, '.config', 'zed');
        expect(paths.settings).toBe(path.join(configDir, 'settings.json'));
        expect(paths.keymap).toBe(path.join(configDir, 'keymap.json'));
        expect(paths.tasks).toBe(path.join(configDir, 'tasks.json'));
        expect(paths.snippetsDir).toBe(path.join(configDir, 'snippets'));
        expect(paths.extensionsIndex).toBe(
            path.join(HOME, '.local', 'share', 'zed', 'extensions', 'index.json'),
        );
    });

    it('honors XDG_DATA_HOME for the Linux extensions index, without affecting the config dir', () => {
        setPlatform('linux');
        process.env.XDG_DATA_HOME = '/custom/data';
        const paths = resolveZedPaths();

        expect(paths.settings).toBe(path.join(HOME, '.config', 'zed', 'settings.json'));
        expect(paths.snippetsDir).toBe(path.join(HOME, '.config', 'zed', 'snippets'));
        expect(paths.extensionsIndex).toBe(
            path.join('/custom/data', 'zed', 'extensions', 'index.json'),
        );
    });

    it('prefers FLATPAK_XDG_DATA_HOME over XDG_DATA_HOME on Linux', () => {
        setPlatform('linux');
        process.env.XDG_DATA_HOME = '/custom/data';
        process.env.FLATPAK_XDG_DATA_HOME = '/flatpak/data';
        const paths = resolveZedPaths();

        expect(paths.extensionsIndex).toBe(
            path.join('/flatpak/data', 'zed', 'extensions', 'index.json'),
        );
    });

    it('resolves Windows paths under %APPDATA%/Zed, with the extensions index under %LOCALAPPDATA%', () => {
        setPlatform('win32');
        process.env.APPDATA = path.join(HOME, 'AppData', 'Roaming');
        process.env.LOCALAPPDATA = path.join(HOME, 'AppData', 'Local');
        const paths = resolveZedPaths();

        const configDir = path.join(HOME, 'AppData', 'Roaming', 'Zed');
        expect(paths.settings).toBe(path.join(configDir, 'settings.json'));
        expect(paths.keymap).toBe(path.join(configDir, 'keymap.json'));
        expect(paths.tasks).toBe(path.join(configDir, 'tasks.json'));
        expect(paths.snippetsDir).toBe(path.join(configDir, 'snippets'));
        expect(paths.extensionsIndex).toBe(
            path.join(HOME, 'AppData', 'Local', 'Zed', 'extensions', 'index.json'),
        );
    });

    it('falls back to default AppData paths on Windows when APPDATA/LOCALAPPDATA are unset', () => {
        setPlatform('win32');
        const paths = resolveZedPaths();

        expect(paths.settings).toBe(path.join(HOME, 'AppData', 'Roaming', 'Zed', 'settings.json'));
        expect(paths.extensionsIndex).toBe(
            path.join(HOME, 'AppData', 'Local', 'Zed', 'extensions', 'index.json'),
        );
    });

    it('throws on an unsupported platform', () => {
        setPlatform('sunos');
        expect(() => resolveZedPaths()).toThrow('Unsupported platform: sunos');
    });
});

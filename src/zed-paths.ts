import os from 'os'
import path from 'path'
import type { ZedPaths } from './types/index.js'

export function resolveZedPaths(): ZedPaths {
    const home = os.homedir()
    const platform = process.platform

    if (platform === 'darwin') {
        return {
            settings: path.join(home, '.config', 'zed', 'settings.json'),
            extensions: path.join(
                home,
                'Library',
                'Application Support',
                'Zed',
                'extensions',
                'index.json'
            ),
        }
    }

    if (platform === 'linux') {
        const xdgData =
            process.env.FLATPAK_XDG_DATA_HOME ||
            process.env.XDG_DATA_HOME ||
            path.join(home, '.local', 'share')

        return {
            settings: path.join(home, '.config', 'zed', 'settings.json'),
            extensions: path.join(xdgData, 'zed', 'extensions', 'index.json'),
        }
    }

    if (platform === 'win32') {
        const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
        const localAppData =
            process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')

        return {
            settings: path.join(appData, 'Zed', 'settings.json'),
            extensions: path.join(localAppData, 'Zed', 'extensions', 'index.json'),
        }
    }

    throw new Error(`Unsupported platform: ${platform}`)
}

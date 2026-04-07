import { execSync } from 'child_process';
import os from 'os';
import path from 'path';

import * as p from '@clack/prompts';
import fs from 'fs-extra';
import color from 'picocolors';

import { resolveZedPaths } from './zed-paths.js';

const LAUNCHD_LABEL = 'dev.zedx.sync';
const LAUNCHD_PLIST_PATH = path.join(
    os.homedir(),
    'Library',
    'LaunchAgents',
    `${LAUNCHD_LABEL}.plist`,
);

const SYSTEMD_SERVICE_NAME = 'zedx-sync';
const SYSTEMD_UNIT_DIR = path.join(os.homedir(), '.config', 'systemd', 'user');
const SYSTEMD_SERVICE_PATH = path.join(SYSTEMD_UNIT_DIR, `${SYSTEMD_SERVICE_NAME}.service`);
const SYSTEMD_PATH_PATH = path.join(SYSTEMD_UNIT_DIR, `${SYSTEMD_SERVICE_NAME}.path`);

function resolveZedxBinary(): string {
    try {
        const bin = execSync('which zedx', { encoding: 'utf-8' }).trim();
        if (bin) return bin;
    } catch {
        /* fall through */
    }

    return `${process.execPath} ${process.argv[1]}`;
}

function unsupportedPlatform(): never {
    p.log.error(color.red(`zedx sync install is only supported on macOS and Linux.`));
    process.exit(1);
}

function buildPlist(zedxBin: string, watchPaths: string[]): string {
    const watchEntries = watchPaths.map(wp => `        <string>${wp}</string>`).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LAUNCHD_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${zedxBin}</string>
        <string>sync</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>WatchPaths</key>
    <array>
${watchEntries}
    </array>

    <key>ThrottleInterval</key>
    <integer>30</integer>

    <key>StandardOutPath</key>
    <string>${os.homedir()}/Library/Logs/zedx-sync.log</string>

    <key>StandardErrorPath</key>
    <string>${os.homedir()}/Library/Logs/zedx-sync.log</string>
</dict>
</plist>
`;
}

async function installMacos(zedxBin: string, watchPaths: string[]): Promise<void> {
    const plist = buildPlist(zedxBin, watchPaths);

    await fs.ensureDir(path.dirname(LAUNCHD_PLIST_PATH));
    await fs.writeFile(LAUNCHD_PLIST_PATH, plist, 'utf-8');

    try {
        execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`, { stdio: 'pipe' });
    } catch {
        /* not loaded yet */
    }

    execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`);

    p.log.success(`Daemon installed: ${color.dim(LAUNCHD_PLIST_PATH)}`);
    p.log.info(`Logs: ${color.dim(`${os.homedir()}/Library/Logs/zedx-sync.log`)}`);
    p.log.info(`To check status: ${color.cyan(`launchctl list ${LAUNCHD_LABEL}`)}`);
}

async function uninstallMacos(): Promise<void> {
    if (!(await fs.pathExists(LAUNCHD_PLIST_PATH))) {
        p.log.warn(color.yellow('No launchd agent found — nothing to uninstall.'));
        return;
    }

    try {
        execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}"`, { stdio: 'pipe' });
    } catch {
        /* already unloaded */
    }

    await fs.remove(LAUNCHD_PLIST_PATH);
    p.log.success('Daemon uninstalled.');
}

function buildSystemdService(zedxBin: string): string {
    return `[Unit]
Description=zedx Zed config sync
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${zedxBin} sync
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
`;
}

function buildSystemdPath(watchPaths: string[]): string {
    const pathChangedEntries = watchPaths.map(wp => `PathChanged=${wp}`).join('\n');

    return `[Unit]
Description=Watch Zed config files for zedx sync

[Path]
${pathChangedEntries}
Unit=${SYSTEMD_SERVICE_NAME}.service

[Install]
WantedBy=default.target
`;
}

async function installLinux(zedxBin: string, watchPaths: string[]): Promise<void> {
    await fs.ensureDir(SYSTEMD_UNIT_DIR);

    await fs.writeFile(SYSTEMD_SERVICE_PATH, buildSystemdService(zedxBin), 'utf-8');
    await fs.writeFile(SYSTEMD_PATH_PATH, buildSystemdPath(watchPaths), 'utf-8');

    execSync('systemctl --user daemon-reload');
    execSync(`systemctl --user enable --now ${SYSTEMD_SERVICE_NAME}.path`);

    p.log.success(`Service installed: ${color.dim(SYSTEMD_SERVICE_PATH)}`);
    p.log.success(`Path unit installed: ${color.dim(SYSTEMD_PATH_PATH)}`);
    p.log.info(
        `To check status: ${color.cyan(`systemctl --user status ${SYSTEMD_SERVICE_NAME}.path`)}`,
    );
    p.log.info(`Logs: ${color.cyan(`journalctl --user -u ${SYSTEMD_SERVICE_NAME}.service`)}`);
}

async function uninstallLinux(): Promise<void> {
    const serviceExists = await fs.pathExists(SYSTEMD_SERVICE_PATH);
    const pathExists = await fs.pathExists(SYSTEMD_PATH_PATH);

    if (!serviceExists && !pathExists) {
        p.log.warn(color.yellow('No systemd units found — nothing to uninstall.'));
        return;
    }

    try {
        execSync(`systemctl --user disable --now ${SYSTEMD_SERVICE_NAME}.path`, { stdio: 'pipe' });
    } catch {
        /* already inactive */
    }

    if (serviceExists) await fs.remove(SYSTEMD_SERVICE_PATH);
    if (pathExists) await fs.remove(SYSTEMD_PATH_PATH);

    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    p.log.success('Daemon uninstalled.');
}

export async function syncInstall(): Promise<void> {
    console.log('');
    p.intro(color.bold('zedx sync install'));

    const platform = process.platform;
    if (platform !== 'darwin' && platform !== 'linux') unsupportedPlatform();

    const zedPaths = resolveZedPaths();
    const watchPaths = [zedPaths.settings];
    const zedxBin = resolveZedxBinary();

    p.log.info(`Binary:  ${color.dim(zedxBin)}`);
    p.log.info(`Watching:`);
    for (const wp of watchPaths) {
        p.log.info(`  ${color.dim(wp)}`);
    }

    if (platform === 'darwin') {
        await installMacos(zedxBin, watchPaths);
    } else {
        await installLinux(zedxBin, watchPaths);
    }

    p.outro(
        `${color.green('✓')} zedx sync will now run automatically whenever your Zed config changes.\n\n` +
            `  Run ${color.cyan('zedx sync uninstall')} to remove the daemon at any time.`,
    );
}

export async function syncUninstall(): Promise<void> {
    console.log('');
    p.intro(color.bold('zedx sync uninstall'));

    const platform = process.platform;
    if (platform !== 'darwin' && platform !== 'linux') unsupportedPlatform();

    if (platform === 'darwin') {
        await uninstallMacos();
    } else {
        await uninstallLinux();
    }

    p.outro(`${color.green('✓')} Done.`);
}

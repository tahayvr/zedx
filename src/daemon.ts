import { execFileSync, execSync } from 'child_process';
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

const WINDOWS_TASK_NAME = 'ZedxSync';
// Windows Task Scheduler has no lightweight equivalent to launchd's
// WatchPaths / systemd's PathChanged — a real per-file watch trigger requires
// a WMI event subscription, which is too heavyweight to set up from a CLI
// install step. Polling every few minutes is the practical middle ground:
// changes are picked up quickly without a long-running watcher process.
const WINDOWS_POLL_INTERVAL_MINUTES = 5;

function resolveZedxBinary(): string {
    try {
        const lookupCmd = process.platform === 'win32' ? 'where zedx' : 'which zedx';
        const output = execSync(lookupCmd, { encoding: 'utf-8' });
        const bin = output.split(/\r?\n/)[0]?.trim();
        if (bin) return bin;
    } catch {
        /* fall through */
    }

    if (process.platform === 'win32') {
        return `"${process.execPath}" "${process.argv[1]}"`;
    }
    return `${process.execPath} ${process.argv[1]}`;
}

function unsupportedPlatform(): never {
    p.log.error(color.red(`zedx sync install is only supported on macOS, Linux, and Windows.`));
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
    <string>${os.homedir()}/Library/Logs/zedx/sync.log</string>

    <key>StandardErrorPath</key>
    <string>${os.homedir()}/Library/Logs/zedx/sync.log</string>
</dict>
</plist>
`;
}

async function installMacos(zedxBin: string, watchPaths: string[]): Promise<void> {
    const plist = buildPlist(zedxBin, watchPaths);

    await fs.ensureDir(path.dirname(LAUNCHD_PLIST_PATH));
    await fs.ensureDir(path.join(os.homedir(), 'Library', 'Logs', 'zedx'));
    await fs.writeFile(LAUNCHD_PLIST_PATH, plist, 'utf-8');

    try {
        execSync(`launchctl unload "${LAUNCHD_PLIST_PATH}" 2>/dev/null`, { stdio: 'pipe' });
    } catch {
        /* not loaded yet */
    }

    execSync(`launchctl load "${LAUNCHD_PLIST_PATH}"`);

    p.log.success(`Daemon installed: ${color.dim(LAUNCHD_PLIST_PATH)}`);
    p.log.info(`Logs: ${color.dim(`${os.homedir()}/Library/Logs/zedx/sync.log`)}`);
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

async function installWindows(zedxBin: string): Promise<void> {
    // /tr is the exact command line Task Scheduler will run — no shell is
    // involved (execFileSync bypasses cmd.exe entirely), so zedxBin's own
    // quoting around paths-with-spaces is all that's needed here.
    execFileSync(
        'schtasks',
        [
            '/create',
            '/tn',
            WINDOWS_TASK_NAME,
            '/tr',
            `${zedxBin} sync`,
            '/sc',
            'minute',
            '/mo',
            String(WINDOWS_POLL_INTERVAL_MINUTES),
            '/f',
        ],
        { stdio: 'pipe' },
    );

    p.log.success(`Scheduled task installed: ${color.dim(WINDOWS_TASK_NAME)}`);
    p.log.info(`To check status: ${color.cyan(`schtasks /query /tn ${WINDOWS_TASK_NAME}`)}`);
    p.log.info(
        `Run history: Task Scheduler (taskschd.msc) → Task Scheduler Library → ${WINDOWS_TASK_NAME} → History tab.`,
    );
}

async function uninstallWindows(): Promise<void> {
    try {
        execFileSync('schtasks', ['/query', '/tn', WINDOWS_TASK_NAME], { stdio: 'pipe' });
    } catch {
        p.log.warn(color.yellow('No scheduled task found — nothing to uninstall.'));
        return;
    }

    execFileSync('schtasks', ['/delete', '/tn', WINDOWS_TASK_NAME, '/f'], { stdio: 'pipe' });
    p.log.success('Daemon uninstalled.');
}

function isSupportedPlatform(platform: NodeJS.Platform): boolean {
    return platform === 'darwin' || platform === 'linux' || platform === 'win32';
}

export async function syncInstall(): Promise<void> {
    console.log('');
    p.intro(color.bold('zedx sync install'));

    const platform = process.platform;
    if (!isSupportedPlatform(platform)) unsupportedPlatform();

    const zedxBin = resolveZedxBinary();
    p.log.info(`Binary:  ${color.dim(zedxBin)}`);

    if (platform === 'win32') {
        p.log.info(
            `Windows has no lightweight per-file watch hook for Task Scheduler, so zedx will ` +
                `poll every ${WINDOWS_POLL_INTERVAL_MINUTES} minutes instead of syncing instantly on save.`,
        );
        await installWindows(zedxBin);
        p.outro(
            `${color.green('✓')} zedx sync will now run automatically every ${WINDOWS_POLL_INTERVAL_MINUTES} minutes.\n\n` +
                `  Run ${color.cyan('zedx sync uninstall')} to remove the task at any time.`,
        );
        return;
    }

    const zedPaths = resolveZedPaths();
    // Snippets are watched as a directory rather than individual files, since
    // the set of snippet filenames isn't fixed. Note this only reliably
    // catches files being added/removed/renamed — editing an existing
    // snippet's contents may not always bump the directory's own mtime,
    // depending on the OS/filesystem. Users can still run `zedx sync`
    // manually to pick up in-place edits immediately.
    const watchPaths = [zedPaths.settings, zedPaths.keymap, zedPaths.tasks, zedPaths.snippetsDir];
    // launchd/systemd path watchers only reliably register on paths that
    // already exist, and a user with no snippets yet won't have this
    // directory created by Zed until they add one.
    await fs.ensureDir(zedPaths.snippetsDir);

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
    if (!isSupportedPlatform(platform)) unsupportedPlatform();

    if (platform === 'darwin') {
        await uninstallMacos();
    } else if (platform === 'linux') {
        await uninstallLinux();
    } else {
        await uninstallWindows();
    }

    p.outro(`${color.green('✓')} Done.`);
}

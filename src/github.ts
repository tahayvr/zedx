import { spawnSync } from 'child_process';

// Run the GitHub CLI. `ok` is false when gh is missing or the command fails,
// and `error` then carries gh's own message.
function gh(args: string[]): { ok: boolean; missing: boolean; stdout: string; error: string } {
    const result = spawnSync('gh', args, { encoding: 'utf-8' });
    if (result.error) {
        return { ok: false, missing: true, stdout: '', error: result.error.message };
    }
    return {
        ok: result.status === 0,
        missing: false,
        stdout: (result.stdout ?? '').trim(),
        error: (result.stderr ?? '').trim(),
    };
}

export type GhStatus = 'ready' | 'logged-out' | 'missing';

// Whether gh is installed and logged in to github.com.
export function ghStatus(): GhStatus {
    const result = gh(['auth', 'status', '--hostname', 'github.com']);
    if (result.missing) return 'missing';
    return result.ok ? 'ready' : 'logged-out';
}

// The clone URL matching the user's gh git_protocol setting (HTTPS unless
// they chose SSH).
export function pickCloneUrl(protocol: string, urls: { url: string; sshUrl: string }): string {
    return protocol === 'ssh' ? urls.sshUrl : `${urls.url}.git`;
}

// Create a private repo on the logged-in account and return its clone URL.
export function createPrivateRepo(name: string): { url: string } | { error: string } {
    const created = gh([
        'repo',
        'create',
        name,
        '--private',
        '--description',
        'Zed config, synced by zedx',
    ]);
    if (!created.ok) return { error: created.error || 'gh repo create failed' };

    const viewed = gh(['repo', 'view', name, '--json', 'url,sshUrl']);
    if (!viewed.ok) return { error: viewed.error || 'gh repo view failed' };

    const protocol = gh(['config', 'get', 'git_protocol', '--host', 'github.com']).stdout;
    return { url: pickCloneUrl(protocol, JSON.parse(viewed.stdout)) };
}

import { applyEdits, modify, parse, type FormattingOptions, type ParseError } from 'jsonc-parser';

export type KeyPath = string[];

type JsonObject = Record<string, unknown>;

// Above this many line pairs the LCS table gets too large to be worth it for
// a terminal preview.
const MAX_DIFF_CELLS = 4_000_000;

// Detect indentation from a JSONC source so edits match the surrounding file.
// Falls back to two-space indent (Zed's default for settings.json).
export function detectIndent(src: string): FormattingOptions {
    const match = src.match(/^([ \t]+)\S/m);
    if (!match) return { insertSpaces: true, tabSize: 2 };
    const ws = match[1];
    if (ws.startsWith('\t')) return { insertSpaces: false, tabSize: 1 };
    return { insertSpaces: true, tabSize: ws.length };
}

export function isPlainObject(value: unknown): value is JsonObject {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Parse JSONC, returning undefined when the source has syntax errors (or is
// empty) so callers can fall back to treating the file as opaque text.
export function parseJsonc(src: string): unknown {
    const errors: ParseError[] = [];
    const value = parse(src, errors, { allowTrailingComma: true, allowEmptyContent: true });
    return errors.length > 0 ? undefined : value;
}

export function deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
    }
    if (isPlainObject(a) && isPlainObject(b)) {
        const aKeys = Object.keys(a);
        return (
            aKeys.length === Object.keys(b).length &&
            aKeys.every(key => key in b && deepEqual(a[key], b[key]))
        );
    }
    return false;
}

// 'terminal.font_size' -> ['terminal', 'font_size']
export function parseKeyPath(key: string): KeyPath {
    return key
        .split('.')
        .map(segment => segment.trim())
        .filter(Boolean);
}

export function getAtPath(root: unknown, keyPath: KeyPath): unknown {
    let node = root;
    for (const segment of keyPath) {
        if (!isPlainObject(node)) return undefined;
        node = node[segment];
    }
    return node;
}

// Copy of a parsed value with the given paths removed.
function withoutPaths(root: unknown, keyPaths: KeyPath[]): unknown {
    if (root === undefined || keyPaths.length === 0) return root;
    const copy = structuredClone(root);
    for (const keyPath of keyPaths) {
        const parent = getAtPath(copy, keyPath.slice(0, -1));
        if (isPlainObject(parent)) delete parent[keyPath[keyPath.length - 1]];
    }
    return copy;
}

function toKeyPaths(keys: string[]): KeyPath[] {
    return keys.map(parseKeyPath).filter(keyPath => keyPath.length > 0);
}

// Deep equality of two parsed values, disregarding the given keys.
export function equalIgnoring(a: unknown, b: unknown, ignoredKeys: string[]): boolean {
    const keyPaths = toKeyPaths(ignoredKeys);
    return deepEqual(withoutPaths(a, keyPaths), withoutPaths(b, keyPaths));
}

// Every key path in a parsed settings object, depth-first and dot-joined
// ('terminal', 'terminal.font_size', …). Arrays count as values. Keys that
// contain a dot are skipped, since a dotted path can't address them.
export function listKeyPaths(settings: unknown, prefix = ''): string[] {
    if (!isPlainObject(settings)) return [];
    return Object.entries(settings).flatMap(([key, value]) => {
        if (key.includes('.')) return [];
        const keyPath = prefix ? `${prefix}.${key}` : key;
        return [keyPath, ...listKeyPaths(value, keyPath)];
    });
}

export interface PathSetting {
    key: string;
    value: string;
}

// `/…`, `~/…`, `C:\…`, or `\\server\…`
const ABSOLUTE_PATH = /^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/;

// Skipped by findAbsolutePaths: ssh_connections holds paths on remote hosts,
// and env values are environment variables (often PATH-style lists), not
// single local paths.
function holdsNonLocalPaths(key: string, name: string): boolean {
    return name === 'env' || (key === '' && name === 'ssh_connections');
}

// String values in a parsed settings object (arrays included) that look like
// absolute local file paths, with the dotted key they sit under.
export function findAbsolutePaths(settings: unknown, key = ''): PathSetting[] {
    if (typeof settings === 'string') {
        return key && ABSOLUTE_PATH.test(settings) ? [{ key, value: settings }] : [];
    }
    if (Array.isArray(settings)) return settings.flatMap(item => findAbsolutePaths(item, key));
    if (!isPlainObject(settings)) return [];
    return Object.entries(settings).flatMap(([name, value]) =>
        holdsNonLocalPaths(key, name)
            ? []
            : findAbsolutePaths(value, key ? `${key}.${name}` : name),
    );
}

// Set (or, with `undefined`, remove) one path in a JSONC source, leaving the
// rest of the text — comments and formatting included — as it was.
function editJsonc(src: string, keyPath: KeyPath, value: unknown): string {
    if (value === undefined && getAtPath(parseJsonc(src), keyPath) === undefined) return src;
    try {
        const edits = modify(src, keyPath, value, { formattingOptions: detectIndent(src) });
        return applyEdits(src, edits);
    } catch {
        // jsonc-parser throws when the path runs through a non-object value.
        return src;
    }
}

// How a tracked file's content maps between the local copy and the repo copy.
export interface FileTransform {
    // What belongs in the repo for this local content, given what the remote holds now.
    toRemote(local: string, remote: string | null): string;
    // What belongs on disk for this remote content, given what is there now.
    toLocal(remote: string, local: string | null): string;
    equal(local: string, remote: string): boolean;
}

export const IDENTITY_TRANSFORM: FileTransform = {
    toRemote: local => local,
    toLocal: remote => remote,
    equal: (local, remote) => local === remote,
};

// Take `source` across to the other side, but leave every ignored key the
// way `target` already has it (or absent, when target doesn't set it).
function carryOver(source: string, target: string | null, keyPaths: KeyPath[]): string {
    const sourceValue = parseJsonc(source);
    if (!isPlainObject(sourceValue)) return source;
    const targetValue = target === null ? undefined : parseJsonc(target);

    let out = source;
    for (const keyPath of keyPaths) {
        out = editJsonc(out, keyPath, getAtPath(targetValue, keyPath));
    }
    return out;
}

// Transform for a JSONC file in which some keys stay per-machine: they are
// neither pushed nor pulled, and don't count when comparing the two sides.
export function ignoredKeysTransform(ignoredKeys: string[]): FileTransform {
    const keyPaths = toKeyPaths(ignoredKeys);
    if (keyPaths.length === 0) return IDENTITY_TRANSFORM;

    return {
        toRemote: (local, remote) => carryOver(local, remote, keyPaths),
        toLocal: (remote, local) => carryOver(remote, local, keyPaths),
        equal: (local, remote) => {
            if (local === remote) return true;
            const localValue = parseJsonc(local);
            const remoteValue = parseJsonc(remote);
            if (localValue === undefined || remoteValue === undefined) return false;
            return equalIgnoring(localValue, remoteValue, ignoredKeys);
        },
    };
}

// A change local needs to take on from remote. `value: undefined` removes the key.
export interface MergeEdit {
    keyPath: KeyPath;
    value: unknown;
}

// A key both sides changed, to different values. `undefined` means deleted.
export interface MergeConflict {
    keyPath: KeyPath;
    local: unknown;
    remote: unknown;
}

export interface MergeResult {
    edits: MergeEdit[];
    conflicts: MergeConflict[];
}

function mergeAt(
    base: unknown,
    local: unknown,
    remote: unknown,
    keyPath: KeyPath,
    out: MergeResult,
): void {
    if (deepEqual(local, remote)) return;

    // Descend first so a change deep inside an object becomes one small edit
    // rather than a replacement of the whole object.
    if (isPlainObject(local) && isPlainObject(remote)) {
        const baseObject = isPlainObject(base) ? base : {};
        const keys = new Set([
            ...Object.keys(baseObject),
            ...Object.keys(local),
            ...Object.keys(remote),
        ]);
        for (const key of keys) {
            mergeAt(baseObject[key], local[key], remote[key], [...keyPath, key], out);
        }
        return;
    }

    if (deepEqual(local, base)) {
        out.edits.push({ keyPath, value: remote });
        return;
    }
    if (deepEqual(remote, base)) return;
    out.conflicts.push({ keyPath, local, remote });
}

// Three-way merge of two JSON objects against their common ancestor (`base`,
// or undefined when there is none — then every differing key is a conflict
// and keys present on one side only are kept). Arrays are treated as single
// values. The result is expressed as what local has to change.
export function mergeJson(
    base: unknown,
    local: unknown,
    remote: unknown,
    ignoredKeys: string[] = [],
): MergeResult {
    const keyPaths = toKeyPaths(ignoredKeys);
    const out: MergeResult = { edits: [], conflicts: [] };
    mergeAt(
        withoutPaths(base, keyPaths),
        withoutPaths(local, keyPaths),
        withoutPaths(remote, keyPaths),
        [],
        out,
    );
    return out;
}

export function applyMergeEdits(src: string, edits: MergeEdit[]): string {
    return edits.reduce((text, edit) => editJsonc(text, edit.keyPath, edit.value), src);
}

export interface DiffLine {
    type: 'same' | 'local' | 'remote';
    text: string;
}

// Line diff between the local and remote version of a file. Returns null when
// the changed region is too large to compare cheaply.
export function diffLines(local: string, remote: string): DiffLine[] | null {
    const a = local.split('\n');
    const b = remote.split('\n');

    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }

    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    if (midA.length * midB.length > MAX_DIFF_CELLS) return null;

    // Longest-common-subsequence table, filled from the end so the walk
    // below can read it front to back.
    const table = Array.from({ length: midA.length + 1 }, () => new Uint32Array(midB.length + 1));
    for (let i = midA.length - 1; i >= 0; i--) {
        for (let j = midB.length - 1; j >= 0; j--) {
            table[i][j] =
                midA[i] === midB[j]
                    ? table[i + 1][j + 1] + 1
                    : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }

    const same = (text: string): DiffLine => ({ type: 'same', text });
    const lines: DiffLine[] = a.slice(0, start).map(same);

    let i = 0;
    let j = 0;
    while (i < midA.length && j < midB.length) {
        if (midA[i] === midB[j]) {
            lines.push(same(midA[i]));
            i++;
            j++;
        } else if (table[i + 1][j] >= table[i][j + 1]) {
            lines.push({ type: 'local', text: midA[i++] });
        } else {
            lines.push({ type: 'remote', text: midB[j++] });
        }
    }
    while (i < midA.length) lines.push({ type: 'local', text: midA[i++] });
    while (j < midB.length) lines.push({ type: 'remote', text: midB[j++] });

    return [...lines, ...a.slice(endA).map(same)];
}

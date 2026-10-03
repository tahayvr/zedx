export type ExtensionType = 'theme' | 'language' | 'icon-theme';

export interface ZedPaths {
    settings: string;
    keymap: string;
    tasks: string;
    debug: string;
    agents: string; // user-global AGENTS.md
    snippetsDir: string; // directory of per-language *.json snippet files
    themesDir: string; // directory of local (non-extension) *.json theme files
    extensionsIndex: string; // local-only: used to bootstrap auto_install_extensions, never synced
}

export type ConflictStrategy = 'local' | 'remote' | 'ask';

export interface SyncConfig {
    syncRepo: string;
    branch: string;
    conflictStrategy?: ConflictStrategy;
    // Persisted default file selection (group keys, see SYNC_FILE_GROUPS).
    // Undefined/absent means "sync everything".
    files?: string[];
    // settings.json keys (dot-separated paths) that stay per-machine: never
    // pushed, and never overwritten by a pull.
    ignoredSettings?: string[];
}

export type License =
    | 'Apache-2.0'
    | 'BSD-2-Clause'
    | 'BSD-3-Clause'
    | 'CC-BY-4.0'
    | 'GPL-3.0'
    | 'LGPL-3.0'
    | 'MIT'
    | 'Unlicense'
    | 'Zlib';

export interface ExtensionOptions {
    name: string;
    id: string;
    description: string;
    author: string;
    repository: string;
    license: License;
    types: ExtensionType[];
    [key: string]: unknown;
}

export interface ThemeOptions extends ExtensionOptions {
    themeName: string;
    appearance: 'light' | 'dark' | 'both';
}

export interface IconThemeOptions extends ExtensionOptions {
    iconThemeName: string;
    // Deliberately distinct from ThemeOptions.appearance: when an extension
    // includes both a theme and an icon theme, they need independent
    // appearance choices rather than one overwriting the other via
    // Object.assign onto the same options object.
    iconThemeAppearance: 'light' | 'dark' | 'both';
}

export interface LanguageOptions extends ExtensionOptions {
    languageName: string;
    languageId: string;
    pathSuffixes?: string[];
    lineComments?: string[];
    grammarRepo?: string;
    grammarRev?: string;
    hasLsp?: boolean;
    lspServerName?: string;
    lspCommand?: string;
    lspArgs?: string[];
}

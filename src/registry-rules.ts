import type { License } from './types/index.js';

// Rules Zed's extension registry (zed-industries/extensions) applies to a
// submission, kept in one place so `create`, `check` and `publish` agree.

const EXTENSION_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/i;

export function validateExtensionId(id: string): string | undefined {
    if (!EXTENSION_ID_PATTERN.test(id)) {
        return 'ID must be kebab-case (lowercase letters, numbers, and hyphens)';
    }
    if (id.split('-').includes('zed')) return 'ID must not include "zed"';
    if (id.includes('extension')) return 'ID must not include "extension"';
}

// The registry only takes plain major.minor.patch versions.
export function isRegistryVersion(version: string): boolean {
    return SEMVER_PATTERN.test(version);
}

// A grammar `rev` should pin a commit; a branch or tag name moves over time.
export function isPinnedRevision(rev: string): boolean {
    return COMMIT_SHA_PATTERN.test(rev);
}

// The registry inspects any root file whose name starts with LICENSE/LICENCE.
export function isLicenseFileName(fileName: string): boolean {
    const name = fileName.toLowerCase();
    return name.startsWith('license') || name.startsWith('licence');
}

// A phrase (or two) that identifies each accepted license. Order matters:
// the LGPL text also names the GPL, and BSD-3 is BSD-2 plus one clause.
const LICENSE_SIGNATURES: Array<[License, RegExp[]]> = [
    ['Apache-2.0', [/Apache License/i, /Version 2\.0, January 2004/i]],
    [
        'LGPL-3.0',
        [
            /GNU LESSER GENERAL PUBLIC LICENSE/i,
            // The GPL text mentions the LGPL by name too; only the LGPL says this.
            /incorporates the terms and conditions of version 3 of the GNU General Public License/i,
        ],
    ],
    ['GPL-3.0', [/GNU GENERAL PUBLIC LICENSE/i, /Version 3, 29 June 2007/i]],
    [
        'BSD-3-Clause',
        [/Redistribution and use in source and binary forms/i, /Neither the name of/i],
    ],
    ['BSD-2-Clause', [/Redistribution and use in source and binary forms/i]],
    ['MIT', [/Permission is hereby granted, free of charge, to any person obtaining a copy/i]],
    ['Unlicense', [/free and unencumbered software released into the public domain/i]],
    ['CC-BY-4.0', [/Creative Commons Attribution 4\.0 International Public License/i]],
    ['Zlib', [/This software is provided .as-is., without any express or implied warranty/i]],
];

export const ACCEPTED_LICENSES: License[] = LICENSE_SIGNATURES.map(([license]) => license).sort();

// Best-effort identification of a license text. Returns undefined when it
// doesn't look like any license the registry accepts.
export function detectLicense(content: string): License | undefined {
    // Collapse whitespace so line wrapping doesn't break a phrase.
    const text = content.replace(/\s+/g, ' ');
    return LICENSE_SIGNATURES.find(([, patterns]) =>
        patterns.every(pattern => pattern.test(text)),
    )?.[0];
}

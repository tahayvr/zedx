import path from 'path';
import { fileURLToPath } from 'url';

import fs from 'fs-extra';
import { describe, expect, it } from 'vitest';

import {
    ACCEPTED_LICENSES,
    detectLicense,
    isLicenseFileName,
    isPinnedRevision,
    isRegistryVersion,
    validateExtensionId,
} from './registry-rules.js';

const LICENSE_TEMPLATE_DIR = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'templates',
    'base',
    'licenses',
);

describe('validateExtensionId', () => {
    it('accepts kebab-case IDs', () => {
        expect(validateExtensionId('midnight-blue-theme')).toBeUndefined();
        expect(validateExtensionId('gleam2')).toBeUndefined();
    });

    it('rejects anything that is not kebab-case', () => {
        expect(validateExtensionId('My Theme')).toMatch(/kebab-case/);
        expect(validateExtensionId('my_theme')).toMatch(/kebab-case/);
        expect(validateExtensionId('-theme')).toMatch(/kebab-case/);
        expect(validateExtensionId('')).toMatch(/kebab-case/);
    });

    it('rejects "zed" as a word but not as part of another word', () => {
        expect(validateExtensionId('zed-gleam')).toMatch(/"zed"/);
        expect(validateExtensionId('gleam-zed')).toMatch(/"zed"/);
        expect(validateExtensionId('blazed-theme')).toBeUndefined();
    });

    it('rejects "extension" anywhere in the ID', () => {
        expect(validateExtensionId('gleam-extension')).toMatch(/"extension"/);
    });
});

describe('isRegistryVersion', () => {
    it('accepts plain major.minor.patch', () => {
        expect(isRegistryVersion('0.0.1')).toBe(true);
        expect(isRegistryVersion('12.4.0')).toBe(true);
    });

    it('rejects prefixes, suffixes, leading zeroes and short versions', () => {
        expect(isRegistryVersion('v1.0.0')).toBe(false);
        expect(isRegistryVersion('1.0.0-beta')).toBe(false);
        expect(isRegistryVersion('1.02.0')).toBe(false);
        expect(isRegistryVersion('1.0')).toBe(false);
    });
});

describe('isPinnedRevision', () => {
    it('accepts commit SHAs', () => {
        expect(isPinnedRevision('58b7cac8fc14c92b0677c542610d8738c373fa81')).toBe(true);
        expect(isPinnedRevision('58b7cac')).toBe(true);
    });

    it('rejects branch and tag names', () => {
        expect(isPinnedRevision('main')).toBe(false);
        expect(isPinnedRevision('v1.2.3')).toBe(false);
    });
});

describe('isLicenseFileName', () => {
    it('matches LICENSE and LICENCE prefixes in any case', () => {
        expect(isLicenseFileName('LICENSE')).toBe(true);
        expect(isLicenseFileName('licence.md')).toBe(true);
        expect(isLicenseFileName('LICENSE-MIT')).toBe(true);
        expect(isLicenseFileName('README.md')).toBe(false);
    });
});

describe('detectLicense', () => {
    it.each(ACCEPTED_LICENSES)('recognises the bundled %s template as itself', async license => {
        const text = await fs.readFile(path.join(LICENSE_TEMPLATE_DIR, license), 'utf-8');

        expect(detectLicense(text)).toBe(license);
    });

    it('has a bundled template for every accepted license', async () => {
        expect((await fs.readdir(LICENSE_TEMPLATE_DIR)).sort()).toEqual(ACCEPTED_LICENSES);
    });

    it('returns undefined for text that is not an accepted license', () => {
        expect(detectLicense('All rights reserved.')).toBeUndefined();
    });
});

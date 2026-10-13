import { describe, expect, it } from 'vitest';

import { pickCloneUrl } from './github.js';

describe('pickCloneUrl', () => {
    const urls = {
        url: 'https://github.com/you/zed-config',
        sshUrl: 'git@github.com:you/zed-config.git',
    };

    it('uses SSH when gh is set to the ssh protocol', () => {
        expect(pickCloneUrl('ssh', urls)).toBe('git@github.com:you/zed-config.git');
    });

    it('uses HTTPS otherwise, including when the setting is empty', () => {
        expect(pickCloneUrl('https', urls)).toBe('https://github.com/you/zed-config.git');
        expect(pickCloneUrl('', urls)).toBe('https://github.com/you/zed-config.git');
    });
});

import * as p from '@clack/prompts';
import color from 'picocolors';

import { validateExtensionId } from './registry-rules.js';
import type { ExtensionOptions, ExtensionType, License, LanguageOptions } from './types/index.js';

async function promptExtensionTypes(): Promise<ExtensionType[]> {
    const selected = await p.multiselect({
        message: 'What do you want to include in your extension?',
        options: [
            { value: 'theme', label: 'Theme', hint: 'Color scheme for the editor' },
            {
                value: 'language',
                label: 'Language',
                hint: 'Syntax highlighting, indentation, etc.',
            },
            {
                value: 'icon-theme',
                label: 'Icon theme',
                hint: 'File/folder icons in the project panel',
            },
        ],
        required: true,
    });
    if (p.isCancel(selected)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }
    const types = selected as ExtensionType[];

    // Zed's registry only accepts theme and icon theme extensions that provide
    // nothing else, so a mix works locally but can't be published as-is.
    const mixesThemeType =
        types.length > 1 && types.some(type => type === 'theme' || type === 'icon-theme');
    if (!mixesThemeType) return types;

    const keep = await p.confirm({
        message:
            "Zed's extension registry rejects theme and icon theme extensions that include anything else. Keep this combination anyway?",
        initialValue: false,
    });
    if (p.isCancel(keep)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    return keep ? types : promptExtensionTypes();
}

export async function promptUser(): Promise<ExtensionOptions> {
    console.log('');
    p.intro(
        `${color.bgBlue(color.bold(' zedx create '))} ${color.blue('Boilerplate generator for Zed Editor extensions.')}`,
    );

    const nameDefault = 'my-project';
    const name = await p.text({
        message: 'Project name:',
        placeholder: nameDefault,
    });
    if (p.isCancel(name)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }
    const nameValue = name || nameDefault;

    const idDefault = nameValue
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    const id = await p.text({
        message: 'Extension ID:',
        placeholder: idDefault,
        // An empty answer falls back to the default, so validate that instead.
        validate: (value: string | undefined) => validateExtensionId(value || idDefault),
    });
    if (p.isCancel(id)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }
    const idValue = id || idDefault;

    const descriptionDefault = 'A Zed extension';
    const description = await p.text({
        message: 'Description:',
        placeholder: descriptionDefault,
    });
    if (p.isCancel(description)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }
    const descriptionValue = description || descriptionDefault;

    const author = await p.text({
        message: 'Author name:',
        placeholder: 'name <username@example.com>',
        validate: (value: string | undefined) => {
            if (!value || value.length === 0) return 'Author is required';
        },
    });
    if (p.isCancel(author)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const repositoryDefault = `https://github.com/username/${idValue}.git`;
    const repository = await p.text({
        message: 'GitHub repository URL:',
        initialValue: repositoryDefault,
    });
    if (p.isCancel(repository)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }
    const repositoryValue = repository || repositoryDefault;

    const license = await p.select({
        message: 'License:',
        options: [
            { value: 'Apache-2.0', label: 'Apache 2.0' },
            { value: 'BSD-2-Clause', label: 'BSD 2-Clause' },
            { value: 'BSD-3-Clause', label: 'BSD 3-Clause' },
            { value: 'CC-BY-4.0', label: 'CC BY 4.0' },
            { value: 'GPL-3.0', label: 'GNU GPLv3' },
            { value: 'LGPL-3.0', label: 'GNU LGPLv3' },
            { value: 'MIT', label: 'MIT' },
            { value: 'Unlicense', label: 'Unlicense' },
            { value: 'Zlib', label: 'zlib' },
        ],
        initialValue: 'MIT',
    });
    if (p.isCancel(license)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const extensionTypes = await promptExtensionTypes();

    const options: ExtensionOptions = {
        name: nameValue,
        id: idValue,
        description: descriptionValue,
        author: String(author),
        repository: repositoryValue,
        license: license as License,
        types: extensionTypes,
    };

    return options;
}

export async function promptThemeDetails(): Promise<{
    themeName: string;
    appearance: 'light' | 'dark' | 'both';
}> {
    const themeName = await p.text({
        message: 'Theme name:',
        placeholder: 'My Theme',
    });
    if (p.isCancel(themeName)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const appearance = await p.select({
        message: 'Appearance:',
        options: [
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'both', label: 'Both (Dark & Light)' },
        ],
        initialValue: 'dark',
    });
    if (p.isCancel(appearance)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    return {
        themeName: String(themeName),
        appearance: appearance as 'light' | 'dark' | 'both',
    };
}

export async function promptIconThemeDetails(): Promise<{
    iconThemeName: string;
    iconThemeAppearance: 'light' | 'dark' | 'both';
}> {
    const iconThemeName = await p.text({
        message: 'Icon theme name:',
        placeholder: 'My Icon Theme',
    });
    if (p.isCancel(iconThemeName)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const appearance = await p.select({
        message: 'Icon theme appearance:',
        options: [
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'both', label: 'Both (Dark & Light)' },
        ],
        initialValue: 'dark',
    });
    if (p.isCancel(appearance)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    return {
        iconThemeName: String(iconThemeName),
        iconThemeAppearance: appearance as 'light' | 'dark' | 'both',
    };
}

export async function promptLanguageDetails(): Promise<Partial<LanguageOptions>> {
    const languageName = await p.text({
        message: 'Language name:',
        placeholder: 'My Language',
    });
    if (p.isCancel(languageName)) {
        p.cancel('Cancelled.');
        process.exit(0);
    }

    const result: Partial<LanguageOptions> = {
        languageName: String(languageName),
        languageId: String(languageName).toLowerCase().replace(/\s+/g, '-'),
    };

    return result;
}

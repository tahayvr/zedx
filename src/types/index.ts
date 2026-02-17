export type ExtensionType = 'theme';

export type License =
	| 'Apache-2.0'
	| 'BSD-2-Clause'
	| 'BSD-3-Clause'
	| 'GPL-3.0'
	| 'LGPL-3.0'
	| 'MIT'
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

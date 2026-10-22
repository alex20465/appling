import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CodegenExtension } from './contract.js';

export interface Target {
    extension: string;
    out: string;
    options?: Record<string, unknown>;
}

export interface Config {
    generate?: Target[];
}

export const CONFIG = 'appling.config.json';

export function readConfig(root: string): Config {
    const file = join(root, CONFIG);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Config : {};
}

/** Loads an extension package by name, resolved from the project root. It exports the extension as default. */
export async function loadExtension(name: string, root: string): Promise<CodegenExtension> {
    const path = createRequire(resolve(root, CONFIG)).resolve(name);
    const module = await import(pathToFileURL(path).href) as { default: CodegenExtension };
    return module.default;
}

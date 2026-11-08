import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CodegenExtension } from './contract.js';
import { STACKS, type Stack } from './stacks.js';

export { STACKS, STACK_LABELS, type Stack } from './stacks.js';

export interface Target {
    extension: string;
    out: string;
    options?: Record<string, unknown>;
}

export interface Config {
    generate?: Target[];
}

export const CONFIG = 'appling.config.json';


/** What each stack's toolchain leaves in a generated project that belongs to one machine, not to git. */
export const STACK_LOCAL: Record<Stack, string[]> = {
    django: ['.venv/', '**/__pycache__/', 'db.sqlite3'],
    ash: ['_build/', 'deps/'],
    go: [],
    rust: ['target/']
};

/** Appends the lines `.gitignore` lacks; keeps everything else. */
export function ignore(root: string, lines: string[]): void {
    const file = join(root, '.gitignore');
    const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const known = new Set(current.split('\n').map(line => line.trim()));
    const missing = lines.filter(line => !known.has(line));
    if (missing.length) writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

/**
 * Adds the stack's target to `appling.config.json` (out `build/<name>`), unless it has one, keeping everything else,
 * and ignores the target's local files in git.
 */
export function addTarget(root: string, stack: Stack, name: string): void {
    const file = join(root, CONFIG);
    const config = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    config.generate ??= [];
    if (!config.generate.some((t: Target) => t.extension === STACKS[stack])) config.generate.push({ extension: STACKS[stack], out: `build/${name}` });
    writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
    ignore(root, STACK_LOCAL[stack].map(path => `build/${name}/${path}`));
}

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

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, expect, test } from 'vitest';
import { startIdeProcess } from '../src/ide-process.js';
import { BUNDLED, programPath, type Program } from '../src/resources.js';
import { releaseUrl, updateMode } from '../src/update-policy.js';

const run = promisify(execFile);
const PROGRAMS = Object.keys(BUNDLED) as Program[];
const temp: string[] = [];
afterAll(() => temp.forEach(dir => rmSync(dir, { recursive: true, force: true })));

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'appling-desktop-'));
    temp.push(dir);
    return dir;
}

test('from the workspace every program resolves to its built package entry', () => {
    const base = tempDir();
    for (const program of PROGRAMS) expect(existsSync(programPath(program, base)), program).toBe(true);
    expect(programPath('ide', base)).toMatch(/packages[\\/]ide[\\/]out[\\/]server[\\/]main\.js$/);
    expect(programPath('pty-host', base)).toMatch(/packages[\\/]pty-host[\\/]out[\\/]main\.js$/);
    expect(programPath('language-server', base)).toMatch(/packages[\\/]lang[\\/]out[\\/]language-server\.js$/);
    expect(programPath('mcp', base)).toMatch(/packages[\\/]ai[\\/]out[\\/]main\.js$/);
    expect(programPath('ide')).toBe(programPath('ide', base));
});

test('packaged, the bundled copy next to the main file wins', () => {
    const base = tempDir();
    const bundled = join(base, BUNDLED.ide);
    mkdirSync(dirname(bundled), { recursive: true });
    writeFileSync(bundled, '');
    expect(programPath('ide', base)).toBe(bundled);
    expect(programPath('mcp', base)).not.toContain(base);
});

test('the update mode follows how the app runs and whether macOS can install the update', () => {
    const packaged = { packaged: true, signed: false };
    expect(updateMode({ ...packaged, packaged: false, platform: 'linux', appImage: '/a.AppImage' }).mode).toBe('none');
    expect(updateMode({ ...packaged, platform: 'linux', appImage: '/home/me/Appling.AppImage' })).toEqual({ mode: 'auto' });
    expect(updateMode({ ...packaged, platform: 'linux' }).mode).toBe('manual');
    expect(updateMode({ ...packaged, platform: 'win32' })).toEqual({ mode: 'auto' });
    const mac = updateMode({ ...packaged, platform: 'darwin' });
    expect(mac.mode).toBe('manual');
    expect(mac.reason).toMatch(/not signed/);
    expect(updateMode({ ...packaged, platform: 'darwin', signed: true })).toEqual({ mode: 'auto' });
    expect(updateMode({ ...packaged, platform: 'win32', disabled: '1' }).mode).toBe('none');
    expect(updateMode({ ...packaged, platform: 'win32', disabled: '0' }).mode).toBe('auto');
    expect(releaseUrl('1.2.0')).toBe('https://github.com/alex20465/appling/releases/tag/desktop-v1.2.0');
    expect(releaseUrl()).toBe('https://github.com/alex20465/appling/releases/latest');
});

test('the bundle holds every program where Desktop looks, and the bundled IDE server runs on its own', async () => {
    const app = join(tempDir(), 'app');
    await run(process.execPath, [join(import.meta.dirname, '../scripts/bundle.mjs'), '--out', app], { env: { ...process.env, APPLING_DESKTOP_VERSION: '9.8.7' } });
    for (const program of PROGRAMS) expect(programPath(program, app), program).toBe(join(app, BUNDLED[program]));
    const manifest = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    expect(manifest).toMatchObject({ name: 'appling-desktop', version: '9.8.7', main: 'out/main.js', type: 'module' });
    expect(manifest.dependencies).toBeUndefined();
    for (const file of ['out/main.js', 'out/preload.cjs', 'out/shell/index.html', 'skills/appling-registry/SKILL.md', 'ide/dist/client/index.html', 'ide/out/skills', 'ai/language', 'pty-host/package.json', 'native/node-pty/lib/index.js']) {
        expect(existsSync(join(app, file)), file).toBe(true);
    }

    const help = await run(process.execPath, [join(app, BUNDLED['pty-host']), '--help']).catch(error => error);
    expect(`${help.stdout}${help.stderr}`).toContain('Usage: appling-pty-host');

    const root = tempDir();
    writeFileSync(join(root, 'shop.appling'), 'module shop {\n  entity Order {\n    total: Int\n  }\n}\n');
    const ide = await startIdeProcess(root, { main: join(app, BUNDLED.ide) });
    try {
        expect(await (await fetch(ide.url)).text()).toContain('<html');
        expect((await (await fetch(`${ide.url}/api/snapshot`)).json()).errors).toEqual([]);
    } finally {
        ide.close();
    }
}, 120000);

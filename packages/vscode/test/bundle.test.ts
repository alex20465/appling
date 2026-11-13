import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Module, { createRequire } from 'node:module';
import { join } from 'node:path';
import { startInspectProcess } from '@appling/inspect/process';
import { expect, test } from 'vitest';

// `pnpm --filter appling-vscode build` writes out/; the extension starts this bundle for each project
test('the bundled inspect server serves a project, its client for the tab and the implementation marks', { timeout: 60000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), 'appling-vscode-'));
    cpSync(join(import.meta.dirname, '../../../examples'), root, { recursive: true });
    let marks: unknown;
    const ide = await startInspectProcess(root, { main: join(import.meta.dirname, '../out/inspect/out/server/main.js'), onImplementation: state => marks = state });
    try {
        const snapshot = await (await fetch(`${ide.url}/api/snapshot`)).json() as { graph: { nodes: { kind: string, qn: string }[] } };
        expect(snapshot.graph.nodes.filter(n => n.kind === 'Module').map(n => n.qn).sort()).toEqual(['crm', 'sales']);
        const page = await fetch(`${ide.url}/?host=frame`);
        expect(page.status).toBe(200);
        expect(page.headers.get('content-security-policy')).toContain('vscode-webview:');
        expect(await page.text()).toContain('<div id="root">');
        // a forwarded origin is trusted once the extension names it
        expect((await fetch(`${ide.url}/api/release`, { headers: { origin: 'http://localhost:49998' } })).status).toBe(403);
        ide.child.send({ type: 'trust', origin: 'http://localhost:49998' });
        await new Promise(resolve => setTimeout(resolve, 200));
        expect((await fetch(`${ide.url}/api/release`, { headers: { origin: 'http://localhost:49998' } })).status).toBe(200);
        await expect.poll(() => marks, { timeout: 20000 }).toBeTruthy();
    } finally {
        ide.close();
    }
});

test('the bundled command line that Initialize Appling runs works on its own', () => {
    const check = spawnSync(process.execPath, [join(import.meta.dirname, '../out/cli/main.js'), 'check', join(import.meta.dirname, '../../../examples')], { encoding: 'utf8' });
    expect(check.stdout).toContain('0 error(s)');
    expect(check.status).toBe(0);
});

test('the bundled extension loads: everything its packages read at load time is in the package', () => {
    // a stand in for the `vscode` module, which only exists inside VS Code
    const stub: object = new Proxy(function () { return stub; }, { get: (_, key) => key === Symbol.toPrimitive ? () => '' : stub, construct: () => stub });
    const load = (Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown })._load;
    (Module as unknown as { _load: typeof load })._load = (request, ...rest) => request === 'vscode' ? stub : load(request, ...rest);
    try {
        const extension = createRequire(import.meta.url)(join(import.meta.dirname, '../out/extension/extension.js'));
        expect(typeof extension.activate).toBe('function');
    } finally {
        (Module as unknown as { _load: typeof load })._load = load;
    }
});

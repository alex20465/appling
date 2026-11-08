import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { dialog, session, shell, WebContentsView, type Session } from 'electron';
import { BRIDGE_ENV, CodeBridge, diffMessage, openMessage, TOKEN_ENV, type TextDiffRequest } from './code-bridge.js';
import type { CodeMarks } from './ide-process.js';
import { codeServerAsset, ensureCodeServer } from './code-download.js';
import { CodeInstances, type InstanceState } from './code-instances.js';
import { CodeProxy, PROXY_COOKIE } from './code-proxy.js';
import { codeDirs, installExtension, repoKey, startCodeServer, type CodeServer } from './code-server.js';
import { loadCodeViewSettings, type CodeViewSettings } from './code-settings.js';
import { programPath } from './resources.js';
import { findCode, lineColumn, vscodeArgs } from './vscode-cli.js';

/** A source location as the IDE client knows it. */
export interface SourceLocation {
    uri: string;
    start: number;
    end?: number;
}

interface Instance {
    server: CodeServer;
    close(): Promise<void>;
}

export interface CodeViewsOptions {
    /** Hands a repo's code view to the windows as its `code` pane (issue #14), which place, size and show it. */
    attach(repo: string, view: WebContentsView): void;
    /** Takes a repo's code view out of its window; the code view closes its web contents. */
    detach(repo: string): void;
    /** The app's user data folder. */
    userData: string;
    /** The repo's IDE view, which hears the cursor of the code view. */
    ideView(repo: string): WebContentsView | undefined;
    /** Something the menu or the title depends on changed. */
    onChange(): void;
    /**
     * For a remote repo: how its Code OSS starts on the other side (`RemoteRepo.startCode`) and its folder there.
     * Undefined for local repos.
     */
    remote?(repo: string): RemoteCode | undefined;
}

/** Code OSS on a remote repo's machine, forwarded to a local port. */
export interface RemoteCode {
    folder: string;
    start(key: string): Promise<{ port: number, token: string, close(): Promise<void>, onExit(listener: (output: string) => void): void }>;
}

/** The Appling extension's package: bundled in the packaged app, else built by `appling-vscode`; `APPLING_VSIX` overrides it. */
function applingVsix(): string | undefined {
    if (process.env.APPLING_VSIX) return process.env.APPLING_VSIX;
    try {
        return programPath('vsix');
    } catch {
        return undefined;
    }
}

/**
 * The code view of every repo: an embedded Code OSS (openvscode-server) per repo behind one local proxy, shown on the
 * right of the repo's IDE view on demand. Thin Electron glue over `code-instances.ts` (lifecycle), `code-proxy.ts`,
 * `code-bridge.ts` (selection sync with the Appling extension), `code-server.ts` and `code-download.ts`.
 */
export class CodeViews {
    readonly settings: CodeViewSettings;
    private readonly root: string;
    private readonly bridge: CodeBridge;
    private readonly proxy: CodeProxy;
    private readonly instances: CodeInstances<Instance>;
    private readonly views = new Map<string, WebContentsView>();
    /** Repos whose code view is open (it shows while the repo is shown). */
    private readonly shown = new Set<string>();
    /** The file each repo had last in focus, in the code view or on the canvas, for Open in VS Code. */
    private readonly current = new Map<string, SourceLocation>();
    private readonly session: Session;
    private ready?: Promise<void>;
    private extension?: Promise<void>;

    constructor(private readonly options: CodeViewsOptions) {
        this.root = join(options.userData, 'code-oss');
        const { settings, problems } = loadCodeViewSettings(join(options.userData, 'settings.json'));
        if (problems.length) console.error(`Appling Desktop settings:\n  ${problems.join('\n  ')}`);
        this.settings = settings;
        this.bridge = new CodeBridge({
            onCursor: (repo, uri, offset) => this.cursor(repo, uri, offset),
            // the extension's CodeLens on code: the canvas shows the element it implements
            onElement: (repo, qn) => this.options.ideView(repo)?.webContents.send('codeElement', qn)
        });
        this.proxy = new CodeProxy({ bridge: (request, socket, head) => this.bridge.upgrade(request, socket, head) });
        this.session = session.fromPartition('persist:appling-code');
        this.instances = new CodeInstances<Instance>({
            launch: repo => this.launch(repo),
            lifecycle: settings.lifecycle,
            idleMs: settings.idleMinutes * 60000,
            onChange: (repo, state) => this.instanceChanged(repo, state)
        });
    }

    /** Listens on the proxy port of the last run (Code OSS's storage is per origin) and lets the code views in. */
    private start(): Promise<void> {
        this.ready ??= (async () => {
            mkdirSync(this.root, { recursive: true });
            const portFile = join(this.root, 'proxy.json');
            let preferred = 0;
            try {
                preferred = Number(JSON.parse(readFileSync(portFile, 'utf8')).port) || 0;
            } catch {
                // first start
            }
            const port = await this.proxy.listen(preferred);
            if (port !== preferred) writeFileSync(portFile, `${JSON.stringify({ port })}\n`);
            await this.session.cookies.set({ url: this.proxy.origin, name: PROXY_COOKIE, value: this.proxy.secret, httpOnly: true, sameSite: 'strict' });
        })();
        return this.ready;
    }

    /** Follows the open repos: new ones get an instance (started now with `always`), closed ones lose theirs. */
    sync(live: Set<string>): void {
        for (const repo of live) {
            if (this.instances.get(repo)) continue;
            if (this.settings.lifecycle === 'always') this.start().then(() => this.instances.add(repo), error => console.error(error));
            else this.instances.add(repo);
        }
        for (const repo of this.instances.repos()) {
            if (live.has(repo)) continue;
            this.shown.delete(repo);
            this.current.delete(repo);
            this.drop(repo);
            this.instances.remove(repo);
        }
    }

    isShown(repo: string | undefined): boolean {
        return !!repo && this.shown.has(repo);
    }

    /** Opens or hides a repo's code view; hidden, the canvas fills the repo again. */
    toggle(repo: string): void {
        if (this.shown.delete(repo)) return this.options.onChange();
        this.shown.add(repo);
        this.ensureView(repo);
        this.options.onChange();
        this.open(repo);
    }

    /**
     * Follows the repos in sight in some window (the windows place and show the views as `code` panes): an open code
     * view whose instance was suspended comes back when its repo is in sight again, and the instances learn which are
     * in sight for the idle suspend.
     */
    visible(inSight: ReadonlySet<string>): void {
        for (const repo of inSight) {
            if (!this.shown.has(repo) || this.views.has(repo)) continue;
            this.ensureView(repo);
            this.open(repo);
        }
        for (const repo of this.instances.repos()) this.instances.visible(repo, inSight.has(repo) && this.shown.has(repo));
    }

    /** An element was selected in the repo's IDE: its source opens in the code view, when that runs. */
    selected(repo: string, location: SourceLocation): void {
        this.current.set(repo, location);
        this.bridge.reveal(repo, location.uri, location.start, location.end ?? location.start);
    }

    /** Whether this platform has a code view: openvscode-server builds exist for Linux only. */
    static supported(): boolean {
        return !!process.env.APPLING_CODE_SERVER || !!codeServerAsset(process.platform, process.arch);
    }

    /** The IDE's Review tab asks for a text diff: the code view opens (starting when needed) on Code OSS's diff editor. */
    textDiff(repo: string, request: TextDiffRequest): void {
        const message = diffMessage(repo, request);
        if (!message) return;
        this.bridge.send(repo, message);
        if (!this.shown.has(repo)) this.toggle(repo);
    }

    /** The repo's implementation marks and code links, for the extension's gutter marks and CodeLenses (#20). */
    implementation(repo: string, state: CodeMarks): void {
        this.bridge.implementation(repo, state);
    }

    /** The jump from an element to its code: the code view opens (starting when needed) on the file at its lines. */
    openCode(repo: string, request: { path: string, start: number, end?: number }): void {
        const message = openMessage(repo, request);
        if (!message) return;
        this.bridge.send(repo, message);
        if (!this.shown.has(repo)) this.toggle(repo);
    }

    /** Opens the repo in VS Code, or the file last in focus at its line. */
    openInVSCode(repo: string, file: boolean): void {
        const code = findCode();
        if (!code) {
            dialog.showErrorBox('VS Code was not found', 'Install VS Code and its `code` command (in VS Code: Shell Command: Install \'code\' command in PATH).');
            return;
        }
        const location = file ? this.current.get(repo) : undefined;
        let target: { path: string, line?: number, column?: number } | undefined;
        if (location?.uri.startsWith('file:')) {
            const path = fileURLToPath(location.uri);
            try {
                target = { path, ...lineColumn(readFileSync(path, 'utf8'), location.start) };
            } catch {
                target = { path };
            }
        }
        const child = spawn(code, vscodeArgs(repo, target), { detached: true, stdio: 'ignore', shell: process.platform === 'win32' });
        child.on('error', error => dialog.showErrorBox('VS Code did not start', error.message));
        child.unref();
    }

    async close(): Promise<void> {
        for (const repo of [...this.views.keys()]) this.drop(repo);
        await this.instances.closeAll();
        this.bridge.close();
        await this.proxy.close();
    }

    private async open(repo: string): Promise<void> {
        try {
            await this.start();
            await this.instances.start(repo);
        } catch (error) {
            this.status(repo, `The code view did not start.\n\n${(error as Error).message}`);
        }
    }

    private async launch(repo: string): Promise<Instance> {
        const remote = this.options.remote?.(repo);
        if (remote) {
            // on the other machine: no selection sync yet (its extension cannot reach the local bridge)
            this.status(repo, 'Starting Code OSS on the remote side…');
            const key = repoKey(repo);
            const started = await remote.start(key);
            let instance: Instance | undefined = undefined;
            started.onExit(output => instance && this.instances.exited(repo, instance, `Code OSS ended.\n${output.trim().split('\n').slice(-20).join('\n')}`));
            this.proxy.route(key, { port: started.port, token: started.token });
            instance = {
                server: { port: started.port, token: started.token, close: started.close } as CodeServer,
                close: async () => {
                    this.proxy.route(key, undefined);
                    await started.close();
                }
            };
            return instance;
        }
        const binary = process.env.APPLING_CODE_SERVER ?? await ensureCodeServer(join(this.root, 'server'), {
            onProgress: (received, total) => this.status(repo, `Downloading Code OSS (openvscode-server) once… ${total ? `${Math.round(received / total * 100)}%` : `${Math.round(received / 1e6)} MB`}`)
        });
        const dirs = codeDirs(this.root);
        await this.installAppling(binary).catch(error => console.error(`The Appling extension was not installed: ${(error as Error).message}`));
        this.status(repo, 'Starting Code OSS…');
        const key = repoKey(repo);
        const env: NodeJS.ProcessEnv = { ...process.env, [BRIDGE_ENV]: this.proxy.bridgeUrl, [TOKEN_ENV]: this.bridge.token(repo) };
        delete env.ELECTRON_RUN_AS_NODE;
        let instance: Instance | undefined = undefined;
        const server = await startCodeServer({
            binary, key, ...dirs, env,
            onExit: (code, output) => instance && this.instances.exited(repo, instance, `Code OSS ended with code ${code}.\n${output.trim().split('\n').slice(-20).join('\n')}`)
        });
        this.proxy.route(key, { port: server.port, token: server.token });
        instance = {
            server,
            close: async () => {
                this.proxy.route(key, undefined);
                this.bridge.revoke(repo);
                await server.close();
            }
        };
        return instance;
    }

    /** Installs the bundled Appling extension once per build of it, so `.appling` files have the language server. */
    private installAppling(binary: string): Promise<void> {
        this.extension ??= (async () => {
            const vsix = applingVsix();
            if (!vsix || !existsSync(vsix)) throw new Error(`no appling.vsix (looked at ${vsix ?? 'appling-vscode'}); build packages/vscode`);
            const digest = createHash('sha256').update(readFileSync(vsix)).digest('hex');
            const marker = join(this.root, 'appling-extension.json');
            const installed = existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).sha256 : undefined;
            if (installed === digest) return;
            await installExtension(binary, vsix, codeDirs(this.root), { ...process.env, ELECTRON_RUN_AS_NODE: undefined });
            writeFileSync(marker, `${JSON.stringify({ sha256: digest })}\n`);
        })();
        return this.extension;
    }

    private instanceChanged(repo: string, state: InstanceState<Instance>): void {
        if (state.status === 'running') {
            const view = this.views.get(repo);
            if (view) view.webContents.loadURL(this.proxy.url(repoKey(repo), this.options.remote?.(repo)?.folder ?? repo));
        } else if (state.status === 'suspended' || state.status === 'stopped') this.drop(repo);
        else if (state.status === 'failed' && state.error) this.status(repo, state.error);
        this.options.onChange();
    }

    /** The cursor moved in a `.appling` file of the code view: the canvas selects the element there. */
    private cursor(repo: string, uri: string, offset: number): void {
        this.current.set(repo, { uri, start: offset });
        this.options.ideView(repo)?.webContents.send('codeCursor', uri, offset);
    }

    /** A plain page in the code view's place while the instance downloads, starts or after it failed. */
    private status(repo: string, message: string): void {
        const view = this.views.get(repo);
        if (!view) return;
        const text = message.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
        const page = `<!doctype html><meta charset="utf-8"><body style="margin:0;background:#0c0a08;color:#d8cfc4;font:13px system-ui;padding:24px"><pre style="white-space:pre-wrap;font:inherit">${text}</pre>`;
        view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page)}`);
    }

    private ensureView(repo: string): WebContentsView {
        const existing = this.views.get(repo);
        if (existing) return existing;
        const view = new WebContentsView({ webPreferences: { session: this.session, contextIsolation: true, sandbox: true, nodeIntegration: false } });
        view.setBackgroundColor('#0c0a08');
        view.webContents.setWindowOpenHandler(({ url }) => {
            if (/^https?:\/\//.test(url) && !url.startsWith(this.proxy.origin)) shell.openExternal(url);
            return { action: 'deny' };
        });
        view.webContents.on('will-navigate', (event, target) => {
            if (!target.startsWith(`${this.proxy.origin}/`)) event.preventDefault();
        });
        view.setVisible(false);
        this.views.set(repo, view);
        this.options.attach(repo, view);
        const state = this.instances.get(repo);
        if (state?.status === 'running') view.webContents.loadURL(this.proxy.url(repoKey(repo), this.options.remote?.(repo)?.folder ?? repo));
        else this.status(repo, 'Starting Code OSS…');
        return view;
    }

    private drop(repo: string): void {
        const view = this.views.get(repo);
        if (!view) return;
        this.views.delete(repo);
        this.options.detach(repo);
        view.webContents.close();
    }
}

#!/usr/bin/env node
/**
 * The remote side of a repo on another machine, `remote/agent.js` of the server bundle that `install.ts` puts on
 * that machine next to the IDE server, the pty host and Code OSS. Desktop runs it over the transport (ssh, docker exec,
 * wsl.exe) with stdio as the channel:
 *
 * - `info`: the platform, the home folder and the Node version as JSON.
 * - `ide <root> [ide args...]`: runs the IDE server with an IPC channel and relays that channel as JSON lines over
 *   stdio, so the server talks to Desktop as it does locally (ready, status, the shared agent sessions). It ends when
 *   stdin ends, as the local server ends with its IPC channel.
 * - `bridge <port | socket path>`: pipes stdio to a local port or Unix socket (`ssh -W` where there is no ssh).
 * - `pty-host`: starts the pty host when none runs (it keeps running when Desktop goes, with the terminals) and prints
 *   its socket and token as JSON.
 * - `code <root> <key>`: reads one JSON line from stdin (`{ "env": {...} }`, the code bridge's URL and token there),
 *   starts openvscode-server for the repo with it (installing the Appling extension once), prints its port and token
 *   as JSON and stops it when stdin ends.
 * - `reverse [port]`: listens on 127.0.0.1 (on the port when it is free), prints `{"port":N}` and carries every
 *   connection over stdio to Desktop, which connects it to a port there (`reverse.ts`): the agent gateway and the
 *   code bridge where there is no `ssh -R`.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { connectPtyHost, defaultDir, socketPath, tokenPath } from '@appling/pty-host';
import { codeDirs, installExtension, startCodeServer } from '../code-server.js';
import { serveReverse } from './reverse.js';

/** The server folder: the agent is `<server>/remote/agent.js`. */
const server = dirname(dirname(fileURLToPath(import.meta.url)));

async function main([command, ...args]: string[]): Promise<number> {
    if (command === 'info') {
        console.log(JSON.stringify({ platform: process.platform, arch: process.arch, home: homedir(), node: process.version }));
        return 0;
    }
    if (command === 'bridge' && args[0]) {
        const target = /^\d+$/.test(args[0]) ? { host: '127.0.0.1', port: Number(args[0]) } : { path: args[0] };
        const socket = connect(target);
        socket.on('error', error => {
            console.error(error.message);
            process.exit(1);
        });
        process.stdin.pipe(socket);
        socket.pipe(process.stdout);
        socket.once('close', () => process.exit(0));
        process.stdin.once('end', () => socket.end());
        return new Promise(() => undefined);
    }
    if (command === 'ide' && args[0]) return relayIde(args);
    if (command === 'pty-host') {
        // no notifications on that machine: Desktop raises them where the user is (`remote/notify.ts`)
        const dir = defaultDir();
        const client = await connectPtyHost({ dir, host: { main: join(server, 'pty-host/out/main.js'), node: process.execPath, idleTimeout: 10 * 60000, notify: false } });
        client.close();
        console.log(JSON.stringify({ socket: socketPath(dir), token: readFileSync(tokenPath(dir), 'utf8').trim(), pid: client.host.pid }));
        return 0;
    }
    if (command === 'code' && args[0] && args[1]) return code(args[0], args[1]);
    if (command === 'reverse') {
        await serveReverse(Number(args[0]) || 0, process.stdin, process.stdout);
        // stdin ending (Desktop or the connection went) ends the forward and its connections
        await new Promise(resolve => process.stdin.once('end', resolve));
        return 0;
    }
    console.error('Usage: agent.js info | ide <root> [args...] | bridge <port|socket> | pty-host | code <root> <key> | reverse [port]');
    return 2;
}

function relayIde(args: string[]): Promise<number> {
    const child = spawn(process.execPath, [join(server, 'ide/out/server/main.js'), ...args], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
    child.on('message', message => process.stdout.write(`${JSON.stringify(message)}\n`));
    createInterface({ input: process.stdin }).on('line', line => {
        if (!line.trim() || !child.connected) return;
        try {
            child.send(JSON.parse(line));
        } catch {
            // a broken line from the other side is dropped
        }
    });
    // Desktop going away (or the network) ends stdin: the server ends as it does with its IPC channel
    process.stdin.once('end', () => child.connected && child.disconnect());
    for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) process.once(signal, () => child.connected ? child.disconnect() : child.kill());
    return new Promise(resolve => child.once('exit', code => resolve(code ?? 1)));
}

async function code(root: string, key: string): Promise<number> {
    const dir = join(server, '..', 'code');
    const release = existsSync(dir) ? readdirSync(dir).find(entry => existsSync(join(dir, entry, 'bin', 'openvscode-server'))) : undefined;
    if (!release) {
        console.error(`No openvscode-server in ${dir}.`);
        return 1;
    }
    const binary = join(dir, release, 'bin', 'openvscode-server');
    const dirs = codeDirs(join(server, '..', 'code-data'));
    // the Appling extension of this server bundle, installed once per bundle
    const vsix = join(server, 'vscode', 'appling.vsix');
    const marker = join(dirs.serverDataDir, `appling-extension-${server.split(/[\\/]/).pop()}`);
    if (existsSync(vsix) && !existsSync(marker)) {
        await installExtension(binary, vsix, dirs).catch(error => console.error(`The Appling extension was not installed: ${(error as Error).message}`));
        mkdirSync(dirname(marker), { recursive: true });
        writeFileSync(marker, '');
    }
    const { env } = await firstLine(10000) as { env?: Record<string, string> };
    const instance = await startCodeServer({ binary, key, ...dirs, env: { ...process.env, ...env }, onExit: code => process.exit(code ?? 1) });
    console.log(JSON.stringify({ port: instance.port, token: instance.token, folder: root }));
    await new Promise<void>(resolve => {
        process.stdin.once('end', resolve);
        process.stdin.resume();
        for (const signal of ['SIGHUP', 'SIGTERM', 'SIGINT'] as const) process.once(signal, resolve);
    });
    await instance.close();
    return 0;
}

/** The first line of stdin as JSON (an empty object after the timeout or for a line that does not parse); the rest stays unread. */
function firstLine(timeout: number): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
        let text = '';
        const done = (value: Record<string, unknown>) => {
            clearTimeout(timer);
            process.stdin.off('data', data);
            process.stdin.pause();
            resolve(value);
        };
        const data = (chunk: Buffer) => {
            text += chunk.toString('utf8');
            const newline = text.indexOf('\n');
            if (newline < 0) return;
            try {
                const value = JSON.parse(text.slice(0, newline));
                done(value && typeof value === 'object' ? value : {});
            } catch {
                done({});
            }
        };
        const timer = setTimeout(() => done({}), timeout);
        process.stdin.on('data', data);
    });
}

main(process.argv.slice(2)).then(code => process.exit(code), error => {
    console.error((error as Error).stack ?? String(error));
    process.exit(1);
});

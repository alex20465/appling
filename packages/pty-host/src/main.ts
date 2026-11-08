#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { PtyHostClient } from './client.js';
import { PtyHost } from './host.js';
import { systemNotifier } from './notifier.js';
import { defaultDir } from './paths.js';
import type { TerminalInfo } from './protocol.js';
import { describeStatus } from './status.js';

const USAGE = `Usage: appling-pty-host <command> [--dir <folder>]

  serve [--idle-timeout <ms>] [--open <json argv>] [--no-notify]
                                run the host in the foreground (clients start it on demand)
  list [--group <name>] [--json]
                                list the terminals of the running host with their status and metadata
  kill <terminal>               end a terminal
  stop                          end every terminal and the host`;

async function main(argv: string[]): Promise<number> {
    let parsed;
    try {
        parsed = parseArgs({
            args: argv,
            allowPositionals: true,
            options: {
                dir: { type: 'string' }, group: { type: 'string' }, 'idle-timeout': { type: 'string' }, open: { type: 'string' },
                'no-notify': { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }
            }
        });
    } catch (error) {
        console.error(`${(error as Error).message}\n\n${USAGE}`);
        return 2;
    }
    const { values, positionals: [command, ...rest] } = parsed;
    const dir = values.dir ?? defaultDir();
    if (values.help) {
        console.log(USAGE);
        return 0;
    }
    if (command === 'serve') {
        const idleTimeout = Number(values['idle-timeout'] ?? 0);
        if (!Number.isFinite(idleTimeout) || idleTimeout < 0) {
            console.error(`Invalid --idle-timeout ${values['idle-timeout']}.`);
            return 2;
        }
        let open: string[] | undefined;
        try {
            open = values.open === undefined ? undefined : JSON.parse(values.open);
            if (open && (!Array.isArray(open) || !open.every(arg => typeof arg === 'string'))) throw new Error();
        } catch {
            console.error(`--open takes a JSON array of strings, not ${values.open}.`);
            return 2;
        }
        const notifier = values['no-notify'] ? undefined : systemNotifier();
        const host = new PtyHost({ dir, idleTimeout, open, notifier, log: message => console.error(message) });
        if (!await host.listen()) {
            console.error(`A pty host already answers on ${host.socket}.`);
            return 0;
        }
        for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(signal, () => void host.close());
        // A daemon that holds the user's sessions logs a bug instead of taking every terminal down with it.
        process.on('uncaughtException', error => console.error(error));
        await host.closed;
        // Killed ptys may still hold handles open; the host is done.
        process.exit(0);
    }
    if (command === 'list' || command === 'kill' || command === 'stop') {
        if (command === 'kill' && rest.length !== 1) {
            console.error(USAGE);
            return 2;
        }
        let client: PtyHostClient;
        try {
            client = await PtyHostClient.connect(dir);
        } catch {
            if (command === 'list') {
                if (values.json) console.log('[]');
                return 0;
            }
            console.error('No pty host is running.');
            return 1;
        }
        try {
            if (command === 'list') {
                const terminals = await client.list(values.group);
                if (values.json) console.log(JSON.stringify(terminals, null, 2));
                else for (const terminal of terminals) console.log(listLine(terminal));
            } else if (command === 'kill') await client.kill(rest[0]);
            else await client.shutdown();
            return 0;
        } catch (error) {
            console.error((error as Error).message);
            return 1;
        } finally {
            client.close();
        }
    }
    console.error(USAGE);
    return 2;
}

/** One terminal per line, tab separated: id, status, pid, group, title, metadata as `key=value` pairs, cwd. */
function listLine(t: TerminalInfo): string {
    const meta = Object.entries(t.meta ?? {}).map(([key, value]) => `${key}=${value}`).join(',');
    return [t.id, describeStatus(t.status), `pid ${t.pid}`, t.group ?? '-', t.title ?? t.shell, meta || '-', t.cwd].join('\t');
}

process.exitCode = await main(process.argv.slice(2));

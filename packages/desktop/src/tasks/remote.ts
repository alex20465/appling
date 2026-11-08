import { posix } from 'node:path';
import type { RemoteRepo } from '../remote/remote-repo.js';
import { shellQuote } from '../remote/transport.js';
import type { RemoteTerminals } from '../terminal/service.js';
import type { RemoteTasks } from './runner.js';

/**
 * How the terminals and tasks of a remote repo reach its machine: the pty host there through the socket `RemoteRepo`
 * forwards into `ptyDir`, and files, the environment and the bundled `appling` over the transport. Both throw while
 * the repo is not connected, so the terminal service and the runner try again once it is.
 */
function connected(repo: RemoteRepo | undefined, id: string): RemoteRepo & { root: string } {
    // `onConnected` comes before the connection reports `connected`, so only a failed or closed one counts as down
    if (!repo?.root || !repo.installed || repo.connection.state === 'failed' || repo.connection.state === 'closed') throw new Error(`${id} is not connected.`);
    return repo as RemoteRepo & { root: string };
}

export function remoteTerminals(repo: RemoteRepo | undefined, id: string, ptyDir: string): RemoteTerminals {
    const remote = connected(repo, id);
    if (remote.terminalsProblem) throw new Error(remote.terminalsProblem);
    return { host: { dir: ptyDir, start: false }, cwd: remote.root };
}

export function remoteTasks(repo: RemoteRepo | undefined, id: string): RemoteTasks {
    const remote = connected(repo, id);
    const { probe, agent } = remote.installed!;
    const path = (relative: string) => shellQuote(posix.join(remote.root, relative));
    return {
        root: remote.root,
        home: probe.home,
        platform: probe.platform,
        read: async relative => {
            const result = await remote.transport.exec(`cat ${path(relative)}`, { timeout: 20000 });
            return result.code === 0 ? result.stdout : undefined;
        },
        exists: async relative => (await remote.transport.exec(`test -e ${path(relative)}`, { timeout: 20000 })).code === 0,
        env: async () => {
            const result = await remote.transport.exec('env', { timeout: 20000 });
            return result.code === 0 ? parseEnv(result.stdout) : {};
        },
        // the server bundle holds the command line next to the agent (`<server>/remote/agent.js`)
        cli: { command: agent.node, args: [posix.join(posix.dirname(posix.dirname(agent.agent)), 'cli', 'out', 'main.js')], env: {} }
    };
}

/** `env` output: one `NAME=value` per line; lines without `=` continue the previous value. */
export function parseEnv(output: string): Record<string, string> {
    const env: Record<string, string> = {};
    let last: string | undefined;
    for (const line of output.split('\n')) {
        const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
        if (match) env[last = match[1]] = match[2];
        else if (last && line) env[last] += `\n${line}`;
    }
    return env;
}

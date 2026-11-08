import { posix } from 'node:path';
import type { RemoteAgentHost } from '../agents/sessions.js';
import type { RemoteRepo } from './remote-repo.js';
import { shellQuote } from './transport.js';

/** The names of the reverse forwards a remote repo keeps (`RemoteRepo.reverse`). */
export const AGENTS_FORWARD = 'agents';
export const CODE_BRIDGE_FORWARD = 'code-bridge';

/**
 * The machine of a connected remote repo for its agent sessions (#10): the gateway through a reverse forward there,
 * the session files in `<server root>/agent-sessions/<id>` there (written over the transport) and the hook client of
 * the server bundle (`remote/hook.cjs`) run by its Node binary. Undefined while the repo is not connected.
 */
export function remoteAgentHost(repo: RemoteRepo | undefined): RemoteAgentHost | undefined {
    if (!repo?.installed || !repo.root || repo.connection.state === 'failed' || repo.connection.state === 'closed') return undefined;
    const { agent, probe } = repo.installed;
    const transport = repo.transport;
    return {
        forward: (local, preferred) => repo.reverse(AGENTS_FORWARD, local, preferred),
        root: repo.root,
        folder: posix.join(probe.root, 'agent-sessions'),
        hookScript: posix.join(posix.dirname(agent.agent), 'hook.cjs'),
        node: agent.node,
        write: async files => {
            for (const [path, content] of Object.entries(files)) {
                // umask 077: the folders 0700, the files (tokens) 0600
                const result = await transport.exec(`umask 077 && mkdir -p ${shellQuote(posix.dirname(path))} && cat > ${shellQuote(path)}`, { input: Buffer.from(content), timeout: 20000 });
                if (result.code !== 0) throw new Error(`Writing ${path} on ${transport.label} failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
            }
        },
        remove: async path => {
            // only below the sessions folder
            if (!path.startsWith(`${posix.join(probe.root, 'agent-sessions')}/`)) return;
            await transport.exec(`rm -rf ${shellQuote(path)}`, { timeout: 20000 });
        }
    };
}

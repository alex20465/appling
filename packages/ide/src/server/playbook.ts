import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import { respondToStep, RESPONSE_KINDS, type AgentSession, type AppHost, type PlaybookStore, type ResponseKind, type SessionStore } from '@appling/ai';

/**
 * The workspace playbook this repo's view plays: the playbook of the workspace the app shows (Appling Desktop answers
 * through its app host), else of this repo folder, the key of sessions without a workspace.
 */
export async function playbookWorkspace(root: string, host?: AppHost): Promise<string> {
    const probe = { repo: resolve(root) } as AgentSession;
    const context = await host?.context?.(probe).catch(() => undefined);
    return context?.workspace ?? resolve(root);
}

/**
 * The playbook for the IDE client: `GET /api/playbook` (the playbook with its workspace), `POST /api/playbook/position`
 * (`{ workspace, chapter?, step }`: the user steps; counts as watched up to there) and `POST /api/playbook/respond`
 * (`{ chapter, step, kind, text? }`: approve, reject or comment; reaches the inbox of the session that wrote it).
 */
export async function servePlaybook(request: IncomingMessage, response: ServerResponse, playbooks: PlaybookStore, sessions: SessionStore, workspace: () => Promise<string>, body: () => Promise<string>): Promise<void> {
    const url = new URL(request.url!, 'http://localhost');
    const reply = (status: number, value: unknown) => {
        response.writeHead(status, { 'content-type': typeof value === 'string' ? 'text/plain' : 'application/json' });
        response.end(typeof value === 'string' ? value : JSON.stringify(value));
    };
    try {
        if (url.pathname === '/api/playbook' && request.method === 'GET') return reply(200, await playbooks.read(await workspace()));
        if (request.method !== 'POST') return reply(405, 'Method not allowed');
        const input = JSON.parse(await body() || '{}') as { workspace?: string, chapter?: string, step?: number, kind?: ResponseKind, text?: string };
        if (url.pathname === '/api/playbook/position') {
            return reply(200, await playbooks.move(typeof input.workspace === 'string' ? input.workspace : await workspace(), { chapter: input.chapter, step: Number(input.step ?? 0) }));
        }
        if (url.pathname === '/api/playbook/respond') {
            if (!input.chapter || !Number.isInteger(input.step) || !RESPONSE_KINDS.includes(input.kind!)) return reply(400, 'A chapter, a step and a kind (approve, reject or comment) are required.');
            const { delivered } = await respondToStep(playbooks, sessions, input.chapter, input.step!, { kind: input.kind!, text: input.text });
            return reply(200, { ok: true, delivered });
        }
        reply(404, 'Not found');
    } catch (error) {
        reply(400, (error as Error).message);
    }
}

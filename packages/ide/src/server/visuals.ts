import { randomUUID } from 'node:crypto';
import type { VisualHost } from '@appling/ai';
import { nextShow, type Decision } from '@appling/viz/protocol';
import type { AgentView, Proposal } from '../shared/live.js';
import type { ClientContext } from './sessions.js';

/**
 * The visual tools of the agent sessions on this repo's canvas: each session's view, bubbles, steps and replies, and
 * the proposals waiting for the user's decision. Changes go to every IDE client over `/events` as
 * `{ type: 'agent-view', view }` and `{ type: 'proposals', proposals }`; the client draws a view only once the user
 * opens it, so the canvas never moves on its own.
 */
export class AgentViews {
    private readonly views = new Map<string, AgentView>();
    private readonly pending = new Map<string, Proposal & { resolve(decision: Decision): void }>();

    constructor(private readonly broadcast: (message: unknown) => void, private readonly client: ClientContext, private readonly clients: () => number) {}

    /** The visual host of one session for its MCP server. */
    host(session: string): VisualHost {
        return {
            surface: 'canvas',
            show: async show => this.change(session, view => {
                const next = nextShow(view.show, show);
                view.show = next.show;
                if (!next.keep) view.bubbles = [];
            }),
            bubble: bubble => {
                this.change(session, view => {
                    view.show ??= { view: 'node', focus: [bubble.target] };
                    view.bubbles.push(bubble);
                });
                return true;
            },
            selection: () => ({
                open: this.clients() > 0,
                qn: this.client.selection,
                view: this.client.watching === session ? this.views.get(session)?.show : undefined
            }),
            reply: text => {
                this.change(session, view => { view.replies.push(text); });
                return true;
            },
            status: async status => this.change(session, view => { view.steps.push(status); }),
            review: review => new Promise<Decision>(resolve => {
                const id = randomUUID();
                this.pending.set(id, { id, session, review, at: new Date().toISOString(), resolve });
                this.sendProposals();
            })
        };
    }

    /** Resolves a waiting proposal with the user's decision; false when it is no longer waiting. */
    decide(id: string, decision: Decision): boolean {
        const proposal = this.pending.get(id);
        if (!proposal) return false;
        this.pending.delete(id);
        proposal.resolve(decision);
        this.sendProposals();
        return true;
    }

    all(): AgentView[] {
        return [...this.views.values()];
    }

    proposals(): Proposal[] {
        return [...this.pending.values()].map(({ resolve: _, ...proposal }) => proposal);
    }

    /** Drops the views of sessions that ended and rejects their proposals. */
    prune(sessions: string[]): void {
        const live = new Set(sessions);
        for (const session of [...this.views.keys()].filter(s => !live.has(s))) {
            this.views.delete(session);
            this.broadcast({ type: 'agent-view', view: { session, bubbles: [], steps: [], replies: [], at: new Date().toISOString() } satisfies AgentView, ended: true });
        }
        for (const proposal of [...this.pending.values()].filter(p => !live.has(p.session))) this.decide(proposal.id, { accepted: false, comment: 'The session ended.' });
    }

    private change(session: string, apply: (view: AgentView) => void): void {
        const view = this.views.get(session) ?? { session, bubbles: [], steps: [], replies: [], at: '' };
        apply(view);
        view.at = new Date().toISOString();
        this.views.set(session, view);
        this.broadcast({ type: 'agent-view', view });
    }

    private sendProposals(): void {
        this.broadcast({ type: 'proposals', proposals: this.proposals() });
    }
}

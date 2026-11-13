import type { VisualHost } from '@appling/ai';
import { nextShow } from '@appling/viz/protocol';
import type { SessionStore } from '@appling/ai';
import type { AgentView } from '../shared/live.js';
import type { ClientContext } from './sessions.js';

/**
 * The visual tools of the agent sessions on this repo's canvas: each session's view, bubbles, steps and replies.
 * Changes go to every client over `/events` as `{ type: 'agent-view', view }`; the client draws a view only once the
 * user opens it, so the canvas never moves on its own.
 */
export class AgentViews {
    private readonly views = new Map<string, AgentView>();

    constructor(private readonly broadcast: (message: unknown) => void, private readonly client: ClientContext, private readonly clients: () => number) {}

    /** The visual host of one session for its MCP server. */
    host(session: string): VisualHost {
        return {
            show: async (show, bubbles) => this.change(session, view => {
                if (bubbles) return void Object.assign(view, { show, bubbles, playbook: true });
                const next = nextShow(view.show, show);
                if (!next.keep) view.playbook = false;
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
            status: async status => this.change(session, view => { view.steps.push(status); })
        };
    }

    /**
     * A question the user typed to a session in its view: it reaches the session's inbox as a message from User (the
     * MCP results tell the agent that messages wait), and the view keeps it next to the answers.
     */
    async ask(sessions: SessionStore, session: string, text: string): Promise<void> {
        await sessions.post(session, { fromLabel: 'User', text: `${text}\n\n(Asked in your view on the repo's canvas in Appling; answer there with visual_reply.)` });
        this.change(session, view => { (view.questions ??= []).push(text); });
    }

    all(): AgentView[] {
        return [...this.views.values()];
    }

    /** Drops the views of sessions that ended. */
    prune(sessions: string[]): void {
        const live = new Set(sessions);
        for (const session of [...this.views.keys()].filter(s => !live.has(s))) {
            this.views.delete(session);
            this.broadcast({ type: 'agent-view', view: { session, bubbles: [], steps: [], replies: [], at: new Date().toISOString() } satisfies AgentView, ended: true });
        }
    }

    private change(session: string, apply: (view: AgentView) => void): void {
        const view = this.views.get(session) ?? { session, bubbles: [], steps: [], replies: [], at: '' };
        apply(view);
        view.at = new Date().toISOString();
        this.views.set(session, view);
        this.broadcast({ type: 'agent-view', view });
    }
}

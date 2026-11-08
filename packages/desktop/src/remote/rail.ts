import type { RailContribution } from '../rail-status.js';
import type { ConnectionState } from './connection.js';

/**
 * What the `connection` source of the rail reports for a remote repo: its state (the shell marks the button by it)
 * and a tooltip line, such as `Reconnecting to SSH build (attempt 2, next in 4 s): <why>`.
 */
export function connectionContribution(state: ConnectionState, detail: { label: string, attempt: number, retryIn?: number, error?: string, progress?: string }): RailContribution {
    const why = detail.error ? `: ${detail.error.split('\n')[0]}` : '';
    const line = state === 'connecting' ? `Connecting to ${detail.label}${detail.progress ? ` (${detail.progress})` : ''}`
        : state === 'connected' ? `Connected to ${detail.label}`
        : state === 'reconnecting' ? `Reconnecting to ${detail.label} (attempt ${detail.attempt}${detail.retryIn !== undefined ? `, next in ${Math.round(detail.retryIn / 1000)} s` : ''})${why}`
        : state === 'failed' ? `Could not connect to ${detail.label}${why}`
        : `Disconnected from ${detail.label}`;
    return { connection: state, notes: [line] };
}

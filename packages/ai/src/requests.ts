import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * An element the person asked for on the canvas by name, description and kind: an agent models it (writes its Appling
 * source) and then marks the request done. A request can build on another one not modeled yet; it waits until that
 * one is done and then goes under its element. Kept per workspace in `.appling/requests.json`.
 */
export interface ElementRequest {
    id: string;
    name: string;
    description: string;
    /** The kind asked for, such as Entity or Action; none leaves it to the agent. */
    kind?: string;
    /** The element or module it was asked for under; none for the model as a whole or when it builds on another request. */
    parent?: string;
    /** The request it builds on, still to be modeled. */
    parentRequest?: string;
    at: string;
    /** When an agent took it with `request_next`. */
    taken?: string;
    /** The agent session that took it. */
    takenBy?: string;
}

export const REQUESTS = join('.appling', 'requests.json');

export function readRequests(root: string): ElementRequest[] {
    const file = join(root, REQUESTS);
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

function writeRequests(root: string, requests: ElementRequest[]): void {
    const file = join(root, REQUESTS);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(requests, null, 2) + '\n');
}

export function addRequest(root: string, request: { name: string, description: string, kind?: string, parent?: string, parentRequest?: string }): ElementRequest {
    const { name, description, kind, parent, parentRequest } = request;
    const added: ElementRequest = { id: randomUUID().slice(0, 8), name, description, ...kind ? { kind } : {}, ...parentRequest ? { parentRequest } : parent ? { parent } : {}, at: new Date().toISOString() };
    writeRequests(root, [...readRequests(root), added]);
    return added;
}

/** Changes a request's name, description or kind; undefined when there is no such request. */
export function updateRequest(root: string, id: string, change: { name?: string, description?: string, kind?: string }): ElementRequest | undefined {
    const requests = readRequests(root);
    const request = requests.find(r => r.id === id);
    if (!request) return undefined;
    Object.assign(request, change);
    writeRequests(root, requests);
    return request;
}

/**
 * Removes a request. Once its element `qn` is in the model, the requests built on it go under that element; without
 * one they are removed too. Returns the removed requests, none when there is no such request.
 */
export function removeRequest(root: string, id: string, qn?: string): ElementRequest[] {
    const requests = readRequests(root);
    if (!requests.some(r => r.id === id)) return [];
    const removed = new Set([id]);
    // a request is added after the one it builds on, so one pass finds every request built on a removed one
    for (const request of requests) {
        if (!request.parentRequest || !removed.has(request.parentRequest)) continue;
        if (qn) Object.assign(request, { parent: qn, parentRequest: undefined });
        else removed.add(request.id);
    }
    writeRequests(root, requests.filter(r => !removed.has(r.id)));
    return requests.filter(r => removed.has(r.id));
}

/**
 * The oldest request no agent took yet, else the oldest this session took, else the oldest taken one, marked taken
 * now by this session. Requests that build on another one wait for it.
 */
export function takeRequest(root: string, session?: string): ElementRequest | undefined {
    const requests = readRequests(root);
    const open = requests.filter(r => !r.parentRequest);
    const request = open.find(r => !r.taken) ?? open.find(r => session && r.takenBy === session) ?? open[0];
    if (!request) return undefined;
    Object.assign(request, { taken: new Date().toISOString(), takenBy: session });
    writeRequests(root, requests);
    return request;
}

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/**
 * An element the person asked for on the canvas by name and description only: an agent models it (writes its Appling
 * source) and then marks the request done. Kept per workspace in `.appling/requests.json`.
 */
export interface ElementRequest {
    id: string;
    name: string;
    description: string;
    /** The element or module it was asked for under; none for the model as a whole. */
    parent?: string;
    at: string;
    /** When an agent took it with `request_next`. */
    taken?: string;
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

export function addRequest(root: string, request: { name: string, description: string, parent?: string }): ElementRequest {
    const added: ElementRequest = { id: randomUUID().slice(0, 8), name: request.name, description: request.description, ...request.parent ? { parent: request.parent } : {}, at: new Date().toISOString() };
    writeRequests(root, [...readRequests(root), added]);
    return added;
}

/** Changes a request's name or description; undefined when there is no such request. */
export function updateRequest(root: string, id: string, change: { name?: string, description?: string }): ElementRequest | undefined {
    const requests = readRequests(root);
    const request = requests.find(r => r.id === id);
    if (!request) return undefined;
    Object.assign(request, change);
    writeRequests(root, requests);
    return request;
}

/** Removes a request; false when there was none. */
export function removeRequest(root: string, id: string): boolean {
    const requests = readRequests(root);
    const rest = requests.filter(r => r.id !== id);
    if (rest.length === requests.length) return false;
    writeRequests(root, rest);
    return true;
}

/** The oldest request no agent took yet, else the oldest taken one, marked taken now. */
export function takeRequest(root: string): ElementRequest | undefined {
    const requests = readRequests(root);
    const request = requests.find(r => !r.taken) ?? requests[0];
    if (!request) return undefined;
    request.taken = new Date().toISOString();
    writeRequests(root, requests);
    return request;
}

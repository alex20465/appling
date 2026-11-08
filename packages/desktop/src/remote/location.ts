import { basename, isAbsolute, resolve } from 'node:path';

/**
 * Where a repo lives. Its id (`locationId`) is what the workspaces, the rail and the session key it by: the absolute
 * path for a local folder, a URI for a remote one.
 */
export type RepoLocation =
    | { kind: 'local', path: string }
    /** A folder on an SSH host: an alias of `~/.ssh/config` or a host name, with an optional user and port. */
    | { kind: 'ssh', host: string, user?: string, port?: number, path: string }
    /**
     * A local folder opened in its dev container (`.devcontainer/devcontainer.json`); `workspace` is the folder in the
     * container, when known (from a VS Code URI; else devcontainer.json decides).
     */
    | { kind: 'container', folder: string, workspace?: string }
    /** A folder in a WSL distribution. */
    | { kind: 'wsl', distro: string, path: string };

export type RemoteLocation = Exclude<RepoLocation, { kind: 'local' }>;

const SCHEMES = ['ssh://', 'wsl://', 'devcontainer://'];

/** Whether a repo id (or a path given on the command line) names a remote repo. */
export function isRemoteId(text: string): boolean {
    return SCHEMES.some(scheme => text.startsWith(scheme)) || text.startsWith('vscode-remote://');
}

/**
 * Reads a repo as the user or a file names it: a local path (relative ones against `base`), `ssh://[user@]host[:port]/path`
 * (`/~/src` for a path in the home folder), `wsl://distro/path`, `devcontainer:///local/folder` or a VS Code remote URI
 * (`vscode-remote://ssh-remote+host/path`, `wsl+distro`, `dev-container+<hex>`). Throws on a malformed or unknown remote.
 */
export function parseLocation(text: string, base = process.cwd()): RepoLocation {
    if (text.startsWith('vscode-remote://')) return fromVscodeUri(text);
    if (text.startsWith('ssh://')) {
        const { authority, path } = split(text.slice('ssh://'.length), text);
        const at = authority.lastIndexOf('@');
        const user = at >= 0 ? decodeURIComponent(authority.slice(0, at)) : undefined;
        let host = authority.slice(at + 1);
        let port: number | undefined;
        const colon = host.lastIndexOf(':');
        if (colon >= 0 && !host.endsWith(']')) {
            port = Number(host.slice(colon + 1));
            if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${text}: bad port`);
            host = host.slice(0, colon);
        }
        host = host.replace(/^\[(.*)\]$/, '$1');
        if (!host) throw new Error(`${text}: no host`);
        return { kind: 'ssh', host, ...user ? { user } : {}, ...port ? { port } : {}, path: remotePath(path) };
    }
    if (text.startsWith('wsl://')) {
        const { authority, path } = split(text.slice('wsl://'.length), text);
        if (!authority) throw new Error(`${text}: no distribution`);
        return { kind: 'wsl', distro: decodeURIComponent(authority), path: remotePath(path) };
    }
    if (text.startsWith('devcontainer://')) {
        const rest = decodeURIComponent(text.slice('devcontainer://'.length));
        if (!rest.startsWith('/')) throw new Error(`${text}: expected devcontainer:///<local folder>`);
        // devcontainer:///C:/work/shop on Windows
        const folder = /^\/[A-Za-z]:\//.test(rest) ? rest.slice(1) : rest;
        return { kind: 'container', folder: resolve(folder) };
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) throw new Error(`${text}: unknown kind of repo`);
    return { kind: 'local', path: resolve(base, text) };
}

/** `user@host:port` and the path after it; the path keeps its leading slash. */
function split(rest: string, text: string): { authority: string, path: string } {
    const slash = rest.indexOf('/');
    if (slash < 0) throw new Error(`${text}: no path`);
    return { authority: rest.slice(0, slash), path: decodeURIComponent(rest.slice(slash)) };
}

/** `/~` and `/~/x` mean the home folder; every other path is absolute. Trailing slashes go. */
function remotePath(path: string): string {
    const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path;
    return trimmed === '/~' || trimmed.startsWith('/~/') ? trimmed.slice(1) : trimmed;
}

/** The id of a location: the absolute path of a local folder, the canonical URI of a remote one. */
export function locationId(location: RepoLocation): string {
    switch (location.kind) {
        case 'local': return resolve(location.path);
        case 'ssh': {
            const host = location.host.includes(':') ? `[${location.host}]` : location.host;
            const user = location.user ? `${encodeURIComponent(location.user)}@` : '';
            return `ssh://${user}${host}${location.port ? `:${location.port}` : ''}${uriPath(location.path)}`;
        }
        case 'wsl': return `wsl://${encodeURIComponent(location.distro)}${uriPath(location.path)}`;
        case 'container': return `devcontainer://${uriPath(location.folder.replace(/\\/g, '/'))}`;
    }
}

function uriPath(path: string): string {
    const absolute = path.startsWith('/') ? path : `/${path}`;
    return encodeURI(absolute).replace(/[?#]/g, encodeURIComponent);
}

/**
 * The repo id of a path or URI: local paths resolve, remote URIs (also VS Code's) become canonical. Text that does not
 * parse is kept as it is, so a broken entry still shows (and fails) instead of vanishing.
 */
export function repoId(text: string): string {
    try {
        return locationId(parseLocation(text));
    } catch {
        return text;
    }
}

/** The folder's name as the rail shows it: the last part of the path, with the host for remote repos. */
export function locationName(location: RepoLocation): string {
    switch (location.kind) {
        case 'local': return basename(location.path) || location.path;
        case 'ssh': return `${lastPart(location.path)} [${location.host}]`;
        case 'wsl': return `${lastPart(location.path)} [WSL: ${location.distro}]`;
        case 'container': return `${basename(location.folder) || location.folder} [Container]`;
    }
}

function lastPart(path: string): string {
    return path.split('/').filter(Boolean).pop() ?? path;
}

/** A short description for tooltips and errors: `SSH host shop`, `the dev container of /work/shop`, `WSL Ubuntu`. */
export function describeLocation(location: RemoteLocation): string {
    switch (location.kind) {
        case 'ssh': return `SSH ${location.user ? `${location.user}@` : ''}${location.host}${location.port ? `:${location.port}` : ''}`;
        case 'wsl': return `WSL ${location.distro}`;
        case 'container': return `the dev container of ${location.folder}`;
    }
}

const hex = (text: string) => Buffer.from(text, 'utf8').toString('hex');
const unhex = (text: string) => /^([0-9a-f]{2})+$/i.test(text) ? Buffer.from(text, 'hex').toString('utf8') : undefined;

/**
 * A remote folder as VS Code writes it into a `.code-workspace` file's `uri`: `vscode-remote://ssh-remote+<host>/path`,
 * `wsl+<distro>`, `dev-container+<hex of the local folder>/<folder in the container>`. The container's folder defaults
 * to devcontainer.json's default, `/workspaces/<folder name>`.
 */
export function toVscodeUri(location: RemoteLocation): string {
    switch (location.kind) {
        case 'ssh': {
            if (!location.port) return `vscode-remote://ssh-remote+${encodeURIComponent(`${location.user ? `${location.user}@` : ''}${location.host}`)}${uriPath(location.path)}`;
            // VS Code writes a host with more than a name as hex encoded JSON
            const spec = { hostName: location.host, ...location.user ? { user: location.user } : {}, port: location.port };
            return `vscode-remote://ssh-remote+${hex(JSON.stringify(spec))}${uriPath(location.path)}`;
        }
        case 'wsl': return `vscode-remote://wsl+${encodeURIComponent(location.distro)}${uriPath(location.path)}`;
        case 'container': return `vscode-remote://dev-container+${hex(location.folder)}${uriPath(location.workspace ?? `/workspaces/${basename(location.folder)}`)}`;
    }
}

/** VS Code's remote URI of a path on the location's machine: `toVscodeUri` of the location with that path. */
export function vscodeUriAt(location: RemoteLocation, path: string): string {
    return toVscodeUri(location.kind === 'container' ? { ...location, workspace: path } : { ...location, path });
}

/** Reads a VS Code remote URI (see `toVscodeUri`, also the hex encoded JSON authorities VS Code writes). Throws for other kinds. */
export function fromVscodeUri(uri: string): RemoteLocation {
    const match = /^vscode-remote:\/\/([^/+]+)\+([^/]*)(\/.*)?$/.exec(uri);
    if (!match) throw new Error(`${uri}: not a VS Code remote URI`);
    const [, kind, rawAuthority, rawPath = '/'] = match;
    const authority = decodeURIComponent(rawAuthority);
    const path = remotePath(decodeURIComponent(rawPath));
    const decoded = unhex(authority);
    const spec = decoded?.startsWith('{') ? JSON.parse(decoded) as Record<string, unknown> : undefined;
    if (kind === 'ssh-remote') {
        if (spec) {
            const host = String(spec.hostName ?? spec.host ?? '');
            if (!host) throw new Error(`${uri}: no host`);
            const port = Number(spec.port);
            return { kind: 'ssh', host, ...typeof spec.user === 'string' ? { user: spec.user } : {}, ...Number.isInteger(port) && port > 0 ? { port } : {}, path };
        }
        const at = authority.lastIndexOf('@');
        return { kind: 'ssh', host: authority.slice(at + 1), ...at >= 0 ? { user: authority.slice(0, at) } : {}, path };
    }
    if (kind === 'wsl') return { kind: 'wsl', distro: authority, path };
    if (kind === 'dev-container') {
        const folder = spec ? String(spec.hostPath ?? '') : decoded ?? authority;
        if (!folder || !isAbsolute(folder) && !/^[A-Za-z]:[\\/]/.test(folder)) throw new Error(`${uri}: no local folder`);
        return { kind: 'container', folder: resolve(folder), workspace: path };
    }
    throw new Error(`${uri}: ${kind} folders are not supported`);
}

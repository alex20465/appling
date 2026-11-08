import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { stripJsonc } from '../code-workspace.js';

/** What Desktop needs of a devcontainer.json: how to get the container and where the repo is inside it. */
export interface DevContainerConfig {
    /** The devcontainer.json itself. */
    file: string;
    name?: string;
    image?: string;
    /** The Dockerfile (absolute) and its build context (absolute), for `build.dockerfile` or the older `dockerFile`. */
    dockerfile?: string;
    context?: string;
    buildArgs: Record<string, string>;
    /** The repo's folder in the container; `/workspaces/<folder name>` by default. */
    workspaceFolder: string;
    /** The `--mount` value that puts the repo there; a bind mount of the folder by default. */
    workspaceMount: string;
    /** The user commands run as (`remoteUser`, else `containerUser`); the image's user when unset. */
    user?: string;
    containerEnv: Record<string, string>;
    runArgs: string[];
    /** Docker Compose based configs, which only the devcontainer CLI starts. */
    compose: boolean;
}

/** The devcontainer.json of a folder, where VS Code looks: `.devcontainer/devcontainer.json`, `.devcontainer.json`, then `.devcontainer/<name>/devcontainer.json`. */
export function findDevcontainer(folder: string): string | undefined {
    const candidates = [join(folder, '.devcontainer', 'devcontainer.json'), join(folder, '.devcontainer.json')];
    const dir = join(folder, '.devcontainer');
    if (existsSync(dir)) {
        for (const entry of readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()) candidates.push(join(dir, entry, 'devcontainer.json'));
    }
    return candidates.find(file => existsSync(file));
}

/**
 * Reads a devcontainer.json (JSON with comments) for the repo in `folder`. Fills in the variables
 * `${localWorkspaceFolder}`, `${localWorkspaceFolderBasename}`, `${containerWorkspaceFolder}`,
 * `${containerWorkspaceFolderBasename}` and `${localEnv:NAME}`. Throws when it names neither an image, a Dockerfile
 * nor a compose file.
 */
export function parseDevcontainer(text: string, file: string, folder: string, env: NodeJS.ProcessEnv = process.env): DevContainerConfig {
    const json = JSON.parse(stripJsonc(text)) as Record<string, unknown>;
    if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`${file}: a devcontainer.json holds an object`);
    const local = resolve(folder);
    const substitute = (value: string, workspace?: string): string => value
        .replace(/\$\{localWorkspaceFolder\}/g, local)
        .replace(/\$\{localWorkspaceFolderBasename\}/g, basename(local))
        .replace(/\$\{containerWorkspaceFolder\}/g, workspace ?? '')
        .replace(/\$\{containerWorkspaceFolderBasename\}/g, workspace ? basename(workspace) : '')
        .replace(/\$\{localEnv:([^}:]+)(?::([^}]*))?\}/g, (_, name: string, fallback?: string) => env[name] ?? fallback ?? '');
    const string = (value: unknown) => typeof value === 'string' && value ? value : undefined;
    const workspaceFolder = substitute(string(json.workspaceFolder) ?? `/workspaces/${basename(local)}`);
    const sub = (value: string) => substitute(value, workspaceFolder);
    const map = (value: unknown): Record<string, string> => Object.fromEntries(Object.entries(value && typeof value === 'object' ? value : {})
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string').map(([k, v]) => [k, sub(v)]));
    const build = (json.build && typeof json.build === 'object' ? json.build : {}) as Record<string, unknown>;
    const dockerfile = string(build.dockerfile) ?? string(json.dockerFile);
    const configDir = dirname(file);
    const config: DevContainerConfig = {
        file,
        ...string(json.name) ? { name: string(json.name) } : {},
        ...string(json.image) ? { image: sub(string(json.image)!) } : {},
        ...dockerfile ? { dockerfile: resolve(configDir, sub(dockerfile)), context: resolve(configDir, sub(string(build.context) ?? '.')) } : {},
        buildArgs: map(build.args),
        workspaceFolder,
        workspaceMount: sub(string(json.workspaceMount) ?? `type=bind,source=${local},target=${workspaceFolder}`),
        ...string(json.remoteUser) ?? string(json.containerUser) ? { user: string(json.remoteUser) ?? string(json.containerUser) } : {},
        containerEnv: map(json.containerEnv),
        runArgs: Array.isArray(json.runArgs) ? json.runArgs.filter((a): a is string => typeof a === 'string').map(sub) : [],
        compose: json.dockerComposeFile !== undefined
    };
    if (!config.image && !config.dockerfile && !config.compose) throw new Error(`${file}: names no image, Dockerfile or compose file`);
    return config;
}

export function readDevcontainer(folder: string, env: NodeJS.ProcessEnv = process.env): DevContainerConfig {
    const file = findDevcontainer(folder);
    if (!file) throw new Error(`${folder} has no .devcontainer/devcontainer.json`);
    return parseDevcontainer(readFileSync(file, 'utf8'), file, folder, env);
}

/** The labels a container of the folder carries; the devcontainer CLI and VS Code use the same, so their containers are found too. */
export function containerLabels(folder: string, config: DevContainerConfig): string[] {
    return [`devcontainer.local_folder=${resolve(folder)}`, `devcontainer.config_file=${config.file}`];
}

/** The image a Dockerfile builds into, one per repo folder. */
export function imageTag(folder: string): string {
    return `appling-devcontainer-${createHash('sha256').update(resolve(folder)).digest('hex').slice(0, 12)}`;
}

/** How to get a running container without the devcontainer CLI: every step a `docker` command line. */
export interface ContainerPlan {
    /** Lists the containers of the folder (running or not), newest first: `docker ps -a -q --filter label=...`. */
    find: string[];
    /** Builds the image when the config has a Dockerfile. */
    build?: string[];
    /** Creates and starts the container, kept alive by a sleeping shell (as the devcontainer CLI does). */
    run: string[];
    /** Starts a stopped container. */
    start(id: string): string[];
}

export function containerPlan(folder: string, config: DevContainerConfig): ContainerPlan {
    if (config.compose) throw new Error(`${config.file}: Docker Compose dev containers need the devcontainer CLI (npm install -g @devcontainers/cli)`);
    const labels = containerLabels(folder, config);
    const image = config.dockerfile ? imageTag(folder) : config.image!;
    return {
        find: ['ps', '-a', '-q', '--filter', `label=${labels[0]}`],
        ...config.dockerfile ? {
            build: ['build', '-f', config.dockerfile, '-t', image, ...Object.entries(config.buildArgs).flatMap(([k, v]) => ['--build-arg', `${k}=${v}`]), config.context!]
        } : {},
        run: [
            'run', '-d',
            ...labels.flatMap(label => ['--label', label]),
            '--mount', config.workspaceMount,
            ...Object.entries(config.containerEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
            ...config.runArgs,
            '--entrypoint', '/bin/sh', image,
            '-c', 'echo Container started; trap "exit 0" 15; while sleep 1 & wait $!; do :; done'
        ],
        start: id => ['start', id]
    };
}

/** The devcontainer CLI's command line, which builds, starts and sets up the container the way VS Code does. */
export function devcontainerUpArgs(folder: string, config?: DevContainerConfig): string[] {
    return ['up', '--workspace-folder', resolve(folder), ...config ? ['--config', config.file] : []];
}

/** What `devcontainer up` reports on its last line: `{"outcome":"success","containerId":...,"remoteUser":...,"remoteWorkspaceFolder":...}`. */
export function parseDevcontainerUp(output: string): { containerId: string, user?: string, workspaceFolder?: string } {
    const line = output.trim().split('\n').reverse().find(l => l.trim().startsWith('{'));
    const result = line ? JSON.parse(line) as Record<string, unknown> : {};
    if (result.outcome !== 'success' || typeof result.containerId !== 'string') {
        throw new Error(`devcontainer up failed: ${typeof result.message === 'string' ? result.message : output.trim().split('\n').slice(-5).join('\n')}`);
    }
    return {
        containerId: result.containerId,
        ...typeof result.remoteUser === 'string' ? { user: result.remoteUser } : {},
        ...typeof result.remoteWorkspaceFolder === 'string' ? { workspaceFolder: result.remoteWorkspaceFolder } : {}
    };
}

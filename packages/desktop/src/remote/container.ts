import { containerPlan, devcontainerUpArgs, parseDevcontainerUp, readDevcontainer } from './devcontainer.js';
import { execFile } from './transport.js';

export interface ContainerStartOptions {
    docker?: string;
    /** The devcontainer CLI; when it runs (`devcontainer --version`), it brings the container up the way VS Code does. */
    devcontainer?: string;
    /** Called with progress lines (`Building the image…`). */
    onProgress?(line: string): void;
    env?: NodeJS.ProcessEnv;
}

/**
 * Brings up the dev container of a local folder and tells its id, the user to run as and the repo's folder in it.
 * With the devcontainer CLI it runs `devcontainer up`, else it reuses the folder's container (by the labels the CLI and
 * VS Code put on theirs too), starting it when stopped, or builds and runs one from devcontainer.json's image or
 * Dockerfile. Features, lifecycle commands and compose files need the CLI.
 */
export async function startContainer(folder: string, options: ContainerStartOptions = {}): Promise<{ container: string, user?: string, workspace: string }> {
    const docker = options.docker ?? 'docker';
    const config = readDevcontainer(folder, options.env);
    const cli = options.devcontainer ?? 'devcontainer';
    if (await runs(cli, ['--version'])) {
        options.onProgress?.('Starting the dev container (devcontainer up)…');
        const result = await execFile(cli, devcontainerUpArgs(folder, config));
        const up = parseDevcontainerUp(result.stdout || result.stderr);
        return { container: up.containerId, user: up.user ?? config.user, workspace: up.workspaceFolder ?? config.workspaceFolder };
    }
    const plan = containerPlan(folder, config);
    const run = async (args: string[], what: string) => {
        const result = await execFile(docker, args);
        if (result.code !== 0) throw new Error(`${what} failed: ${(result.stderr || result.stdout).trim().split('\n').slice(-8).join('\n')}`);
        return result.stdout.trim();
    };
    const [existing] = (await run(plan.find, 'docker ps')).split('\n').filter(Boolean);
    if (existing) {
        const running = await run(['inspect', '-f', '{{.State.Running}}', existing], 'docker inspect');
        if (running !== 'true') {
            options.onProgress?.('Starting the dev container…');
            await run(plan.start(existing), 'docker start');
        }
        return { container: existing, user: config.user, workspace: config.workspaceFolder };
    }
    if (plan.build) {
        options.onProgress?.('Building the dev container image…');
        await run(plan.build, 'docker build');
    }
    options.onProgress?.('Creating the dev container…');
    const id = await run(plan.run, 'docker run');
    return { container: id.split('\n').pop()!, user: config.user, workspace: config.workspaceFolder };
}

async function runs(file: string, args: string[]): Promise<boolean> {
    try {
        return (await execFile(file, args, { timeout: 10000 })).code === 0;
    } catch {
        return false;
    }
}

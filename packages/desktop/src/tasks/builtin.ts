import { join } from 'node:path';
import type { Platform, TaskDefinition, TaskFile, TaskInput } from './definitions.js';

/** How Desktop runs the `appling` command line: a program with the arguments before the command, and extra environment. */
export interface ApplingCli {
    command: string;
    args: string[];
    env: Record<string, string>;
}

/**
 * The repo's own `appling` (`node_modules/.bin/appling`, the version its project pins) when it has one, else the CLI
 * that ships with Desktop, run by Electron as Node.
 */
export function applingCli(repo: string, options: { platform: Platform, exists(path: string): boolean, node: string, cli: string }): ApplingCli {
    const own = join(repo, 'node_modules', '.bin', options.platform === 'win32' ? 'appling.cmd' : 'appling');
    if (options.exists(own)) return { command: own, args: [], env: {} };
    return { command: options.node, args: [options.cli], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** The input `appling release` asks for. */
export const RELEASE_INPUT: TaskInput = { id: 'appling.releaseVersion', type: 'promptString', description: 'The version to release, such as 1.2.0', allowEmpty: false };

/** The built in tasks: `appling check`, `appling generate` and `appling release <version>` over the repo. */
export function builtinTasks(cli: ApplingCli): TaskFile {
    const task = (name: string, detail: string, extra: string[] = [], group?: TaskDefinition['group']): TaskDefinition => ({
        label: `appling: ${name}`, source: 'appling', type: 'process', command: cli.command, args: [...cli.args, name, ...extra],
        env: cli.env, dependsOn: [], dependsOrder: 'parallel', isBackground: false, runOn: 'default',
        presentation: { reveal: 'always', close: false }, detail, hide: false, ...group ? { group } : {}
    });
    return {
        tasks: [
            task('check', 'Validate the models of the repo', [], { kind: 'test', isDefault: false }),
            task('generate', 'Generate code for every target of appling.config.json', [], { kind: 'build', isDefault: false }),
            task('release', 'Write a graph snapshot of the models as a release', [`\${input:${RELEASE_INPUT.id}}`])
        ],
        inputs: [RELEASE_INPUT],
        problems: []
    };
}

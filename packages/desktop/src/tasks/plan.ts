/**
 * The order tasks run in: a task's `dependsOn` run first, all at once (`parallel`, the default) or one after the
 * other (`sequence`), then the task itself. Pure; the runner passes in how one task runs.
 */

export interface PlanNode {
    label: string;
    order: 'parallel' | 'sequence';
    deps: PlanNode[];
}

interface Dependent {
    label: string;
    dependsOn: string[];
    dependsOrder: 'parallel' | 'sequence';
}

/** The dependency tree of a task. Throws for an unknown label or a cycle, naming the path. */
export function dependencyPlan(label: string, tasks: readonly Dependent[]): PlanNode {
    const byLabel = new Map(tasks.map(task => [task.label, task]));
    const visit = (current: string, path: string[]): PlanNode => {
        const task = byLabel.get(current);
        if (!task) throw new Error(path.length ? `Task "${path.at(-1)}" depends on "${current}", which does not exist.` : `There is no task "${current}".`);
        if (path.includes(current)) throw new Error(`The tasks depend on each other in a cycle: ${[...path.slice(path.indexOf(current)), current].join(' → ')}.`);
        return { label: current, order: task.dependsOrder, deps: task.dependsOn.map(dep => visit(dep, [...path, current])) };
    };
    return visit(label, []);
}

/** Every label of a plan, each once, dependencies before their dependents. */
export function planLabels(plan: PlanNode): string[] {
    const labels: string[] = [];
    const walk = (node: PlanNode) => {
        node.deps.forEach(walk);
        if (!labels.includes(node.label)) labels.push(node.label);
    };
    walk(plan);
    return labels;
}

/** How one task of a plan ended for its dependents: done (exited cleanly, or a background task got ready) or not. */
export type StepResult = { ok: true } | { ok: false, reason: string };

/**
 * Runs a plan: each task after its dependencies, `run` once per label even where several tasks depend on it. A task
 * whose dependency failed does not run; `skipped` hears about it. Resolves with the root's result.
 */
export async function executePlan(
    plan: PlanNode,
    run: (label: string) => Promise<StepResult>,
    skipped: (label: string, reason: string) => void = () => undefined
): Promise<StepResult> {
    const started = new Map<string, Promise<StepResult>>();
    const node = (current: PlanNode): Promise<StepResult> => {
        let promise = started.get(current.label);
        if (promise) return promise;
        promise = (async () => {
            let failed: StepResult | undefined;
            if (current.order === 'sequence') {
                for (const dep of current.deps) {
                    const result = await node(dep);
                    if (!result.ok) {
                        failed = result;
                        break;
                    }
                }
            } else {
                const results = await Promise.all(current.deps.map(node));
                failed = results.find(result => !result.ok);
            }
            if (failed && !failed.ok) {
                const reason = failed.reason.startsWith('A dependency failed') ? failed.reason : `A dependency failed: ${failed.reason}`;
                skipped(current.label, reason);
                return { ok: false, reason } as const;
            }
            return run(current.label);
        })();
        started.set(current.label, promise);
        return promise;
    };
    return node(plan);
}

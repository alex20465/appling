export type Layer = 'cross' | 'domain' | 'behavior' | 'application' | 'interface' | 'experience';

export const LAYER_OF: Record<string, Layer> = {
    Module: 'cross', Role: 'cross', Actor: 'cross', Tenant: 'cross', Migration: 'cross',
    Enum: 'domain', ValueType: 'domain', Entity: 'domain',
    Event: 'behavior', Action: 'behavior', Machine: 'behavior', Job: 'behavior',
    Query: 'application', Projection: 'application', External: 'application', UseCase: 'application',
    Interface: 'interface',
    Page: 'experience', Navigation: 'experience', Flow: 'experience', Messages: 'experience',
    // Outside the five layers: a scenario may reference anything it can see.
    Scenario: 'cross'
};

/** Whether a top level declaration of kind `from` may reference one of kind `to`: the reference DAG of `docs/concept.md` section 2.3. */
export function mayReference(from: string, to: string): boolean {
    if (from === 'Scenario') return true;
    const source = LAYER_OF[from];
    const target = LAYER_OF[to];
    if (source === target || target === 'cross') return true;
    switch (source) {
        case 'cross': return target === 'domain';
        case 'domain': return false;
        case 'behavior': return target === 'domain';
        case 'application': return target === 'domain' || target === 'behavior';
        case 'interface':
        case 'experience':
            return target === 'application' || to === 'Action' || to === 'Enum' || to === 'ValueType';
        default: return false;
    }
}

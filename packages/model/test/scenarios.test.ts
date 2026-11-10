import { expect, test } from 'vitest';
import type { Model } from '@appling/lang';
import { buildWorkspace, constructs, examples } from '../../lang/test/workspace.js';
import { buildGraph, checkScenarios, coveredByScenarios, runScenarios, scenarioCall, Simulator } from '../src/index.js';

const NOW = new Date('2026-10-23T10:00:00Z');

async function workspace(sources: Record<string, string>) {
    const { documents, services } = await buildWorkspace(sources);
    const models = documents.map(d => d.parseResult.value as Model);
    return { models, services, graph: buildGraph(models, services) };
}

const SHOP = `module shop {
  role Clerk { actor.active }
  actor human Staff roles Clerk { active: Bool }
  actor system Robot
  enum Status { draft placed cancelled }
  entity Customer { name: String }
  entity Order {
    customer: Customer
    status: Status state default draft
    lines: Int
    note: String?
    invariant "lines not negative" { lines >= 0 }
    policy { actor.is(Clerk) }
  }
  event Placed { order: Order }
  action Place on Order {
    requires { lines > 0 } else Empty
    effect { emit Placed { order = this } }
    errors Empty
  }
  action Annotate on Order {
    input { text: String }
    effect { set note = text }
  }
  machine Flow on Order.status {
    transition draft -> placed via Place
  }
  usecase Checkout (order: Order) {
    step Place(order) on Empty do Annotate(order, "empty")
    step Annotate(order, "done")
  }
  interface rest Api { POST "/orders/{id}/place" -> Place }
  SCENARIOS
}`;

async function run(scenarios: string) {
    const { graph } = await workspace({ 'shop.appling': SHOP.replace('SCENARIOS', scenarios) });
    return runScenarios(graph, NOW);
}

const GIVEN = 'given { ada = create Customer { name = "Ada" } order = create Order { customer = ada, lines = 2 } }';

test('the scenarios of the examples and the coverage fixture pass', async () => {
    for (const sources of [examples(), constructs()]) {
        const { models, services, graph } = await workspace(sources);
        expect(runScenarios(graph, NOW).length).toBeGreaterThan(0);
        expect(checkScenarios(models, services, NOW)).toEqual([]);
    }
});

test('a scenario runs the action on its given rows and checks the result', async () => {
    const [result] = await run(`scenario S { ${GIVEN} as Staff { active = true } when Place(order) then { order.status == placed  emitted Placed { order = order } } }`);
    expect(result).toMatchObject({ passed: true, outcome: 'done', failures: [] });
    expect(result.rows.order.status).toBe('placed');
});

test('a role stands for an actor holding it, with the given actor fields', async () => {
    expect((await run(`scenario S { ${GIVEN} as Staff { active = true } when Place(order) then { order.status == placed } }`))[0].passed).toBe(true);
    expect((await run(`scenario S { ${GIVEN} as Staff { active = false } when Place(order) then refused }`))[0].passed).toBe(true);
    expect((await run(`scenario S { ${GIVEN} as Robot when Place(order) then refused }`))[0].passed).toBe(true);
});

test('a scenario that ends otherwise than its then fails, with the reason', async () => {
    const failures = async (scenario: string) => (await run(scenario))[0].failures;
    expect(await failures(`scenario S { ${GIVEN} when Place(order) then { order.status == cancelled  emitted Placed { order = ada } } }`))
        .toEqual(['order.status == cancelled is false.', 'Placed was emitted, but not with order as given.']);
    expect(await failures(`scenario S { ${GIVEN} as Robot when Place(order) then { true } }`)).toEqual(['Place was refused: no policy allows the actor.']);
    expect(await failures(`scenario S { ${GIVEN} when Place(order) then fails Empty }`)).toEqual(['Place did not fail.']);
    expect(await failures(`scenario S { ${GIVEN} as Staff { active = true } when Place(order) then refused }`)).toEqual(['Place was not refused.']);
    expect(await failures(`scenario S { given { ada = create Customer { } order = create Order { customer = ada, lines = 0 } } when Place(order) then { true } }`))
        .toEqual(['Place failed: Empty.']);
    expect(await failures(`scenario S { given { order = create Order { lines = 0 - 1 } } when Annotate(order, "x") then { order.note == "x" } }`))
        .toEqual(['order breaks the invariant "lines not negative" of Order.', 'Annotate breaks the invariant "lines not negative".']);
});

test('what the scenario does not give makes it fail instead of guessing', async () => {
    const [result] = await run('scenario S { given { order = create Order { } } as Staff when Place(order) then { order.status == placed } }');
    expect(result.failures).toEqual(['Whether the actor may call Place depends on data the scenario does not give.', 'Place: requires { lines > 0 } else Empty depends on data the scenario does not give.']);
    expect((await run('scenario S { given { order = create Order { lines = 1 } } when Place(order) then { order.customer.name == "Ada" } }'))[0].failures)
        .toEqual(['order.customer.name == "Ada" depends on data the scenario does not give.']);
});

test('fails without an error accepts any error, such as a missing transition', async () => {
    expect((await run('scenario S { given { order = create Order { lines = 1, status = placed } } when Place(order) then fails }'))[0])
        .toMatchObject({ passed: true, outcome: 'error', reasons: ['no transition of Flow from placed'] });
    expect((await run('scenario S { given { order = create Order { lines = 0 } } when Place(order) then fails }'))[0]).toMatchObject({ passed: true, errors: ['shop.Place.Empty'] });
});

test('a use case runs its steps in order and its handlers on their errors', async () => {
    const [handled] = await run('scenario S { given { order = create Order { lines = 0 } } when Checkout(order) then { order.note == "done"  order.status == draft } }');
    expect(handled.passed).toBe(true);
    const [placed] = await run('scenario S { given { order = create Order { lines = 3 } } when Checkout(order) then { order.status == placed  emitted Placed } }');
    expect(placed.passed).toBe(true);
});

test('a scenario covers the action it calls and the transitions of that action', async () => {
    const { graph } = await workspace({ 'shop.appling': SHOP.replace('SCENARIOS', 'scenario S { given { order = create Order { lines = 0 } } when Place(order) then fails Empty }') });
    const [result] = runScenarios(graph, NOW);
    expect(result.passed).toBe(true);
    const node = graph.nodes.find(n => n.kind === 'Scenario')!;
    expect(scenarioCall(node)).toMatchObject({ target: 'shop.Place' });
    expect([...coveredByScenarios(graph)]).toEqual(['shop.Place', 'shop.Flow.transition[draft->placed]']);
    expect(new Simulator(graph, NOW).scenario('shop.S').failures).toEqual([]);
});

test('check reports every failure at the scenario name', async () => {
    const { models, services } = await workspace({ 'shop.appling': SHOP.replace('SCENARIOS', `scenario Broken { ${GIVEN} when Place(order) then fails Empty }`) });
    expect(checkScenarios(models, services, NOW)).toMatchObject([{
        scenario: 'shop.Broken', uri: 'file:///shop.appling', message: 'Scenario Broken fails: Place did not fail.',
        range: { start: { line: 32, character: 11 } }
    }]);
});

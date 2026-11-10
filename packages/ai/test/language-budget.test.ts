import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

// The language reference is what an assistant reads to know Appling (`language_reference`); a new construct has to
// fit into it, or replace something (docs/concept.md section 8). About 25k tokens.
const BUDGET = 100_000;

test('the language reference stays within its size budget', () => {
    const folder = join(import.meta.dirname, '../../../docs/language');
    const size = readdirSync(folder).filter(f => f.endsWith('.md')).reduce((sum, f) => sum + readFileSync(join(folder, f), 'utf8').length, 0);
    expect(size, `docs/language has ${size} characters, the budget is ${BUDGET}`).toBeLessThanOrEqual(BUDGET);
});

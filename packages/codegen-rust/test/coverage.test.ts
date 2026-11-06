import { join } from 'node:path';
import { test } from 'vitest';
import { expectCoverage } from '../../codegen/test/coverage.js';
import extension from '../src/index.js';

test('coverage over the all-constructs fixture does not drop', () => expectCoverage(extension, join(import.meta.dirname, 'coverage.json')));

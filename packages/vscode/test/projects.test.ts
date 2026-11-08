import { expect, test } from 'vitest';
import { projectOf, projectRoots } from '../src/projects.js';

test('a folder with appling.config.json is a project; so is a workspace folder with models outside one', () => {
    const folders = ['/w/shop', '/w/notes', '/w/crm'];
    const configs = ['/w/shop/apps/billing/appling.config.json'];
    const models = ['/w/shop/apps/billing/billing.appling', '/w/shop/model/sales.appling', '/w/crm/crm.appling'];
    expect(projectRoots(folders, configs, models)).toEqual(['/w/crm', '/w/shop', '/w/shop/apps/billing']);
    expect(projectRoots(['/w/shop'], ['/w/shop/appling.config.json'], ['/w/shop/sales.appling'])).toEqual(['/w/shop']);
    expect(projectOf(['/w/shop', '/w/shop/apps/billing'], '/w/shop/apps/billing/billing.appling')).toBe('/w/shop/apps/billing');
    expect(projectOf(['/w/shop'], '/w/shopping/x.appling')).toBeUndefined();
});

import {
    createDefaultCoreModule, createDefaultSharedCoreModule, inject,
    type DefaultSharedCoreModuleContext, type LangiumCoreServices, type LangiumSharedCoreServices,
    type Module, type PartialLangiumCoreServices
} from 'langium';
import { ApplingGeneratedModule, ApplingGeneratedSharedModule } from './generated/module.js';
import { ApplingScopeComputation, ApplingScopeProvider } from './appling-scope.js';
import { registerValidationChecks } from './appling-validator.js';

export type ApplingServices = LangiumCoreServices;

export const ApplingModule: Module<ApplingServices, PartialLangiumCoreServices> = {
    references: {
        ScopeComputation: services => new ApplingScopeComputation(services),
        ScopeProvider: services => new ApplingScopeProvider(services)
    }
};

export function createApplingServices(context: DefaultSharedCoreModuleContext): {
    shared: LangiumSharedCoreServices,
    Appling: ApplingServices
} {
    const shared = inject(createDefaultSharedCoreModule(context), ApplingGeneratedSharedModule);
    const Appling = inject(createDefaultCoreModule({ shared }), ApplingGeneratedModule, ApplingModule);
    shared.ServiceRegistry.register(Appling);
    registerValidationChecks(Appling);
    return { shared, Appling };
}

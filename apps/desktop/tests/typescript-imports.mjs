// Resolve Vite's extensionless relative TypeScript imports in Node-only store tests.
import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.') || /\.[a-z]+$/i.test(specifier)) throw error;
      return nextResolve(specifier + '.ts', context);
    }
  },
});

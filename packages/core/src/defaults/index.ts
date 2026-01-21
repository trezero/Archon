/**
 * Defaults module - provides access to bundled default commands and workflows
 *
 * This module is the bridge between the bundled defaults (embedded in binary)
 * and the runtime loaders that need to access them.
 */

export { BUNDLED_COMMANDS, BUNDLED_WORKFLOWS, isBinaryBuild } from './bundled-defaults';

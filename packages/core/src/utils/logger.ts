/**
 * Re-export shim — actual implementation in @archon/paths
 * This file maintains backward compatibility for:
 * - Relative imports within @archon/core (e.g., import { createLogger } from '../utils/logger')
 * - Sub-path imports (e.g., import { createLogger } from '@archon/core/utils/logger')
 */
export { createLogger, setLogLevel, getLogLevel, rootLogger } from '@archon/paths';
export type { Logger } from '@archon/paths';

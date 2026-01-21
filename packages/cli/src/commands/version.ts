/**
 * Version command - displays version info
 *
 * For compiled binaries, version is embedded via bundled-version.ts
 * For development (Bun), reads from package.json
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isBinaryBuild } from '@archon/core/defaults/bundled-defaults';
import { getDatabaseType } from '@archon/core';
import { BUNDLED_VERSION } from './bundled-version';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  name: string;
  version: string;
}

/**
 * Get version for development mode (reads package.json)
 */
async function getDevVersion(): Promise<{ name: string; version: string }> {
  const pkgPath = join(SCRIPT_DIR, '../../package.json');

  let content: string;
  try {
    content = await readFile(pkgPath, 'utf-8');
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') {
      throw new Error('Failed to read version: package.json not found (bad installation?)');
    } else if (err.code === 'EACCES') {
      throw new Error('Failed to read version: permission denied reading package.json');
    }
    throw new Error(`Failed to read version: ${err.message}`);
  }

  let pkg: PackageJson;
  try {
    pkg = JSON.parse(content) as PackageJson;
  } catch (_error) {
    throw new Error('Failed to read version: package.json is malformed');
  }

  return { name: pkg.name, version: pkg.version };
}

export async function versionCommand(): Promise<void> {
  let version: string;

  if (isBinaryBuild()) {
    // Compiled binary: use embedded version
    version = BUNDLED_VERSION;
  } else {
    // Development mode: read from package.json
    const devInfo = await getDevVersion();
    version = devInfo.version;
  }

  const platform = process.platform;
  const arch = process.arch;
  const dbType = getDatabaseType();
  const buildType = isBinaryBuild() ? 'binary' : 'source (bun)';

  console.log(`Archon CLI v${version}`);
  console.log(`  Platform: ${platform}-${arch}`);
  console.log(`  Build: ${buildType}`);
  console.log(`  Database: ${dbType}`);
}

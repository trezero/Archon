/**
 * Version command - displays version info
 */
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

interface PackageJson {
  name: string;
  version: string;
}

export async function versionCommand(): Promise<void> {
  // Read package.json from cli package
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

  console.log(`${pkg.name} v${pkg.version}`);
  console.log(`Bun v${Bun.version}`);
}

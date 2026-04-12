#!/usr/bin/env node

import { spawnSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const isWindows = process.platform === 'win32';
const psCmd = isWindows ? 'powershell.exe' : 'pwsh';

function runStep(label, command, args = []) {
  console.log(`\n== ${label} ==`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runNpmStep(label, npmArgs) {
  if (isWindows) {
    runStep(label, 'cmd.exe', ['/d', '/s', '/c', `npm ${npmArgs.join(' ')}`]);
    return;
  }
  runStep(label, 'npm', npmArgs);
}

runNpmStep('Unit Tests', ['test']);
runNpmStep('Build', ['run', 'build']);
runStep('Integrity Verification', psCmd, ['-ExecutionPolicy', 'Bypass', '-File', 'verify-integrity.ps1']);
runNpmStep('Dependency Audit', ['audit', '--audit-level=high']);

console.log('\nSecurity check completed successfully.');

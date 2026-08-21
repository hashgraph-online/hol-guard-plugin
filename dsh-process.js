import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const UNSAFE_ENVIRONMENT_NAMES = new Set([
  '__PYVENV_LAUNCHER__',
  'BASH_ENV',
  'CDPATH',
  'DYLD_FRAMEWORK_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ENV',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CEILING_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
  'GIT_CONFIG_SYSTEM',
  'GIT_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_WORK_TREE',
  'HOL_GUARD_COMMAND',
  'LD_AUDIT',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONBREAKPOINT',
  'PYTHONHOME',
  'PYTHONINSPECT',
  'PYTHONPATH',
  'PYTHONPROFILEIMPORTTIME',
  'PYTHONSTARTUP',
  'PYTHONUSERBASE',
  'PYTHONWARNINGS',
  'SHELLOPTS',
  'VIRTUAL_ENV',
]);
const UNSAFE_ENVIRONMENT_PREFIXES = [
  'DYLD_',
  'GIT_CONFIG_KEY_',
  'GIT_CONFIG_VALUE_',
];

function normalizedEnvironmentName(name) {
  return String(name).toUpperCase();
}

function unsafeEnvironmentName(name) {
  const normalized = normalizedEnvironmentName(name);
  if (UNSAFE_ENVIRONMENT_NAMES.has(normalized)) return true;
  return UNSAFE_ENVIRONMENT_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function withinPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function environmentValue(environment, name) {
  const normalized = normalizedEnvironmentName(name);
  for (const [key, value] of Object.entries(environment)) {
    if (normalizedEnvironmentName(key) === normalized) return value;
  }
  return undefined;
}

function setEnvironmentValue(environment, name, value) {
  const normalized = normalizedEnvironmentName(name);
  for (const key of Object.keys(environment)) {
    if (normalizedEnvironmentName(key) === normalized) delete environment[key];
  }
  environment[name] = value;
}

function sanitizedPath(rawPath, workspace) {
  const safeEntries = [];
  const seen = new Set();
  for (const entry of String(rawPath ?? '').split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    const resolved = path.resolve(entry);
    if (withinPath(workspace, resolved)) continue;
    const identity = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(identity)) continue;
    seen.add(identity);
    safeEntries.push(resolved);
  }
  return safeEntries.join(path.delimiter);
}

export function buildGuardEnvironment(overrides = {}, workspace = process.cwd()) {
  const environment = { ...process.env, ...overrides };
  for (const key of Object.keys(environment)) {
    if (unsafeEnvironmentName(key)) delete environment[key];
  }
  const cleanPath = sanitizedPath(environmentValue(environment, 'PATH'), workspace);
  setEnvironmentValue(environment, 'PATH', cleanPath);
  setEnvironmentValue(environment, 'PYTHONDONTWRITEBYTECODE', '1');
  setEnvironmentValue(environment, 'PYTHONNOUSERSITE', '1');
  setEnvironmentValue(environment, 'PYTHONSAFEPATH', '1');
  return environment;
}

function commandSpec(config, sourceEnvironment) {
  const configured = config.command;
  if (Array.isArray(configured)) {
    if (configured.length === 0 || !configured.every((part) => typeof part === 'string' && part.length > 0)) {
      throw new Error('HOL Guard command arrays must contain a non-empty executable followed by string arguments');
    }
    return { requestedExecutable: configured[0], prefixArgs: configured.slice(1) };
  }
  if (typeof configured === 'string' && configured.trim()) {
    return { requestedExecutable: configured.trim(), prefixArgs: [] };
  }
  const fromEnvironment = environmentValue(sourceEnvironment, 'HOL_GUARD_COMMAND');
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim()) {
    return { requestedExecutable: fromEnvironment.trim(), prefixArgs: [] };
  }
  return { requestedExecutable: 'hol-guard', prefixArgs: [] };
}

function executableExtensions(environment, requestedExecutable) {
  if (process.platform !== 'win32' || path.extname(requestedExecutable)) return [''];
  const configured = environmentValue(environment, 'PATHEXT');
  const extensions = typeof configured === 'string' && configured.trim()
    ? configured.split(';')
    : ['.COM', '.EXE', '.BAT', '.CMD'];
  return extensions
    .map((extension) => extension.trim())
    .filter(Boolean);
}

function verifiedExecutable(candidate, workspace) {
  const resolved = realpathSync(candidate);
  if (withinPath(workspace, resolved)) {
    throw new Error(`HOL Guard executable resolves inside the active workspace: ${resolved}`);
  }
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error(`HOL Guard executable is not a regular file: ${resolved}`);
  accessSync(resolved, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
  return resolved;
}

function resolveFromPath(requestedExecutable, environment, workspace) {
  const rawPath = environmentValue(environment, 'PATH');
  for (const directory of String(rawPath ?? '').split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of executableExtensions(environment, requestedExecutable)) {
      const candidate = path.join(directory, `${requestedExecutable}${extension}`);
      try {
        return verifiedExecutable(candidate, workspace);
      } catch {
        // Continue through the sanitized absolute PATH. A workspace-local,
        // missing, non-file, or non-executable candidate is never selected.
      }
    }
  }
  throw new Error(`HOL Guard executable "${requestedExecutable}" was not found on the sanitized absolute PATH`);
}

function resolveExecutable(requestedExecutable, environment, workspace) {
  if (path.isAbsolute(requestedExecutable)) {
    return verifiedExecutable(requestedExecutable, workspace);
  }
  if (requestedExecutable.includes('/') || requestedExecutable.includes('\\')) {
    throw new Error('HOL Guard command paths must be absolute; relative command paths are not trusted');
  }
  return resolveFromPath(requestedExecutable, environment, workspace);
}

export function prepareGuardProcess(config = {}, workspace = process.cwd()) {
  const sourceEnvironment = { ...process.env, ...(config.env ?? {}) };
  const { requestedExecutable, prefixArgs } = commandSpec(config, sourceEnvironment);
  const environment = buildGuardEnvironment(config.env ?? {}, workspace);
  const executable = typeof config.runner === 'function'
    ? requestedExecutable
    : resolveExecutable(requestedExecutable, environment, workspace);
  return { executable, prefixArgs, environment };
}

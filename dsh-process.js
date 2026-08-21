import {
  accessSync,
  constants as fsConstants,
  realpathSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const SAFE_SCALAR_ENVIRONMENT = Object.freeze([
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
]);
const SAFE_PLATFORM_ENVIRONMENT = Object.freeze([
  'APPDATA',
  'COMSPEC',
  'LOCALAPPDATA',
  'PATHEXT',
  'PROGRAMDATA',
  'SYSTEMROOT',
  'WINDIR',
]);
const SAFE_OPTIONAL_DIRECTORY_ENVIRONMENT = Object.freeze([
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
  'XDG_STATE_HOME',
]);

function normalizedEnvironmentName(name) {
  return String(name).toUpperCase();
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

function withinPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertUnixOwnershipAndMode(target, stat) {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const currentUid = process.getuid();
  if (stat.uid !== currentUid && stat.uid !== 0) {
    throw new Error(`untrusted owner for ${target}`);
  }
  const writableByAnotherPrincipal = (stat.mode & 0o022) !== 0;
  const protectedStickyDirectory = stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
  if (writableByAnotherPrincipal && !protectedStickyDirectory) {
    throw new Error(`path is writable by another user or group: ${target}`);
  }
}

function assertTrustedPathChain(target) {
  if (process.platform === 'win32') return;
  let current = target;
  while (true) {
    const stat = statSync(current);
    assertUnixOwnershipAndMode(current, stat);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function verifiedDirectory(candidate, workspace, { allowTemporary = false } = {}) {
  if (!path.isAbsolute(candidate)) throw new Error(`directory path is not absolute: ${candidate}`);
  const resolved = realpathSync(candidate);
  if (withinPath(workspace, resolved)) {
    throw new Error(`directory resolves inside the active workspace: ${resolved}`);
  }
  if (!allowTemporary && withinPath(os.tmpdir(), resolved)) {
    throw new Error(`directory resolves inside the system temporary root: ${resolved}`);
  }
  const stat = statSync(resolved);
  if (!stat.isDirectory()) throw new Error(`path is not a directory: ${resolved}`);
  assertTrustedPathChain(resolved);
  return resolved;
}

function pathIdentity(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function currentRuntimeDirectory(workspace) {
  const runtimeExecutable = realpathSync(process.execPath);
  if (withinPath(workspace, runtimeExecutable)) {
    throw new Error(`the running DSH Node executable resolves inside the active workspace: ${runtimeExecutable}`);
  }
  if (withinPath(os.tmpdir(), runtimeExecutable)) {
    throw new Error(`the running DSH Node executable resolves inside the system temporary root: ${runtimeExecutable}`);
  }
  const stat = statSync(runtimeExecutable);
  if (!stat.isFile()) {
    throw new Error(`the running DSH Node executable is not a regular file: ${runtimeExecutable}`);
  }
  accessSync(runtimeExecutable, process.platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
  return path.dirname(runtimeExecutable);
}

function sanitizedPath(rawPath, workspace) {
  const safeEntries = [];
  const seen = new Set();
  for (const entry of String(rawPath ?? '').split(path.delimiter)) {
    if (!entry || !path.isAbsolute(entry)) continue;
    let resolved;
    try {
      resolved = verifiedDirectory(entry, workspace);
    } catch {
      continue;
    }
    const identity = pathIdentity(resolved);
    if (seen.has(identity)) continue;
    seen.add(identity);
    safeEntries.push(resolved);
  }
  return safeEntries;
}

function childPath(rawPath, workspace) {
  const runtimeDirectory = currentRuntimeDirectory(workspace);
  const entries = [runtimeDirectory, ...sanitizedPath(rawPath, workspace)];
  const seen = new Set();
  return entries
    .filter((entry) => {
      const identity = pathIdentity(entry);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .join(path.delimiter);
}

function systemUser(workspace) {
  let info;
  try {
    info = os.userInfo();
  } catch (error) {
    throw new Error(`could not resolve the operating-system user: ${error instanceof Error ? error.message : String(error)}`);
  }
  const home = verifiedDirectory(info.homedir, workspace);
  return { home, username: info.username };
}

function safeTemporaryDirectory(sourceEnvironment, workspace, fallback) {
  for (const name of ['TMPDIR', 'TEMP', 'TMP']) {
    const candidate = environmentValue(sourceEnvironment, name);
    if (typeof candidate !== 'string' || !candidate.trim() || !path.isAbsolute(candidate)) continue;
    try {
      return verifiedDirectory(candidate, workspace, { allowTemporary: true });
    } catch {
      continue;
    }
  }
  try {
    return verifiedDirectory(os.tmpdir(), workspace, { allowTemporary: true });
  } catch {
    return fallback;
  }
}

function copySafeScalar(source, target, name) {
  const value = environmentValue(source, name);
  if (typeof value === 'string' && value.length > 0) setEnvironmentValue(target, name, value);
}

function copySafeOptionalDirectory(source, target, name, workspace) {
  const value = environmentValue(source, name);
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value)) return;
  try {
    setEnvironmentValue(target, name, verifiedDirectory(value, workspace, { allowTemporary: true }));
  } catch {
    // Optional platform directories are omitted when they are missing,
    // workspace-controlled, or otherwise untrusted.
  }
}

export function buildGuardEnvironment(overrides = {}, workspace = process.cwd()) {
  const sourceEnvironment = { ...process.env, ...overrides };
  const environment = {};
  const user = systemUser(workspace);
  const temporaryDirectory = safeTemporaryDirectory(sourceEnvironment, workspace, user.home);
  const cleanPath = childPath(environmentValue(sourceEnvironment, 'PATH'), workspace);

  setEnvironmentValue(environment, 'PATH', cleanPath);
  setEnvironmentValue(environment, 'HOME', user.home);
  setEnvironmentValue(environment, 'USERPROFILE', user.home);
  setEnvironmentValue(environment, 'USER', user.username);
  setEnvironmentValue(environment, 'LOGNAME', user.username);
  setEnvironmentValue(environment, 'USERNAME', user.username);
  setEnvironmentValue(environment, 'TMPDIR', temporaryDirectory);
  setEnvironmentValue(environment, 'TEMP', temporaryDirectory);
  setEnvironmentValue(environment, 'TMP', temporaryDirectory);

  for (const name of SAFE_SCALAR_ENVIRONMENT) copySafeScalar(sourceEnvironment, environment, name);
  for (const name of SAFE_PLATFORM_ENVIRONMENT) {
    if (!SAFE_OPTIONAL_DIRECTORY_ENVIRONMENT.includes(name)) copySafeScalar(sourceEnvironment, environment, name);
  }
  for (const name of SAFE_OPTIONAL_DIRECTORY_ENVIRONMENT) {
    copySafeOptionalDirectory(sourceEnvironment, environment, name, workspace);
  }

  setEnvironmentValue(environment, 'NO_COLOR', '1');
  setEnvironmentValue(environment, 'TERM', 'dumb');
  setEnvironmentValue(environment, 'PYTHONDONTWRITEBYTECODE', '1');
  setEnvironmentValue(environment, 'PYTHONIOENCODING', 'utf-8');
  setEnvironmentValue(environment, 'PYTHONNOUSERSITE', '1');
  setEnvironmentValue(environment, 'PYTHONSAFEPATH', '1');
  setEnvironmentValue(environment, 'PYTHONUTF8', '1');
  setEnvironmentValue(environment, 'GIT_ATTR_NOSYSTEM', '1');
  setEnvironmentValue(environment, 'GIT_CONFIG_GLOBAL', os.devNull);
  setEnvironmentValue(environment, 'GIT_CONFIG_NOSYSTEM', '1');
  setEnvironmentValue(environment, 'GIT_OPTIONAL_LOCKS', '0');
  setEnvironmentValue(environment, 'GIT_TERMINAL_PROMPT', '0');
  return environment;
}

function commandSpec(config) {
  const configured = config.command;
  if (Array.isArray(configured)) {
    if (configured.length === 0 || !configured.every((part) => typeof part === 'string' && part.length > 0 && !part.includes('\0'))) {
      throw new Error('HOL Guard command arrays must contain a non-empty executable followed by safe string arguments');
    }
    return { requestedExecutable: configured[0], prefixArgs: configured.slice(1) };
  }
  if (typeof configured === 'string' && configured.trim() && !configured.includes('\0')) {
    return { requestedExecutable: configured.trim(), prefixArgs: [] };
  }
  if (configured !== undefined) throw new Error('HOL Guard command must be a non-empty string or string array');
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

function verifiedExecutable(candidate, workspace, { explicit = false } = {}) {
  const resolved = realpathSync(candidate);
  if (withinPath(workspace, resolved)) {
    throw new Error(`HOL Guard executable resolves inside the active workspace: ${resolved}`);
  }
  if (!explicit && withinPath(os.tmpdir(), resolved)) {
    throw new Error(`HOL Guard executable resolves inside the system temporary root: ${resolved}`);
  }
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error(`HOL Guard executable is not a regular file: ${resolved}`);
  assertTrustedPathChain(resolved);
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
        // Continue through the sanitized PATH. The running Node directory is
        // available to child shebangs but still cannot supply hol-guard unless
        // its candidate independently passes the owner/mode executable checks.
      }
    }
  }
  throw new Error(`HOL Guard executable "${requestedExecutable}" was not found on the sanitized owner-safe absolute PATH`);
}

function resolveExecutable(requestedExecutable, environment, workspace) {
  if (path.isAbsolute(requestedExecutable)) {
    return verifiedExecutable(requestedExecutable, workspace, { explicit: true });
  }
  if (requestedExecutable.includes('/') || requestedExecutable.includes('\\')) {
    throw new Error('HOL Guard command paths must be absolute; relative command paths are not trusted');
  }
  return resolveFromPath(requestedExecutable, environment, workspace);
}

export function prepareGuardHome(value, workspace = process.cwd()) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw new Error('HOL Guard home must be an absolute trusted directory when configured');
  }
  return verifiedDirectory(value, workspace);
}

export function prepareGuardProcess(config = {}, workspace = process.cwd()) {
  const environmentOverrides = typeof config.runner === 'function' ? (config.env ?? {}) : {};
  const environment = buildGuardEnvironment(environmentOverrides, workspace);
  const { requestedExecutable, prefixArgs } = commandSpec(config);
  const executable = typeof config.runner === 'function'
    ? requestedExecutable
    : resolveExecutable(requestedExecutable, environment, workspace);
  const guardHome = prepareGuardHome(config.guardHome, workspace);
  return { executable, prefixArgs, environment, guardHome };
}

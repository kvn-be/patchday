// Per-package install options. The keys are the ones UniGetUI writes into bundles, so options travel
// both ways. Only what a manager can really do is turned into arguments; everything else is ignored.
import type { Manager } from './packages.ts';
import { SAFE_VERSION } from './extra.ts';

export interface InstallOptions {
  SkipHashCheck?: boolean;
  InteractiveInstallation?: boolean;
  RunAsAdministrator?: boolean;
  PreRelease?: boolean;
  SkipMinorUpdates?: boolean;
  SkipMajorUpdates?: boolean;
  RemoveDataOnUninstall?: boolean;
  UninstallPreviousVersionsOnUpdate?: boolean;
  UninstallBeforeUpdate?: boolean;
  AbortOnPreInstallFail?: boolean;
  AbortOnPreUpdateFail?: boolean;
  AbortOnPreUninstallFail?: boolean;
  AutoUpdatePackage?: boolean;
  Architecture?: string;
  InstallationScope?: string;
  CustomInstallLocation?: string;
  Version?: string;
  PreInstallCommand?: string;
  PostInstallCommand?: string;
  PreUpdateCommand?: string;
  PostUpdateCommand?: string;
  PreUninstallCommand?: string;
  PostUninstallCommand?: string;
  SkipMinorUpdatesLevel?: string;
  CustomParameters_Install?: string[];
  CustomParameters_Update?: string[];
  CustomParameters_Uninstall?: string[];
  KillBeforeOperation?: string[];
  OverridesNextLevelOpts?: boolean;
}

export const BOOL_DEFAULTS = {
  SkipHashCheck: false, InteractiveInstallation: false, RunAsAdministrator: false, PreRelease: false,
  SkipMinorUpdates: false, SkipMajorUpdates: false, RemoveDataOnUninstall: false, UninstallPreviousVersionsOnUpdate: false,
  UninstallBeforeUpdate: false, AbortOnPreInstallFail: true, AbortOnPreUpdateFail: true, AbortOnPreUninstallFail: true,
  AutoUpdatePackage: false,
} as const;
export const STRING_KEYS = [
  'Architecture', 'InstallationScope', 'CustomInstallLocation', 'Version', 'PreInstallCommand', 'PostInstallCommand',
  'PreUpdateCommand', 'PostUpdateCommand', 'PreUninstallCommand', 'PostUninstallCommand', 'SkipMinorUpdatesLevel',
] as const;
export const LIST_KEYS = ['CustomParameters_Install', 'CustomParameters_Update', 'CustomParameters_Uninstall', 'KillBeforeOperation'] as const;
export const COMMAND_KEYS = ['PreInstallCommand', 'PostInstallCommand', 'PreUpdateCommand', 'PostUpdateCommand', 'PreUninstallCommand', 'PostUninstallCommand'] as const;
export const PARAMETER_KEYS = ['CustomParameters_Install', 'CustomParameters_Update', 'CustomParameters_Uninstall'] as const;

const MAX_TEXT = 2000;
const MAX_LIST = 32;

// Keeps known keys with the right type and sane lengths, drops defaults and everything else.
export function cleanOptions(raw: unknown): InstallOptions {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const options: InstallOptions = {};
  const out = options as Record<string, unknown>;
  for (const [key, fallback] of Object.entries(BOOL_DEFAULTS)) {
    if (typeof input[key] === 'boolean' && input[key] !== fallback) out[key] = input[key];
  }
  for (const key of STRING_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() && value.length <= MAX_TEXT && !value.includes('\0')) out[key] = value.trim();
  }
  for (const key of LIST_KEYS) {
    const value = input[key];
    if (!Array.isArray(value)) continue;
    const list = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= 500 && !item.includes('\0')).slice(0, MAX_LIST);
    if (list.length) out[key] = list;
  }
  // Old bundles had one list for all three operations.
  if (Array.isArray(input.CustomParameters) && !options.CustomParameters_Install) {
    const list = (input.CustomParameters as unknown[]).filter((item): item is string => typeof item === 'string' && item.trim().length > 0 && item.length <= 500).slice(0, MAX_LIST);
    if (list.length) options.CustomParameters_Install = options.CustomParameters_Update = options.CustomParameters_Uninstall = list;
  }
  if (options.Version && !SAFE_VERSION.test(options.Version)) delete options.Version;
  if (options.Architecture && !/^(x64|x86|arm64|arm|neutral)$/i.test(options.Architecture)) delete options.Architecture;
  if (options.InstallationScope && !/^(user|machine|global|local)$/i.test(options.InstallationScope)) delete options.InstallationScope;
  if (options.KillBeforeOperation) options.KillBeforeOperation = options.KillBeforeOperation.filter((name) => /^[\w .()+-]{1,64}$/.test(name));
  if (options.KillBeforeOperation?.length === 0) delete options.KillBeforeOperation;
  if (typeof input.OverridesNextLevelOpts === 'boolean' && input.OverridesNextLevelOpts) options.OverridesNextLevelOpts = true;
  return options;
}

export const isEmptyOptions = (options: InstallOptions) => Object.keys(options).filter((key) => key !== 'OverridesNextLevelOpts').length === 0;

export type Operation = 'install' | 'update' | 'uninstall';

export function preCommand(options: InstallOptions, operation: Operation): string | undefined {
  return operation === 'install' ? options.PreInstallCommand : operation === 'update' ? options.PreUpdateCommand : options.PreUninstallCommand;
}
export function postCommand(options: InstallOptions, operation: Operation): string | undefined {
  return operation === 'install' ? options.PostInstallCommand : operation === 'update' ? options.PostUpdateCommand : options.PostUninstallCommand;
}
export function abortOnPreFail(options: InstallOptions, operation: Operation): boolean {
  const key = operation === 'install' ? 'AbortOnPreInstallFail' : operation === 'update' ? 'AbortOnPreUpdateFail' : 'AbortOnPreUninstallFail';
  return options[key] ?? true;
}
export function customParameters(options: InstallOptions, operation: Operation): string[] {
  return (operation === 'install' ? options.CustomParameters_Install : operation === 'update' ? options.CustomParameters_Update : options.CustomParameters_Uninstall) ?? [];
}

const user = (options: InstallOptions) => /^(user|local)$/i.test(options.InstallationScope ?? '');
const machine = (options: InstallOptions) => /^(machine|global)$/i.test(options.InstallationScope ?? '');

// Security switches the user set in Settings. Without them the matching options are left out.
export interface OptionPolicy {
  allowParameters: boolean;
  allowSkipHash: boolean;
}

// Arguments to add to a manager's install, update or uninstall command, in that manager's words.
export function optionArgs(manager: Manager, operation: Operation, options: InstallOptions, policy: OptionPolicy): string[] {
  const args: string[] = [];
  const version = operation === 'install' ? options.Version : undefined;
  const skipHash = options.SkipHashCheck && policy.allowSkipHash && operation !== 'uninstall';
  switch (manager) {
    case 'winget':
      if (version) args.push('--version', version);
      if (user(options)) args.push('--scope', 'user');
      if (machine(options)) args.push('--scope', 'machine');
      if (options.Architecture && operation !== 'uninstall') args.push('--architecture', options.Architecture.toLowerCase());
      if (options.CustomInstallLocation && operation === 'install') args.push('--location', options.CustomInstallLocation);
      if (skipHash) args.push('--ignore-security-hash');
      if (options.RemoveDataOnUninstall && operation === 'uninstall') args.push('--purge');
      break;
    case 'choco':
      if (version) args.push('--version', version);
      if (/^x86$/i.test(options.Architecture ?? '')) args.push('--x86');
      if (skipHash) args.push('--ignore-checksums');
      if (options.PreRelease && operation !== 'uninstall') args.push('--prerelease');
      break;
    case 'scoop':
      if (machine(options)) args.push('--global');
      if (options.Architecture && operation === 'install') {
        const arch = { x64: '64bit', x86: '32bit', arm64: 'arm64' }[options.Architecture.toLowerCase()];
        if (arch) args.push('--arch', arch);
      }
      if (skipHash) args.push('--skip-hash-check');
      if (options.RemoveDataOnUninstall && operation === 'uninstall') args.push('--purge');
      break;
    case 'brew':
      if (options.RemoveDataOnUninstall && operation === 'uninstall') args.push('--zap');
      break;
    case 'pip':
      if (user(options) && operation !== 'uninstall') args.push('--user');
      if (options.PreRelease && operation !== 'uninstall') args.push('--pre');
      break;
    case 'dotnet':
      if (version) args.push('--version', version);
      if (options.PreRelease && operation !== 'uninstall') args.push('--prerelease');
      break;
    case 'cargo':
      if (version) args.push('--version', version);
      break;
    case 'pwsh': case 'winps': case 'npm': case 'vcpkg':
      break;
  }
  if (policy.allowParameters) args.push(...customParameters(options, operation));
  return args;
}

// Updates the user asked to skip by size: SkipMajorUpdates hides majors, SkipMinorUpdates hides
// changes below the chosen position (2 minor, 3 patch, 4 the rest; default 3, as in UniGetUI).
export function skipsUpdate(options: InstallOptions, installed: string, available: string): boolean {
  const parts = (version: string) => version.replace(/^v/i, '').split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const a = parts(installed);
  const b = parts(available);
  const firstChange = [0, 1, 2, 3].find((index) => (a[index] ?? 0) !== (b[index] ?? 0) && !(Number.isNaN(a[index]) && Number.isNaN(b[index])));
  if (firstChange === undefined) return false;
  if (options.SkipMajorUpdates && firstChange === 0) return true;
  if (options.SkipMinorUpdates) {
    const level = Number.parseInt(options.SkipMinorUpdatesLevel ?? '3', 10);
    const from = level >= 2 && level <= 4 ? level - 1 : 2;
    if (firstChange >= from) return true;
  }
  return false;
}

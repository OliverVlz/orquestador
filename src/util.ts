/**
 * Utilidades sin estado: argumentos, ejecución de procesos, texto y resolución de binarios.
 * Ningún módulo de aquí conoce Azure, git ni los motores.
 */
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';

export class CliError extends Error {}

export function fail(message: string): never {
  throw new CliError(message);
}

export function log(line = ''): void {
  process.stdout.write(`${line}\n`);
}

/* ------------------------------------------------------------------ dry-run */

let dryRun = false;
export const setDryRun = (value: boolean): void => {
  dryRun = value;
};
export const isDryRun = (): boolean => dryRun;

/* --------------------------------------------------------------- argumentos */

export type Flags = Record<string, string | boolean>;

const VALUE_FLAGS = new Set([
  'text',
  'limit',
  'qa',
  'repo',
  'rol',
  'motor',
  'proyecto',
  'title',
  'file',
  'probar',
  'talla',
  'implementer',
  'reviewer',
  'nota',
  'sobre',
  'publicar',
  'puerto',
]);

export function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (VALUE_FLAGS.has(key) && next !== undefined) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

export const flagText = (flags: Flags, key: string): string =>
  typeof flags[key] === 'string' ? (flags[key] as string).trim() : '';

/* ---------------------------------------------------------------- procesos */

export type Binario = { command: string; prefix: string[] };
export type ExecResult = { status: number; stdout: string; stderr: string };

type ExecOptions = {
  cwd?: string;
  input?: string;
  allowFail?: boolean;
  name?: string;
  shown?: string[];
  env?: NodeJS.ProcessEnv;
};

export function exec(bin: Binario | string, args: string[], options: ExecOptions = {}): ExecResult {
  const target = typeof bin === 'string' ? { command: bin, prefix: [] } : bin;
  const name = options.name ?? target.command;
  const spawnOptions: SpawnSyncOptions = {
    cwd: options.cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    input: options.input,
    env: options.env ?? process.env,
    windowsHide: true,
  };
  const result = spawnSync(target.command, [...target.prefix, ...args], spawnOptions);
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    const hint = code === 'ENOENT' ? ` (¿está instalado "${name}"?)` : '';
    fail(`No se pudo ejecutar ${name}${hint}: ${result.error.message}`);
  }
  const out: ExecResult = {
    status: result.status ?? 1,
    stdout: String(result.stdout ?? ''),
    stderr: String(result.stderr ?? ''),
  };
  if (out.status !== 0 && !options.allowFail) {
    const detail = (out.stderr || out.stdout).trim().split('\n').slice(-6).join('\n');
    const shown = (options.shown ?? args).slice(0, 3).join(' ');
    fail(`${name} ${shown} terminó con código ${out.status}\n${detail}`);
  }
  return out;
}

/**
 * Cómo ejecutar un programa del PATH sin shell. En Windows los CLI de npm son `.cmd` que Node no
 * ejecuta sin cmd.exe (y por cmd.exe habría que escapar cada argumento), así que se lee el `.cmd`
 * y se llama directo a lo que envuelve: un `.exe` o un `.js` que se corre con este mismo Node.
 */
export function resolverBinario(nombre: string, env: NodeJS.ProcessEnv = process.env): Binario | null {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  if (process.platform !== 'win32') {
    for (const dir of dirs) {
      const path = join(dir, nombre);
      if (existsSync(path)) return { command: path, prefix: [] };
    }
    return null;
  }
  for (const dir of dirs) {
    const exe = join(dir, `${nombre}.exe`);
    if (existsSync(exe)) return { command: exe, prefix: [] };
    const cmd = join(dir, `${nombre}.cmd`);
    if (existsSync(cmd)) {
      const shim = desdeShimNpm(cmd);
      if (shim) return shim;
    }
  }
  return null;
}

/** Lo que envuelve un `.cmd` de npm: `"%dp0%\node_modules\...\cli.js"` o `...\cli.exe`. */
export function desdeShimNpm(cmdPath: string): Binario | null {
  const text = readFileSync(cmdPath, 'utf8');
  const targets = [...text.matchAll(/"%dp0%\\([^"]+?\.(js|cjs|mjs|exe))"/gi)].filter(
    (m) => !/^node\.exe$/i.test(m[1]),
  );
  const last = targets.at(-1);
  if (!last) return null;
  const target = join(dirname(cmdPath), last[1]);
  if (!existsSync(target)) return null;
  return last[2].toLowerCase() === 'exe'
    ? { command: target, prefix: [] }
    : { command: process.execPath, prefix: [target] };
}

/** El entorno para un proceso hijo, sin las variables que delatan una sesión de Claude Code. */
export function entornoLimpio(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_CODE_')) delete env[key];
  }
  return env;
}

/* ------------------------------------------------------------------- texto */

export function htmlToText(html: unknown = ''): string {
  return String(html ?? '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<img[^>]*src="([^"]+)"[^>]*>/gi, '[imagen: $1]')
    .replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '$2 ($1)')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<\/(p|div|h[1-6]|tr|li|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function textToHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
}

export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

export function splitTags(value: unknown): string[] {
  return String(value ?? '')
    .split(';')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

export const hasTag = (tags: string[], wanted: string): boolean =>
  tags.some((tag) => tag.toLowerCase() === wanted.toLowerCase());

/** El cuerpo de una sección `## Título` de un markdown, o '' si no está. */
export function readSection(path: string, heading: string): string {
  if (!existsSync(path)) return '';
  const lines = readFileSync(path, 'utf8').split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${heading}\\s*$`, 'i').test(l.trim()));
  if (start === -1) return '';
  const end = lines.findIndex((l, i) => i > start && /^##?\s/.test(l));
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join('\n')
    .trim();
}

export const day = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

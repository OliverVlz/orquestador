/**
 * Git: la carpeta de cada ticket (worktrees/<grupo>/<id>) y la rama de pruebas (worktrees/<grupo>/qa)
 * son worktrees del checkout principal, que se queda limpio en su rama base. <grupo> es el
 * "worktrees" del repo en orquestador.json (backend, frontend…).
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { WORKSPACE, type RepoCfg } from './config.ts';
import { exec, isDryRun, log, slugify } from './util.ts';

export function git(args: string[], cwd: string, options: { allowFail?: boolean } = {}) {
  return exec('git', args, { cwd, ...options, name: 'git' });
}

export function gitWrite(args: string[], cwd: string, description: string): void {
  if (isDryRun()) {
    log(`[dry-run] ${description}`);
    return;
  }
  git(args, cwd);
}

export const WORKTREES = 'worktrees';

/** La carpeta con el esquema anterior, hermana del repo: <repo>--84, <repo>--qa. */
export const rutaAntigua = (workspace: string, repo: Pick<RepoCfg, 'dir'>, suffix: string | number): string =>
  join(workspace, `${repo.dir}--${suffix}`);

/**
 * Dónde vive la carpeta de un ticket (o la de pruebas): worktrees/backend/84, worktrees/backend/qa.
 * Si todavía existe con el esquema anterior (<repo>--84) y no se ha migrado, se sigue usando esa.
 */
export function rutaWorktree(
  workspace: string,
  repo: Pick<RepoCfg, 'dir' | 'worktrees'>,
  suffix: string | number,
  existe: (path: string) => boolean = existsSync,
): string {
  const nueva = join(workspace, WORKTREES, repo.worktrees, String(suffix));
  const antigua = rutaAntigua(workspace, repo, suffix);
  return !existe(nueva) && existe(antigua) ? antigua : nueva;
}

export const worktreePath = (repo: RepoCfg, suffix: string | number): string => rutaWorktree(WORKSPACE, repo, suffix);

/** Ruta corta para mostrar: worktrees/backend/84. */
export const rutaCorta = (dir: string, workspace = WORKSPACE): string => relative(workspace, dir).replaceAll('\\', '/') || '.';

/** Las carpetas de worktrees del repo que existen hoy, con el esquema nuevo y con el anterior. */
export function carpetasDe(repo: Pick<RepoCfg, 'dir' | 'worktrees'>, workspace = WORKSPACE): string[] {
  const grupo = join(workspace, WORKTREES, repo.worktrees);
  const nuevas = existsSync(grupo) ? readdirSync(grupo).map((d) => join(grupo, d)) : [];
  const antiguas = readdirSync(workspace)
    .filter((d) => d.startsWith(`${repo.dir}--`))
    .map((d) => join(workspace, d));
  return [...nuevas, ...antiguas].filter((d) => statSync(d).isDirectory());
}

/** Las carpetas con el esquema anterior que git reconoce como worktrees del repo, y a dónde van. */
export function worktreesAntiguos(repo: RepoCfg, workspace = WORKSPACE): Array<{ origen: string; destino: string }> {
  if (!existsSync(repo.path)) return [];
  const registrados = new Set(
    git(['worktree', 'list', '--porcelain'], repo.path)
      .stdout.split('\n')
      .filter((l) => l.startsWith('worktree '))
      .map((l) => resolve(l.slice('worktree '.length).trim()).toLowerCase()),
  );
  const prefijo = `${repo.dir}--`;
  return readdirSync(workspace)
    .filter((d) => d.startsWith(prefijo) && registrados.has(resolve(workspace, d).toLowerCase()))
    .map((d) => ({ origen: join(workspace, d), destino: join(workspace, WORKTREES, repo.worktrees, d.slice(prefijo.length)) }));
}

/** Pasa una carpeta del esquema anterior a worktrees/<grupo>/<id>. Devuelve el motivo si no se pudo, o null. */
export function moverWorktree(repo: RepoCfg, origen: string, destino: string): string | null {
  if (existsSync(destino)) return `ya existe ${destino}`;
  if (isDryRun()) return null;
  mkdirSync(dirname(destino), { recursive: true });
  const r = git(['worktree', 'move', origen, destino], repo.path, { allowFail: true });
  return r.status === 0 ? null : (r.stderr || r.stdout).trim().split('\n').pop() || 'git worktree move falló';
}

export const branchFor = (type: string, id: number, title: string): string =>
  `${type === 'Bug' ? 'fix' : 'feat'}/${id}-${slugify(title) || 'ticket'}`;

/** La rama local del ticket si ya existe (feat/<id>-… o fix/<id>-…). */
export function ticketBranch(repo: RepoCfg, id: number): string {
  return (git(['branch', '--list', `*/${id}-*`], repo.path).stdout.split('\n')[0] ?? '')
    .replace(/^[*+]?\s*/, '')
    .trim();
}

/** Desde dónde nacen las ramas: origin/<base> actualizado si hay remoto. */
export function baseRef(repo: RepoCfg, base: string): string {
  git(['fetch', 'origin', base], repo.path, { allowFail: true });
  const remote = git(['rev-parse', '--verify', '--quiet', `origin/${base}`], repo.path, { allowFail: true });
  return remote.status === 0 ? `origin/${base}` : base;
}

export const dirtyIn = (dir: string): boolean => git(['status', '--porcelain'], dir).stdout.trim() !== '';

export const shortHead = (dir: string, ref = 'HEAD'): string => git(['rev-parse', '--short', ref], dir).stdout.trim();

export function isAncestor(dir: string, ancestor: string, of: string): boolean {
  return git(['merge-base', '--is-ancestor', ancestor, of], dir, { allowFail: true }).status === 0;
}

/** Commits de la carpeta que no están en la base: [hash, asunto]. */
export function commitsAhead(dir: string, base: string): Array<[string, string]> {
  return git(['log', '--format=%h%x09%s', `${base}..HEAD`], dir)
    .stdout.split('\n')
    .filter(Boolean)
    .map((line) => line.split('\t') as [string, string]);
}

export const lastCommitTime = (dir: string, ref = 'HEAD'): number =>
  Number(git(['log', '-1', '--format=%ct', ref], dir).stdout.trim());

/** Copia los archivos locales sin versionar que la app necesita para arrancar. */
export function prepareWorktree(repo: RepoCfg, dir: string): void {
  if (isDryRun()) return;
  for (const name of ['.env', '.env.local']) {
    const source = join(repo.path, name);
    if (existsSync(source) && !existsSync(join(dir, name))) copyFileSync(source, join(dir, name));
  }
}

/** Crea (o reutiliza) la carpeta del ticket. Devuelve la rama y si la carpeta es nueva. */
export function ensureTicketWorktree(repo: RepoCfg, id: number, branch: string, base: string) {
  const dir = worktreePath(repo, id);
  if (existsSync(dir)) return { dir, branch: ticketBranch(repo, id) || branch, created: false };
  const existing = ticketBranch(repo, id);
  const args = existing
    ? ['worktree', 'add', dir, existing]
    : ['worktree', 'add', '-b', branch, dir, baseRef(repo, base)];
  gitWrite(args, repo.path, `crear ${dir} en la rama ${existing || branch}`);
  prepareWorktree(repo, dir);
  return { dir, branch: existing || branch, created: true };
}

/**
 * La rama de pruebas vive en su carpeta (worktrees/<grupo>/qa) para levantar ahí la app con varios tickets
 * juntos. Nunca se sube: lo que funciona sube con el PR de cada ticket.
 */
export function ensureQaWorktree(repo: RepoCfg, qaBranch: string, base: string): string {
  const dir = worktreePath(repo, 'qa');
  if (existsSync(dir)) return dir;
  const exists = git(['rev-parse', '--verify', '--quiet', `refs/heads/${qaBranch}`], repo.path, { allowFail: true }).status === 0;
  const args = exists ? ['worktree', 'add', dir, qaBranch] : ['worktree', 'add', '-b', qaBranch, dir, baseRef(repo, base)];
  gitWrite(args, repo.path, `crear ${dir} en la rama ${qaBranch}`);
  // rerere recuerda cómo se resolvió un conflicto y lo repite igual en el PR del ticket.
  gitWrite(['config', 'rerere.enabled', 'true'], repo.path, 'activar git rerere');
  prepareWorktree(repo, dir);
  return dir;
}

/** Las ramas locales del repo con su commit corto, en una sola llamada (las worktrees comparten las refs). */
export function ramasLocales(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of git(['for-each-ref', '--format=%(refname:short)%09%(objectname:short)', 'refs/heads'], dir).stdout.split('\n')) {
    const [branch, hash] = line.split('\t');
    if (branch && hash) out.set(branch, hash);
  }
  return out;
}

/** Las ramas locales ya contenidas en `commit` (equivale a `isAncestor(rama, commit)` para todas a la vez). */
export function ramasContenidasEn(dir: string, commit: string): Set<string> {
  const salida = git(['for-each-ref', '--merged', commit, '--format=%(refname:short)', 'refs/heads'], dir).stdout;
  return new Set(salida.split('\n').filter(Boolean));
}

/** Tickets mezclados en la rama de pruebas que todavía no están en la base. */
export function ticketsInQa(repo: RepoCfg, qaDir: string, base: string): Array<{ id: number; branch: string }> {
  const subjects = git(['log', '--merges', '--first-parent', '--format=%s', `${base}..HEAD`], qaDir)
    .stdout.split('\n')
    .filter(Boolean);
  if (subjects.length === 0) return [];
  const ramas = ramasLocales(repo.path);
  const enBase = ramasContenidasEn(repo.path, base);
  const seen = new Map<number, string>();
  for (const subject of subjects) {
    // «Merge branch 'feat/<id>-…'» de git, o un mensaje propio que nombra el ticket («mezclar #<id> …»), como el
    // que deja un worker al resolver un conflicto a mano.
    const porId = Number(/#(\d+)\b/.exec(subject)?.[1]);
    const branch =
      /Merge branch '([^']+)'/.exec(subject)?.[1] ??
      (Number.isInteger(porId) ? [...ramas.keys()].find((r) => new RegExp(`/${porId}-`).test(r)) : undefined);
    const id = Number(/\/(\d+)-/.exec(branch ?? '')?.[1]);
    if (!branch || !Number.isInteger(id) || seen.has(id)) continue;
    if (ramas.has(branch) && !enBase.has(branch)) seen.set(id, branch);
  }
  return [...seen.entries()].reverse().map(([id, branch]) => ({ id, branch }));
}

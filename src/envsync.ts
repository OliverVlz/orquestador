/**
 * Los `.env` reales del workspace, sin mostrar nunca un valor.
 *
 * Cada repo tiene su `.env` en el checkout principal y una copia en cada worktree (`worktrees/<grupo>/qa`, `worktrees/<grupo>/<id>`):
 * `start` la copia al crear la carpeta y luego se separan. `env --sync` las junta en una sola:
 *
 * 1. Plantilla: el `.env.example` más completo entre las copias (normalmente el de la rama de pruebas, que ya tiene lo
 *    de los tickets mezclados); se sigue su orden y sus comentarios.
 * 2. Valores: por cada variable, el valor no vacío; si dos copias difieren, gana el archivo modificado más
 *    recientemente (es donde la persona escribió). Sin valor: el del ejemplo. Los secretos locales que el
 *    proyecto lista en `envGenerar` se generan al azar si están vacíos.
 * 3. El resultado se escribe en el checkout y en todas las copias. Antes se respalda cada archivo fuera del
 *    workspace (carpeta temporal del sistema), porque los respaldos tienen secretos.
 *
 * Solo se imprimen nombres de variables y conteos.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProyectoCfg, RepoCfg } from './config.ts';
import { carpetasDe, rutaCorta } from './git.ts';
import { isDryRun, log } from './util.ts';

const LINEA = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;
const vacio = (v: string | undefined) => v === undefined || v.trim() === '' || /^(["'])\1$/.test(v.trim());

function leer(path: string): Map<string, string> {
  const vals = new Map<string, string>();
  if (!existsSync(path)) return vals;
  for (const l of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = l.match(LINEA);
    if (m) vals.set(m[1], m[2]);
  }
  return vals;
}

/** El checkout del repo y sus worktrees que tienen `.env` o `.env.example`. */
export function copiasDe(repo: RepoCfg): string[] {
  return [repo.path, ...carpetasDe(repo)].filter((d) => existsSync(join(d, '.env')) || existsSync(join(d, '.env.example')));
}

export type ResumenSync = {
  repo: string;
  copias: number;
  plantilla: string;
  variables: number;
  delEjemplo: string[];
  generadas: string[];
  vacias: string[];
  distintas: string[];
  extra: string[];
  respaldo: string;
};

export function sincronizarEnv(p: ProyectoCfg, repo: RepoCfg, generar: string[] = []): ResumenSync {
  const copias = copiasDe(repo);
  const ejemplos = copias.filter((d) => existsSync(join(d, '.env.example')));
  // La plantilla: el ejemplo con más variables (a igualdad, el más reciente).
  const plantilla = ejemplos
    .map((d) => ({ d, n: leer(join(d, '.env.example')).size, t: statSync(join(d, '.env.example')).mtimeMs }))
    .sort((a, b) => b.n - a.n || b.t - a.t)[0]?.d;
  if (!plantilla) throw new Error(`Ninguna copia de ${repo.dir} tiene .env.example.`);
  const ejemplo = leer(join(plantilla, '.env.example'));
  // Variables que solo traen los .env.example de otras ramas (tickets aún no mezclados): van al final, con su
  // comentario y su valor por defecto.
  const deOtrasRamas: string[] = [];
  for (const d of ejemplos) {
    if (d === plantilla) continue;
    const lineas = readFileSync(join(d, '.env.example'), 'utf8').split(/\r?\n/);
    lineas.forEach((l, i) => {
      const m = l.match(LINEA);
      if (!m || ejemplo.has(m[1])) return;
      let j = i;
      while (j > 0 && /^\s*#/.test(lineas[j - 1])) j -= 1;
      deOtrasRamas.push(...lineas.slice(j, i), `${m[1]}=${m[2]}`);
      ejemplo.set(m[1], m[2]);
    });
  }

  const envs = copias
    .filter((d) => existsSync(join(d, '.env')))
    .map((d) => ({ d, vals: leer(join(d, '.env')), t: statSync(join(d, '.env')).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  const claves = new Set([...ejemplo.keys(), ...envs.flatMap((e) => [...e.vals.keys()])]);
  const final = new Map<string, string>();
  const res: ResumenSync = {
    repo: repo.dir, copias: copias.length, plantilla: rutaCorta(plantilla), variables: 0,
    delEjemplo: [], generadas: [], vacias: [], distintas: [], extra: [], respaldo: '',
  };
  for (const k of claves) {
    const con = envs.filter((e) => !vacio(e.vals.get(k)));
    if (new Set(con.map((e) => e.vals.get(k))).size > 1) res.distintas.push(k);
    if (con.length) final.set(k, con[0].vals.get(k)!);
    else if (!vacio(ejemplo.get(k))) { final.set(k, ejemplo.get(k)!); res.delEjemplo.push(k); }
    else if (generar.includes(k)) { final.set(k, randomBytes(32).toString('hex')); res.generadas.push(k); }
    else { final.set(k, ''); res.vacias.push(k); }
  }

  const usadas = new Set<string>();
  const base = readFileSync(join(plantilla, '.env.example'), 'utf8').split(/\r?\n/);
  if (deOtrasRamas.length) base.push('', '# --- De ramas de tickets aún no mezcladas en esta plantilla ---', ...deOtrasRamas);
  const lineas = base.map((l) => {
    const m = l.match(LINEA);
    if (!m) return l;
    if (usadas.has(m[1])) return `# (repetida en .env.example) ${m[1]}`;
    usadas.add(m[1]);
    return `${m[1]}=${final.get(m[1]) ?? ''}`;
  });
  res.extra = [...claves].filter((k) => !usadas.has(k));
  if (res.extra.length) lineas.push('', '# --- Solo en tu .env (no están en .env.example) ---', ...res.extra.map((k) => `${k}=${final.get(k)}`));
  res.variables = claves.size;

  res.respaldo = join(tmpdir(), 'orq-env-respaldo', `${repo.dir}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  if (!isDryRun()) {
    mkdirSync(res.respaldo, { recursive: true });
    const texto = lineas.join('\n');
    for (const d of copias) {
      const f = join(d, '.env');
      if (existsSync(f)) copyFileSync(f, join(res.respaldo, `${rutaCorta(d).replaceAll('/', '--')}.env`));
      writeFileSync(f, texto);
    }
  }
  return res;
}

export function imprimirResumen(r: ResumenSync): void {
  const lista = (xs: string[]) => (xs.length ? xs.join(', ') : '—');
  log(`${r.repo}: ${r.copias} copia(s) del .env iguales · ${r.variables} variables · plantilla: ${r.plantilla}/.env.example`);
  log(`  Del ejemplo (valor por defecto): ${lista(r.delEjemplo)}`);
  log(`  Generadas al azar: ${lista(r.generadas)}`);
  log(`  Vacías (las llenas tú): ${lista(r.vacias)}`);
  if (r.distintas.length) log(`  Tenían valores distintos entre copias (ganó el archivo más reciente): ${lista(r.distintas)}`);
  if (r.extra.length) log(`  Solo en tu .env, no en el ejemplo: ${lista(r.extra)}`);
  if (!isDryRun()) log(`  Respaldo (fuera del workspace, tiene secretos): ${r.respaldo}`);
}

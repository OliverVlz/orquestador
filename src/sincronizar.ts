/**
 * Sincronizar la rama de un ticket con su base antes de cada vuelta.
 *
 * Por qué: la causa más cara de vueltas era que la rama quedaba atrás de `develop` y chocaba (openapi.json, barriles,
 * app.module). El reviewer lo veía al final, y para cuando el implementer lo corregía `develop` ya había avanzado.
 * Aquí el orquestador lo resuelve solo cuando es mecánico (fusión limpia o archivos generados que se regeneran) y,
 * si no lo es, lo entrega ya diagnosticado para que el implementer no gaste una vuelta en descubrirlo.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoCfg } from './config.ts';
import { dirtyIn, git, isAncestor } from './git.ts';
import { isDryRun, readSection } from './util.ts';

export type Sincronia = {
  estado: 'al-dia' | 'fusionado' | 'regenerado' | 'conflicto' | 'sucio' | 'omitido';
  /** Archivos en conflicto (solo en `conflicto`) o regenerados (en `regenerado`). */
  archivos: string[];
  detalle: string;
};

const conflictos = (dir: string): string[] =>
  git(['diff', '--name-only', '--diff-filter=U'], dir, { allowFail: true })
    .stdout.split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

const abortar = (dir: string) => git(['merge', '--abort'], dir, { allowFail: true });

/**
 * Trae `base` a la rama del ticket. No toca nada si hay cambios sin confirmar, si la base es una rama local
 * (ticket apilado) o si es un ensayo (`--dry-run`). Nunca deja un merge a medias.
 */
export function sincronizarConBase(repo: Pick<RepoCfg, 'generados' | 'regenerar'>, dir: string, base: string, env: Record<string, string> = {}): Sincronia {
  const vacio = (estado: Sincronia['estado'], detalle: string): Sincronia => ({ estado, archivos: [], detalle });
  if (isDryRun()) return vacio('omitido', 'ensayo (--dry-run)');
  if (!base.startsWith('origin/')) return vacio('omitido', 'ticket apilado: la base es la rama de otro ticket');
  if (dirtyIn(dir)) return vacio('sucio', 'la carpeta tiene cambios sin confirmar');
  if (isAncestor(dir, base, 'HEAD')) return vacio('al-dia', `ya incluye ${base}`);

  const merge = git(['merge', '--no-edit', base], dir, { allowFail: true });
  if (merge.status === 0) return vacio('fusionado', `se fusionó ${base} sin conflictos`);

  const choques = conflictos(dir);
  const generados = new Set(repo.generados ?? []);
  const soloGenerados = choques.length > 0 && choques.every((f) => generados.has(f));
  if (!soloGenerados || !repo.regenerar) {
    abortar(dir);
    return { estado: 'conflicto', archivos: choques, detalle: `conflicto al fusionar ${base}` };
  }

  // Solo chocaron archivos generados: se toma la versión de la base y se regeneran con el script del repo (determinista).
  for (const f of choques) writeFileSync(join(dir, f), git(['show', `${base}:${f}`], dir).stdout);
  const gen = spawnSync(repo.regenerar, { cwd: dir, shell: true, stdio: 'inherit', windowsHide: true, env: { ...process.env, ...env } });
  if (gen.status !== 0) {
    abortar(dir);
    return { estado: 'conflicto', archivos: choques, detalle: `no se pudo regenerar (${repo.regenerar}) tras fusionar ${base}` };
  }
  git(['add', ...choques], dir);
  if (conflictos(dir).length > 0) {
    abortar(dir);
    return { estado: 'conflicto', archivos: choques, detalle: 'quedaron conflictos tras regenerar' };
  }
  git(['commit', '--no-edit'], dir);
  return { estado: 'regenerado', archivos: choques, detalle: `se fusionó ${base} y se regeneraron ${choques.join(', ')}` };
}

/** Texto para el implementer cuando la sincronización no se pudo resolver sola. */
export function textoConflicto(base: string, s: Sincronia): string {
  return [
    `La rama no mezcla con \`${base}\` y el orquestador no pudo resolverlo solo (${s.detalle}).`,
    s.archivos.length ? `Archivos en conflicto: ${s.archivos.map((f) => `\`${f}\``).join(', ')}.` : '',
    `Haz \`git fetch origin\`, \`git merge ${base}\` y resuélvelo **primero**, antes de cualquier otro cambio (sigue las reglas de conflictos en archivos generados). Conserva lo que ya hay en la base: si tu rama duplica algo que otro ticket ya metió, reutiliza lo de la base.`,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Chequeos mecánicos antes de gastar un reviewer: no necesitan juicio, solo un diff y un informe.
 * Devuelve los bloqueantes (vacío si puede pasar al reviewer).
 */
export function revisionMecanica(dir: string, informeImpl: string): string[] {
  const bloqueantes: string[] = [];
  if (dirtyIn(dir)) bloqueantes.push(`\`${dir}\` — hay cambios sin confirmar o un merge a medias. Confírmalos con \`git add\` + \`git commit\` (o descártalos si no son tuyos).`);
  if (!readSection(informeImpl, 'Cómo probarlo'))
    bloqueantes.push(`\`${informeImpl}\` — falta la sección «## Cómo probarlo» (dónde, antes, pasos y qué debe pasar por cada criterio). Escríbela y verifica cada afirmación contra el código.`);
  return bloqueantes;
}

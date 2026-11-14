/**
 * La validación funcional que hace la IA en la rama de pruebas (rol `validador`, roles/validador.md).
 * Cada ticket y repo deja progress/tickets/<id>/<repo>/validacion-ia.md y sus capturas en capturas/.
 * Aquí se lee para la guía, el tablero y el panel; las capturas las sirve el panel.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RepoCfg } from './config.ts';
import { repoWorkDir } from './tickets.ts';

export const RESULTADOS_IA = ['PASÓ', 'FALLÓ', 'PARCIAL', 'NO SE PUDO PROBAR'] as const;
export type ResultadoIa = (typeof RESULTADOS_IA)[number];
export type CriterioIa = { marca: '✔' | '✘' | '–'; texto: string };
export type CapturaIa = { archivo: string; descripcion: string };
export type ValidacionIa = {
  resultado: ResultadoIa;
  fecha: string;
  qa: string;
  criterios: CriterioIa[];
  hallazgos: string;
  capturas: CapturaIa[];
};

/** Un nombre de captura que se puede servir: sin rutas, solo imágenes. */
export const CAPTURA_VALIDA = /^[\w.-]+\.(png|jpe?g|webp)$/i;

export const validacionPath = (id: number, repo: RepoCfg): string => join(repoWorkDir(id, repo), 'validacion-ia.md');
export const capturasDir = (id: number, repo: RepoCfg): string => join(repoWorkDir(id, repo), 'capturas');

/** Lee el informe del validador; null si no hay o no trae un RESULTADO reconocible. */
export function parseValidacion(texto: string, capturasEnDisco: string[]): ValidacionIa | null {
  const campo = (nombre: string) => new RegExp(`^${nombre}:\\s*(.+)$`, 'mi').exec(texto)?.[1]?.trim() ?? '';
  const crudo = campo('RESULTADO').toUpperCase().replace('PASO', 'PASÓ').replace('FALLO', 'FALLÓ');
  const resultado = RESULTADOS_IA.find((r) => crudo.startsWith(r));
  if (!resultado) return null;
  const seccion = (titulo: string) => {
    const m = new RegExp(`^##\\s+${titulo}\\s*$([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mi').exec(texto);
    return (m?.[1] ?? '').trim();
  };
  const criterios = seccion('Criterios')
    .split(/\r?\n/)
    .map((l) => /^\s*[-*]\s*\[([^\]]*)\]\s*(.+)$/.exec(l))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => {
      const s = m[1].trim();
      const marca: CriterioIa['marca'] = /✔|✓|x|ok/i.test(s) ? '✔' : /✘|✗|fail|no/i.test(s) ? '✘' : '–';
      return { marca, texto: m[2].trim() };
    });
  const descritas = new Map<string, string>();
  for (const l of seccion('Capturas').split(/\r?\n/)) {
    const m = /^\s*[-*]\s*`?([\w.-]+\.(?:png|jpe?g|webp))`?\s*(?:[—–:-]\s*(.*))?$/i.exec(l);
    if (m) descritas.set(m[1], (m[2] ?? '').trim());
  }
  // Solo las que existen en disco: una captura citada que no se guardó no se puede mostrar.
  const capturas = capturasEnDisco
    .filter((a) => CAPTURA_VALIDA.test(a))
    .sort()
    .map((archivo) => ({ archivo, descripcion: descritas.get(archivo) ?? '' }));
  return { resultado, fecha: campo('FECHA'), qa: campo('QA'), criterios, hallazgos: seccion('Hallazgos'), capturas };
}

export function leerValidacion(id: number, repo: RepoCfg): ValidacionIa | null {
  const path = validacionPath(id, repo);
  if (!existsSync(path)) return null;
  const dir = capturasDir(id, repo);
  const enDisco = existsSync(dir) ? readdirSync(dir).filter((a) => CAPTURA_VALIDA.test(a)) : [];
  return parseValidacion(readFileSync(path, 'utf8'), enDisco);
}

/** «PASÓ · 5 ✔ 1 ✘ 0 –» para la guía en texto. */
export function resumenValidacion(v: ValidacionIa): string {
  const n = (m: CriterioIa['marca']) => v.criterios.filter((c) => c.marca === m).length;
  return `${v.resultado} · ${n('✔')} ✔ ${n('✘')} ✘ ${n('–')} –${v.fecha ? ` · ${v.fecha.slice(0, 16).replace('T', ' ')}` : ''}`;
}

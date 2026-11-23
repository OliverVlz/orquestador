/**
 * Los roles de los workers: el prompt sale de roles/<rol>.md con sus {{marcadores}} y el resultado
 * se lee del informe que el worker deja en disco, con un formato fijo que no depende del motor.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ORQ_DIR, type Rol } from './config.ts';
import { fail, readSection } from './util.ts';

export function renderRol(rol: Rol, vars: Record<string, string>, orqDir = ORQ_DIR): string {
  const path = join(orqDir, 'roles', `${rol}.md`);
  if (!existsSync(path)) fail(`Falta la plantilla del rol: ${path}`);
  const template = readFileSync(path, 'utf8');
  const missing = [...new Set([...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]))].filter((key) => vars[key] === undefined);
  if (missing.length > 0) fail(`Plantilla ${rol}: marcadores sin valor: ${missing.join(', ')}`);
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key: string) => vars[key]);
}

export type InformeImpl = {
  estado: 'LISTO' | 'BLOQUEADO';
  tipo: 'informacion' | 'dependencia' | 'negocio' | 'permiso' | 'ruta' | null;
  pregunta: string | null;
  resumen: string;
};

export type Dictamen = { dictamen: 'APROBADO' | 'CAMBIOS'; bloqueantes: string; resumen: string };

const field = (text: string, name: string): string | null =>
  new RegExp(`^\\s*${name}:\\s*(.+)$`, 'mi').exec(text)?.[1]?.trim() ?? null;

/** El informe del implementer, o null si no existe, es anterior a `desde` o no sigue el formato. */
export function leerInformeImpl(path: string, desde = 0): InformeImpl | null {
  if (!existsSync(path) || statSync(path).mtimeMs < desde) return null;
  const text = readFileSync(path, 'utf8');
  const estado = field(text, 'ESTADO')?.toUpperCase().match(/^(LISTO|BLOQUEADO)/)?.[1];
  if (!estado) return null;
  const tipo = field(text, 'TIPO_BLOQUEO')?.toLowerCase().match(/^(informacion|información|dependencia|negocio|permiso|ruta)/)?.[1];
  return {
    estado: estado as InformeImpl['estado'],
    tipo: tipo ? ((tipo === 'información' ? 'informacion' : tipo) as InformeImpl['tipo']) : null,
    pregunta: field(text, 'PREGUNTA'),
    resumen: readSection(path, 'Resumen'),
  };
}

/** El dictamen del reviewer, o null si no existe, es anterior a `desde` o no sigue el formato. */
export function leerDictamen(path: string, desde = 0): Dictamen | null {
  if (!existsSync(path) || statSync(path).mtimeMs < desde) return null;
  const text = readFileSync(path, 'utf8');
  const dictamen = field(text, 'DICTAMEN')?.toUpperCase().match(/^(APROBADO|CAMBIOS)/)?.[1];
  if (!dictamen) return null;
  return {
    dictamen: dictamen as Dictamen['dictamen'],
    bloqueantes: readSection(path, 'Bloqueantes'),
    resumen: (field(text, 'VERIFICACIÓN') ?? field(text, 'VERIFICACION') ?? '').slice(0, 300),
  };
}

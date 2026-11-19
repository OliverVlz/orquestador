/**
 * Perfiles prearmados de distribución de motores por proveedor y rol.
 * Permite configurar `motores` en `orquestador.json` y dejar constancia en `progress/motores.md`
 * sin editar el JSON a mano al iniciar un workspace o cambiar de estrategia.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORQ_DIR, PROGRESS, ROLES, TALLAS, parseSpec, type Config, type Rol } from './config.ts';
import { binarioDe, sesionIniciada } from './motores/correr.ts';
import { MOTORES } from './motores/registro.ts';
import { fail } from './util.ts';

export type CadenasRol = Record<string, string[]>;
export type BloqueMotores = Record<Rol, CadenasRol>;

export type Perfil = {
  nombre: string;
  descripcion: string;
  motores: BloqueMotores;
};

const CLAUDE_IMPL: CadenasRol = {
  XS: ['claude:sonnet:low'],
  S: ['claude:sonnet:medium'],
  M: ['claude:opus:medium'],
  L: ['claude:opus:high'],
  XL: ['claude:opus:xhigh'],
  '*': ['claude:opus:medium'],
};

const CLAUDE_REV: CadenasRol = {
  XS: ['claude:sonnet:medium'],
  S: ['claude:sonnet:high'],
  M: ['claude:opus:medium'],
  L: ['claude:opus:medium'],
  XL: ['claude:opus:high'],
  '*': ['claude:opus:high'],
};

const CODEX_IMPL: CadenasRol = {
  XS: ['codex:gpt-6-luna:low'],
  S: ['codex:gpt-6-luna:medium'],
  M: ['codex:gpt-6-sol:medium'],
  L: ['codex:gpt-6-sol:high'],
  XL: ['codex:gpt-6-sol:xhigh'],
  '*': ['codex:gpt-6-sol:medium'],
};

const CODEX_REV: CadenasRol = {
  XS: ['codex:gpt-6-luna:high'],
  S: ['codex:gpt-6-sol:medium'],
  M: ['codex:gpt-6-sol:medium'],
  L: ['codex:gpt-6-sol:medium'],
  XL: ['codex:gpt-6-sol:high'],
  '*': ['codex:gpt-6-sol:high'],
};

const AGY_IMPL: CadenasRol = {
  XS: ['agy:gemini-3.8-flash-medium'],
  S: ['agy:gemini-3.8-flash-high'],
  M: ['agy:gemini-4-hydrogen-medium'],
  L: ['agy:gemini-4-argon-high'],
  XL: ['agy:gemini-4-argon-high'],
  '*': ['agy:gemini-4-hydrogen-medium'],
};

const AGY_REV: CadenasRol = {
  XS: ['agy:gemini-3.8-flash-high'],
  S: ['agy:gemini-4-hydrogen-medium'],
  M: ['agy:gemini-4-argon-medium'],
  L: ['agy:gemini-4-argon-medium'],
  XL: ['agy:gemini-4-argon-high'],
  '*': ['agy:gemini-4-argon-high'],
};

const GEMINI_CHAIN: CadenasRol = {
  XS: ['gemini:gemini-2.5-flash'],
  S: ['gemini:gemini-2.5-flash'],
  M: ['gemini:gemini-2.5-pro'],
  L: ['gemini:gemini-2.5-pro'],
  XL: ['gemini:gemini-2.5-pro'],
  '*': ['gemini:gemini-2.5-pro'],
};

const DESKTOP_IMPL: CadenasRol = Object.fromEntries(
  Object.entries(CLAUDE_IMPL).map(([t, specs]) => [t, specs.map((s) => s.replace(/^claude:/, 'desktop:'))]),
);

const DESKTOP_REV: CadenasRol = Object.fromEntries(
  Object.entries(CLAUDE_REV).map(([t, specs]) => [t, specs.map((s) => s.replace(/^claude:/, 'desktop:'))]),
);

function combinar(...bloques: CadenasRol[]): CadenasRol {
  const out: CadenasRol = {};
  for (const talla of [...TALLAS, '*']) {
    out[talla] = bloques.flatMap((b) => b[talla] ?? []);
  }
  return out;
}

export const PERFILES: Record<string, Perfil> = {
  repartido: {
    nombre: 'repartido',
    descripcion: 'Carga dividida por rol: agy implementa (respaldo codex → claude) y codex revisa (respaldo claude)',
    motores: {
      implementer: combinar(AGY_IMPL, CODEX_IMPL, CLAUDE_IMPL),
      reviewer: combinar(CODEX_REV, CLAUDE_REV),
    },
  },
  'solo-claude': {
    nombre: 'solo-claude',
    descripcion: 'Solo Claude CLI (Sonnet en XS/S, Opus en M/L/XL)',
    motores: { implementer: CLAUDE_IMPL, reviewer: CLAUDE_REV },
  },
  'solo-codex': {
    nombre: 'solo-codex',
    descripcion: 'Solo Codex CLI (gpt-6-luna en XS/S, gpt-6-sol en M/L/XL)',
    motores: { implementer: CODEX_IMPL, reviewer: CODEX_REV },
  },
  'solo-agy': {
    nombre: 'solo-agy',
    descripcion: 'Solo agy CLI (Flash 3.8 en XS/S, Gemini 4 Hydrogen/Argon en M/L/XL)',
    motores: { implementer: AGY_IMPL, reviewer: AGY_REV },
  },
  'solo-gemini': {
    nombre: 'solo-gemini',
    descripcion: 'Solo Gemini CLI (Flash en XS/S, Pro en M/L/XL)',
    motores: { implementer: GEMINI_CHAIN, reviewer: GEMINI_CHAIN },
  },
  'solo-desktop': {
    nombre: 'solo-desktop',
    descripcion: 'Solo Claude Desktop (sesiones manuales por talla)',
    motores: { implementer: DESKTOP_IMPL, reviewer: DESKTOP_REV },
  },
};

/** Motores CLI instalados y con sesión iniciada (o sin comprobación de sesión). */
export function proveedoresDisponibles(): string[] {
  return Object.values(MOTORES)
    .filter((m) => !m.manual && Boolean(binarioDe(m)) && sesionIniciada(m) !== false)
    .map((m) => m.nombre);
}

export type PerfilResuelto = {
  perfil: string;
  descripcion: string;
  motores: BloqueMotores;
  omitidos: string[];
};

/**
 * Resuelve un perfil a sus cadenas de motores, filtrando por `proveedores` (si se indican)
 * o por `disponibles` cuando el perfil es `repartido`.
 */
export function resolverPerfil(
  nombre: string,
  opts: { proveedores?: string[]; disponibles?: string[] } = {},
): PerfilResuelto {
  const perfil = PERFILES[nombre];
  if (!perfil) fail(`Perfil desconocido "${nombre}" (disponibles: ${Object.keys(PERFILES).join(', ')})`);

  let permitidos: Set<string> | null = null;
  const omitidos: string[] = [];

  if (opts.proveedores?.length) {
    for (const p of opts.proveedores) {
      if (!MOTORES[p]) fail(`Proveedor desconocido "${p}" (conocidos: ${Object.keys(MOTORES).join(', ')})`);
    }
    permitidos = new Set(opts.proveedores);
  } else if (nombre === 'repartido' && opts.disponibles) {
    permitidos = new Set(opts.disponibles);
  }

  const motores = {} as BloqueMotores;
  for (const rol of ROLES) {
    motores[rol] = {};
    for (const [talla, specs] of Object.entries(perfil.motores[rol])) {
      const filtrados = permitidos
        ? specs.filter((s) => {
            const m = parseSpec(s).motor;
            const ok = permitidos!.has(m);
            if (!ok && !omitidos.includes(m)) omitidos.push(m);
            return ok;
          })
        : [...specs];
      if (filtrados.length === 0) {
        const origen = opts.proveedores?.length
          ? `los proveedores elegidos (${opts.proveedores.join(', ')})`
          : 'los motores disponibles en esta máquina';
        fail(`El perfil "${nombre}" deja vacía la cadena ${rol} (${talla}) con ${origen}.`);
      }
      motores[rol][talla] = filtrados;
    }
  }

  return { perfil: perfil.nombre, descripcion: perfil.descripcion, motores, omitidos };
}

export function renderMotoresMd(resuelto: PerfilResuelto, nota?: string, fecha = new Date().toISOString().slice(0, 10)): string {
  const lines = [
    '# Cómo se trabaja · motores',
    '',
    `- **Fecha:** ${fecha}`,
    `- **Perfil:** \`${resuelto.perfil}\` — ${resuelto.descripcion}`,
    ...(resuelto.omitidos.length ? [`- **Omitidos (sin sesión o no elegidos):** ${resuelto.omitidos.join(', ')}`] : []),
    ...(nota ? [`- **Nota:** ${nota}`] : []),
    '',
    '| Talla | Implementer | Reviewer |',
    '|---|---|---|',
    ...[...TALLAS, '*'].map(
      (t) => `| ${t} | ${resuelto.motores.implementer[t].join(' → ')} | ${resuelto.motores.reviewer[t].join(' → ')} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

export function aplicarPerfil(
  nombre: string,
  opts: {
    proveedores?: string[];
    disponibles?: string[];
    nota?: string;
    dryRun?: boolean;
    orqDir?: string;
    progressDir?: string;
  } = {},
): PerfilResuelto {
  const disponibles = opts.disponibles ?? (nombre === 'repartido' && !opts.proveedores?.length ? proveedoresDisponibles() : undefined);
  const resuelto = resolverPerfil(nombre, { proveedores: opts.proveedores, disponibles });
  if (opts.dryRun) return resuelto;

  const orqDir = opts.orqDir ?? ORQ_DIR;
  const progressDir = opts.progressDir ?? PROGRESS;
  const cfgPath = join(orqDir, 'orquestador.json');
  if (!existsSync(cfgPath)) fail(`Falta ${cfgPath}`);
  const raw = JSON.parse(readFileSync(cfgPath, 'utf8')) as Partial<Config>;
  raw.motores = resuelto.motores;
  writeFileSync(cfgPath, `${JSON.stringify(raw, null, 2)}\n`);

  mkdirSync(progressDir, { recursive: true });
  writeFileSync(join(progressDir, 'motores.md'), renderMotoresMd(resuelto, opts.nota));
  return resuelto;
}

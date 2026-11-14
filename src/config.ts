/**
 * Configuración: orquestador.json (versionado) + local.json (personal, sin versionar) y las rutas
 * de la carpeta del workspace. Todo lo que cambia entre proyectos vive en el JSON, no en el código.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fail } from './util.ts';

export const ORQ_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const WORKSPACE = resolve(process.env.ORQ_WORKSPACE ?? join(ORQ_DIR, '..'));
export const PROGRESS = join(WORKSPACE, 'progress');
export const ORQ_REL = 'orquestador';

export const ROLES = ['implementer', 'reviewer'] as const;
export type Rol = (typeof ROLES)[number];
export const TALLAS = ['XS', 'S', 'M', 'L', 'XL'] as const;

export type RepoCfg = {
  dir: string;
  repository: string;
  etiquetas: string[];
  instalar?: string;
  verificar: string;
  levantar?: string;
  url?: string;
  /** Secretos locales que `env --sync` genera al azar si están vacíos (nunca los de proveedores externos). */
  envGenerar?: string[];
  /** Subcarpeta de `worktrees/` donde van las carpetas de sus tickets: backend, frontend… (por defecto, `dir`). */
  worktrees: string;
  /** Ruta absoluta del checkout principal. */
  path: string;
};

export type ProyectoCfg = {
  nombre: string;
  ado: { organization: string; project: string; process?: string };
  ramaBase: string;
  soloMios: boolean;
  etiquetaListo: string;
  repos: RepoCfg[];
};

export type Config = {
  ola: number;
  firma: string;
  personas: string[];
  proyectos: ProyectoCfg[];
  motores: Record<Rol, Record<string, string[]>>;
  escalarTras: Record<string, number>;
  /** Tu nombre para la rama de pruebas qa/<nombre> (local.json). */
  qa: string | null;
  /** La marca del panel: nombre, sigla del monograma y, si hay, logos propios (rutas del workspace). */
  marca: { nombre: string; sigla: string; logo?: string; logoOscuro?: string };
};

type RawConfig = Partial<Omit<Config, 'proyectos' | 'qa'>> & {
  proyectos?: Array<Partial<ProyectoCfg> & { repos?: Array<Partial<RepoCfg>> }>;
};

function readJson<T>(path: string): T {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    return fail(`${path} no es JSON válido: ${(error as Error).message}`);
  }
}

export function localPath(orqDir = ORQ_DIR): string {
  return join(orqDir, 'local.json');
}

export function readLocal(orqDir = ORQ_DIR): { qa?: string } {
  const path = localPath(orqDir);
  return existsSync(path) ? readJson<{ qa?: string }>(path) : {};
}

export function writeLocal(data: { qa?: string }, orqDir = ORQ_DIR): void {
  writeFileSync(localPath(orqDir), `${JSON.stringify({ ...readLocal(orqDir), ...data }, null, 2)}\n`);
}

/** Valida y completa el JSON crudo. Separado de la lectura para poder probarlo. */
export function parseConfig(raw: RawConfig, workspace = WORKSPACE, local: { qa?: string } = {}): Config {
  const proyectos = (raw.proyectos ?? []).map((p, index) => {
    const where = `proyectos[${index}]`;
    if (!p.nombre) fail(`orquestador.json: falta ${where}.nombre`);
    if (!p.ado?.organization || !p.ado?.project)
      fail(`orquestador.json: ${where}.ado necesita organization y project`);
    const repos = (p.repos ?? []).map((r, ri) => {
      if (!r.dir || !r.verificar)
        fail(`orquestador.json: ${where}.repos[${ri}] necesita dir y verificar`);
      return {
        ...r,
        etiquetas: r.etiquetas ?? [],
        repository: r.repository ?? r.dir,
        worktrees: r.worktrees ?? r.dir,
        path: join(workspace, r.dir),
      } as RepoCfg;
    });
    for (const r of repos)
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r.worktrees))
        fail(`orquestador.json: ${where}: "worktrees" de ${r.dir} debe ser un nombre de carpeta simple y es "${r.worktrees}"`);
    if (repos.length === 0) fail(`orquestador.json: ${where} no tiene repos`);
    return {
      ramaBase: 'main',
      soloMios: true,
      etiquetaListo: 'orq-listo',
      ...p,
      repos,
    } as ProyectoCfg;
  });
  if (proyectos.length === 0) fail('orquestador.json: no hay proyectos');
  const grupos = new Map<string, string>();
  for (const r of proyectos.flatMap((p) => p.repos)) {
    const clave = r.worktrees.toLowerCase();
    if (grupos.has(clave))
      fail(`orquestador.json: ${grupos.get(clave)} y ${r.dir} comparten "worktrees": "${r.worktrees}"; cada repo necesita su subcarpeta`);
    grupos.set(clave, r.dir);
  }
  const motores = raw.motores ?? ({} as Config['motores']);
  for (const rol of ROLES) {
    if (!motores[rol]?.['*']) fail(`orquestador.json: falta motores.${rol}["*"] (la cadena por defecto)`);
  }
  const qa = local.qa ?? null;
  if (qa !== null && !/^[a-z][a-z0-9-]*$/.test(qa)) fail(`local.json: qa debe ser un nombre en minúsculas y es "${qa}"`);
  return {
    ola: raw.ola ?? 3,
    firma: raw.firma ?? 'Orquestador',
    personas: raw.personas ?? [],
    escalarTras: { '*': 2, ...raw.escalarTras },
    proyectos,
    motores,
    qa,
    marca: { nombre: 'Orquestador', sigla: 'OR', ...raw.marca },
  };
}

export function loadConfig(orqDir = ORQ_DIR, workspace = WORKSPACE): Config {
  const path = join(orqDir, 'orquestador.json');
  if (!existsSync(path)) fail(`Falta ${path}: copia orquestador.ejemplo.json con ese nombre y pon ahí tus proyectos`);
  return parseConfig(readJson<RawConfig>(path), workspace, readLocal(orqDir));
}

export function qaBranch(cfg: Config): string {
  if (!cfg.qa) fail(`Falta tu rama de pruebas: node ${ORQ_REL}/orq.ts setup --qa <tu-nombre>`);
  return `qa/${cfg.qa}`;
}

/** qa/oliver -> Oliver */
export function personaDe(cfg: Config): string {
  const name = cfg.qa ?? 'la persona';
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** La talla del ticket según sus etiquetas (XS…XL), o '*' si no tiene. */
export function tallaDe(tags: string[]): string {
  return TALLAS.find((t) => tags.includes(t)) ?? '*';
}

/** Los repos del proyecto que corresponden a las etiquetas del ticket, en el orden del JSON. */
export function reposPorEtiquetas(p: ProyectoCfg, tags: string[]): RepoCfg[] {
  const lower = new Set(tags.map((t) => t.toLowerCase()));
  return p.repos.filter((r) => r.etiquetas.some((e) => lower.has(e.toLowerCase())));
}

export type MotorSpec = { motor: string; modelo: string; esfuerzo: string | null; texto: string };

export function parseSpec(texto: string): MotorSpec {
  const [motor, modelo, esfuerzo] = texto.split(':');
  if (!motor || !modelo) fail(`Motor "${texto}" mal escrito: usa motor:modelo[:esfuerzo]`);
  return { motor, modelo, esfuerzo: esfuerzo || null, texto };
}

/** La cadena de motores para un rol y una talla: la de la talla o la por defecto ("*"). */
export function cadena(cfg: Config, rol: Rol, talla: string): MotorSpec[] {
  const porTalla = cfg.motores[rol];
  return (porTalla[talla] ?? porTalla['*']).map(parseSpec);
}

export const escalarTras = (cfg: Config, talla: string): number =>
  cfg.escalarTras[talla] ?? cfg.escalarTras['*'] ?? 2;

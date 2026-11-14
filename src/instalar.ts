/**
 * Instala la capa del coordinador en el workspace: copia plantilla/ (AGENTS.md, CLAUDE.md y
 * .claude/) a la carpeta que contiene los repos. Lleva la huella de cada archivo en
 * .claude/orquestador.json; si alguien editó un archivo instalado, lo respalda como
 * <archivo>.antes-<fecha> antes de reemplazarlo. Nunca toca .claude/settings.local.json ni archivos
 * que no vengan de la plantilla.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { ORQ_DIR, WORKSPACE } from './config.ts';
import { fail, log, type Flags } from './util.ts';

const MANIFEST = join('.claude', 'orquestador.json');

const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

function filesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesIn(path) : [path];
  });
}

type Manifest = { files: Record<string, string>; from?: string; installedAt?: string };

function readManifest(workspace: string): Manifest {
  const path = join(workspace, MANIFEST);
  if (!existsSync(path)) return { files: {} };
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Manifest;
  } catch {
    return { files: {} };
  }
}

export type Paso = { action: 'crear' | 'actualizar' | 'respaldar y actualizar' | 'quitar' | 'respaldar y quitar'; rel: string; source?: string; target: string; sourceHash?: string };

/** Qué hay que hacer para dejar el workspace igual a la plantilla. */
export function plan(workspace = WORKSPACE, template = join(ORQ_DIR, 'plantilla')): Paso[] {
  const manifest = readManifest(workspace);
  const steps: Paso[] = [];
  const wanted = new Set<string>();
  for (const source of filesIn(template)) {
    const rel = relative(template, source).split('\\').join('/');
    wanted.add(rel);
    const target = join(workspace, rel);
    const sourceHash = hash(source);
    if (!existsSync(target)) {
      steps.push({ action: 'crear', rel, source, target, sourceHash });
      continue;
    }
    const targetHash = hash(target);
    if (targetHash === sourceHash) continue;
    const edited = manifest.files[rel] !== targetHash;
    steps.push({ action: edited ? 'respaldar y actualizar' : 'actualizar', rel, source, target, sourceHash });
  }
  for (const [rel, installedHash] of Object.entries(manifest.files)) {
    const target = join(workspace, rel);
    if (wanted.has(rel) || !existsSync(target)) continue;
    steps.push({ action: hash(target) !== installedHash ? 'respaldar y quitar' : 'quitar', rel, target });
  }
  return steps;
}

export function install(steps: Paso[], workspace = WORKSPACE, template = join(ORQ_DIR, 'plantilla')): void {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const manifest = readManifest(workspace);
  for (const step of steps) {
    if (step.action.startsWith('respaldar')) copyFileSync(step.target, `${step.target}.antes-${stamp}`);
    if (step.action.endsWith('quitar')) {
      rmSync(step.target);
      delete manifest.files[step.rel];
      continue;
    }
    mkdirSync(dirname(step.target), { recursive: true });
    copyFileSync(step.source!, step.target);
  }
  for (const source of filesIn(template)) manifest.files[relative(template, source).split('\\').join('/')] = hash(source);
  manifest.from = 'orquestador/plantilla';
  manifest.installedAt = new Date().toISOString();
  mkdirSync(join(workspace, '.claude'), { recursive: true });
  writeFileSync(join(workspace, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

export function cmdInstalar(flags: Flags): void {
  if (!existsSync(join(WORKSPACE, 'orquestador'))) fail(`${WORKSPACE} no parece el workspace (no tiene orquestador/).`);
  const steps = plan();
  for (const step of steps) log(`${step.action.padEnd(24)} ${step.rel}`);
  if (flags.check) {
    if (steps.length > 0) fail('La capa del coordinador no está al día: node orquestador/orq.ts instalar');
    log(`[OK]   Coordinador al día en ${WORKSPACE}`);
    return;
  }
  if (flags['dry-run']) return;
  install(steps);
  const backups = steps.filter((s) => s.action.startsWith('respaldar')).length;
  log(`done -> coordinador instalado en ${WORKSPACE} (${steps.length} cambio(s)${backups ? `, ${backups} respaldo(s) .antes-*` : ''})`);
}

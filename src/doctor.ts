/**
 * Diagnóstico de la máquina y del workspace, los motores disponibles, la rama de pruebas personal
 * y las variables de entorno de un repo (sin mostrar valores).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { freemem, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { az, typeRules } from './ado.ts';
import { ROLES, TALLAS, cadena, parseSpec, writeLocal, type Config } from './config.ts';
import { carpetasDe, git, moverWorktree, rutaCorta, worktreesAntiguos } from './git.ts';
import { plan } from './instalar.ts';
import { binarioDe, correrMotor, motorPorNombre } from './motores/correr.ts';
import { MOTORES } from './motores/registro.ts';
import { imprimirResumen, sincronizarEnv } from './envsync.ts';
import { proyectoPorNombre, repoPorDir } from './tickets.ts';
import { exec, fail, flagText, isDryRun, log, type Flags } from './util.ts';

/**
 * Cuántos tickets aguanta la máquina a la vez. Cada ticket en curso corre pruebas y compilación en
 * su carpeta (≈ 1,5-2 GB en el pico); las IA corren en la nube. Se reservan ~3 GB para el resto.
 */
export function capacidad(max: number, libre = freemem(), total = totalmem()) {
  const gb = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
  const cupo = Math.max(1, Math.min(max, Math.floor((gb(libre) - 3) / 2)));
  return { libreGb: gb(libre), totalGb: gb(total), cupo };
}

type Check = { level: 'OK' | 'WARN' | 'FAIL'; text: string; fix?: string };

export function cmdDoctor(cfg: Config): void {
  const checks: Check[] = [];
  const add = (level: Check['level'], text: string, fix?: string) => checks.push({ level, text, fix });

  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major > 23 || (major === 23 && minor >= 6)) add('OK', `Node ${process.versions.node}`);
  else add('FAIL', `Node ${process.versions.node}: hace falta 23.6 o superior (corre TypeScript directo)`);

  try {
    exec('git', ['--version']);
    add('OK', 'git');
  } catch {
    add('FAIL', 'git no está instalado');
  }
  let azOk = false;
  try {
    const ext = az(['extension', 'list', '--query', "[?name=='azure-devops'].name", '-o', 'tsv']).stdout.trim();
    azOk = ext === 'azure-devops';
    add(azOk ? 'OK' : 'FAIL', azOk ? 'az con la extensión azure-devops' : 'az sin la extensión azure-devops', 'az extension add --name azure-devops');
  } catch (error) {
    add('FAIL', `az no responde: ${(error as Error).message.split('\n')[0]}`, 'instala Azure CLI y corre az login');
  }

  for (const p of cfg.proyectos) {
    if (azOk) {
      try {
        typeRules(p);
        az(['boards', 'query', '--wiql', 'SELECT [System.Id] FROM WorkItems WHERE [System.Id] = 0', '--project', p.ado.project, '--organization', p.ado.organization]);
        add('OK', `${p.nombre}: acceso a ${p.ado.organization}/${p.ado.project}`);
      } catch (error) {
        add('FAIL', `${p.nombre}: sin acceso a Azure DevOps (${(error as Error).message.split('\n')[0]})`, 'az login / az devops login');
      }
    }
    for (const repo of p.repos) {
      if (!existsSync(repo.path)) {
        add('FAIL', `${p.nombre}: falta ${repo.dir}`, `clónalo en ${repo.path}`);
        continue;
      }
      const branch = git(['branch', '--show-current'], repo.path).stdout.trim();
      const dirty = git(['status', '--porcelain'], repo.path).stdout.trim() !== '';
      if (branch !== p.ramaBase || dirty)
        add('WARN', `${repo.dir}: el checkout principal debe quedar limpio en ${p.ramaBase} (está en ${branch || 'HEAD suelto'}${dirty ? ', con cambios' : ''})`);
      else add('OK', `${repo.dir}: limpio en ${p.ramaBase}`);
    }
  }

  const antiguos = cfg.proyectos.flatMap((p) => p.repos).reduce((n, repo) => n + worktreesAntiguos(repo).length, 0);
  if (antiguos > 0)
    add('WARN', `${antiguos} carpeta(s) de tickets con el esquema anterior (<repo>--<id>); siguen funcionando`, 'node orquestador/orq.ts worktrees --migrar');

  add(cfg.qa ? 'OK' : 'WARN', cfg.qa ? `Rama de pruebas qa/${cfg.qa}` : 'Falta tu rama de pruebas', 'node orquestador/orq.ts setup --qa <tu-nombre>');

  const usados = new Set(ROLES.flatMap((rol) => [...TALLAS, '*'].flatMap((t) => cadena(cfg, rol, t).map((s) => s.motor))));
  for (const nombre of usados) {
    const motor = MOTORES[nombre];
    if (!motor) add('FAIL', `Motor "${nombre}" de orquestador.json no existe (conocidos: ${Object.keys(MOTORES).join(', ')})`);
    else if (!binarioDe(motor)) add('WARN', `Motor ${nombre}: no está instalado (se salta en las cadenas)`);
    else add('OK', `Motor ${nombre}`);
  }

  const { libreGb, totalGb, cupo } = capacidad(cfg.ola);
  add(cupo < cfg.ola ? 'WARN' : 'OK', `Memoria: ${libreGb} GB libres de ${totalGb} GB → hasta ${cupo} ticket(s) a la vez`);

  const pending = plan();
  add(pending.length ? 'WARN' : 'OK', pending.length ? `Coordinador del workspace desactualizado (${pending.length} archivo(s))` : 'Coordinador del workspace al día', 'node orquestador/orq.ts instalar');

  for (const c of checks) {
    log(`${`[${c.level}]`.padEnd(6)} ${c.text}`);
    if (c.fix && c.level !== 'OK') log(`       → ${c.fix}`);
  }
  if (checks.some((c) => c.level === 'FAIL')) fail('doctor: hay fallas.');
}

/* ------------------------------------------------------------------- worktrees */

/**
 * Las carpetas de tickets de cada repo. Con --migrar pasa las del esquema anterior (<repo>--<id>, hermanas
 * del repo) a worktrees/<grupo>/<id> con `git worktree move`: conserva la rama, los cambios sin confirmar y
 * los archivos sin versionar. La que no se pueda mover (un programa la tiene abierta) se queda donde está y
 * sigue funcionando.
 */
export function cmdWorktrees(cfg: Config, flags: Flags): void {
  let movidas = 0;
  let fallidas = 0;
  for (const repo of cfg.proyectos.flatMap((p) => p.repos)) {
    const antiguos = worktreesAntiguos(repo);
    if (!flags.migrar) {
      const viejas = new Set(antiguos.map((a) => a.origen));
      const carpetas = existsSync(repo.path) ? carpetasDe(repo) : [];
      log(`${repo.dir} → worktrees/${repo.worktrees}/ · ${carpetas.length} carpeta(s)`);
      for (const dir of carpetas) log(`  ${rutaCorta(dir)}${viejas.has(dir) ? '   (esquema anterior)' : ''}`);
      fallidas += antiguos.length;
      continue;
    }
    for (const { origen, destino } of antiguos) {
      const error = moverWorktree(repo, origen, destino);
      if (error) {
        fallidas += 1;
        log(`[WARN] ${rutaCorta(origen)} se queda donde está: ${error}`);
      } else {
        movidas += 1;
        log(`${isDryRun() ? '[dry-run] ' : ''}${rutaCorta(origen)} → ${rutaCorta(destino)}`);
      }
    }
  }
  if (!flags.migrar) {
    if (fallidas > 0) log(`\n${fallidas} con el esquema anterior: node orquestador/orq.ts worktrees --migrar`);
    return;
  }
  log(`done -> ${movidas} carpeta(s) ${isDryRun() ? 'por mover' : 'movida(s)'} a worktrees/${fallidas ? `, ${fallidas} sin mover (cierra lo que las tenga abiertas y repite)` : ''}`);
}

/* --------------------------------------------------------------------- motores */

export function cmdMotores(cfg: Config, flags: Flags): void {
  for (const [nombre, motor] of Object.entries(MOTORES)) {
    const bin = binarioDe(motor);
    log(`${nombre.padEnd(8)} ${bin ? `${bin.command}${bin.prefix.length ? ` ${bin.prefix.join(' ')}` : ''}` : 'no instalado'}`);
  }
  log('');
  for (const rol of ROLES) {
    for (const [talla, specs] of Object.entries(cfg.motores[rol])) log(`${rol} ${talla.padEnd(3)} ${specs.join(' → ')}`);
  }
  const probar = flags.probar;
  if (!probar) return;
  log('');
  const specs = typeof probar === 'string' ? [parseSpec(probar)] : [];
  if (specs.length === 0) fail('Uso: motores --probar motor:modelo[:esfuerzo]');
  for (const spec of specs) probarMotor(spec.motor, spec.modelo, spec.esfuerzo);
}

/** Lanza un motor sobre un repo de juguete y comprueba que escribe un informe con el formato. */
function probarMotor(nombre: string, modelo: string, esfuerzo: string | null): void {
  const motor = motorPorNombre(nombre);
  if (motor.manual) fail(`El motor ${nombre} no se prueba solo: lo corre una sesión de Claude Desktop que abre el coordinador.`);
  const dir = mkdtempSync(join(tmpdir(), `orq-${nombre}-`));
  const repo = join(dir, 'repo');
  const work = join(dir, 'informes');
  try {
    exec('git', ['init', '-q', repo]);
    exec('git', ['-C', dir, 'init', '-q', 'informes']);
    const informe = join(work, 'impl.md');
    const promptFile = join(work, 'brief.md');
    const prompt = [
      'Es una prueba de conexión del orquestador. No toques nada más.',
      `Crea el archivo ${informe} con exactamente estas dos líneas:`,
      '',
      'ESTADO: LISTO',
      '## Resumen',
      '',
      'Luego responde solo: ESTADO: LISTO',
    ].join('\n');
    const started = Date.now();
    const final = correrMotor(motor, { cwd: repo, prompt, promptFile, modelo, esfuerzo, dirsExtra: [work] }, join(work, 'motor'), { timeoutMin: 10 });
    const ok = existsSync(informe) && /ESTADO:\s*LISTO/.test(readFileSync(informe, 'utf8'));
    const secs = Math.round((Date.now() - started) / 1000);
    if (ok) log(`[OK]   ${nombre}:${modelo} escribió su informe (${secs}s)`);
    else {
      const err = existsSync(final.stderrFile) ? readFileSync(final.stderrFile, 'utf8').trim().split('\n').slice(-5).join('\n') : '';
      const out = existsSync(final.stdoutFile) ? readFileSync(final.stdoutFile, 'utf8').trim().split('\n').slice(-5).join('\n') : '';
      log(`[FAIL] ${nombre}:${modelo} no dejó el informe (código ${final.code}${final.sinCuota ? ', sin cuota' : ''}, ${secs}s)`);
      if (err) log(`       stderr: ${err.replace(/\n/g, '\n               ')}`);
      if (out) log(`       stdout: ${out.replace(/\n/g, '\n               ')}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ----------------------------------------------------------------------- setup */

export function cmdSetup(cfg: Config, flags: Flags): void {
  const name = flagText(flags, 'qa').toLowerCase();
  if (!/^[a-z][a-z0-9-]*$/.test(name)) fail('Uso: setup --qa <nombre>, por ejemplo setup --qa oliver');
  if (cfg.personas.length > 0 && !cfg.personas.includes(name))
    fail(`"${name}" no está en "personas" de orquestador.json (${cfg.personas.join(', ')}).`);
  writeLocal({ qa: name });
  log(`done -> tu rama de pruebas es qa/${name}: se crea en worktrees/<grupo>/qa con el primer «qa <id>». Nunca se sube.`);
}

/* ------------------------------------------------------------------------- env */

function readEnvFile(path: string): Map<string, string> | null {
  if (!existsSync(path)) return null;
  const vars = new Map<string, string>();
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    const eq = line.indexOf('=');
    if (!line || line.startsWith('#') || eq < 1) continue;
    vars.set(line.slice(0, eq).replace(/^export\s+/, '').trim(), line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return vars;
}

/** Qué variables hay y cuáles faltan en un repo, sin mostrar ningún valor. */
export function cmdEnv(cfg: Config, flags: Flags): void {
  const p = flagText(flags, 'proyecto') ? proyectoPorNombre(cfg, flagText(flags, 'proyecto')) : cfg.proyectos[0];
  if (flags.sync) {
    const repos = flagText(flags, 'repo') ? [repoPorDir(p, flagText(flags, 'repo'))] : p.repos;
    for (const repo of repos) imprimirResumen(sincronizarEnv(p, repo, repo.envGenerar ?? []));
    return;
  }
  const repo = repoPorDir(p, flagText(flags, 'repo') || fail('Uso: env --repo <carpeta>'));
  const example = readEnvFile(join(repo.path, '.env.example')) ?? new Map<string, string>();
  const files = ['.env', '.env.local'].filter((n) => existsSync(join(repo.path, n)));
  if (files.length === 0) fail(`No hay .env en ${repo.path}: cópialo de .env.example y pon los valores.`);
  const actual = new Map<string, string>();
  for (const n of files) for (const [k, v] of readEnvFile(join(repo.path, n)) ?? []) actual.set(k, v);
  const names = [...new Set([...example.keys(), ...actual.keys()])].sort();
  const state = (n: string) => (!actual.has(n) ? 'falta' : actual.get(n)!.length === 0 ? 'vacía' : 'definida');
  log(`Variables de ${repo.dir}/${files.join(' + ')} frente a .env.example (sin valores)`);
  log('');
  log('| Variable | Tu archivo | En .env.example |');
  log('|---|---|---|');
  for (const n of names) log(`| ${n} | ${state(n)} | ${example.has(n) ? 'sí' : 'no'} |`);
  const missing = names.filter((n) => example.has(n) && !actual.has(n));
  log('');
  log(missing.length ? `Faltan: ${missing.join(', ')}` : 'No falta ninguna variable del ejemplo.');
}

/**
 * El ciclo de un ticket: start → trabajar (implementer ⇄ reviewer) → finish → qa → pr → clean.
 * Cada paso actúa sobre un repo del ticket o sobre todos, en el orden del proyecto.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  approvePr,
  createPr,
  fetchItem,
  prOfBranch,
  prUrl,
  signed,
  summarize,
  ticketUrl,
  typeRules,
  updateItem,
} from './ado.ts';
import {
  WORKSPACE,
  escalarTras,
  parseSpec,
  personaDe,
  tituloDePr,
  qaBranch,
  type Config,
  type MotorSpec,
  type ProyectoCfg,
  type RepoCfg,
  type Rol,
} from './config.ts';
import {
  baseRef,
  branchFor,
  commitsAhead,
  dirtyIn,
  ensureQaWorktree,
  ensureTicketWorktree,
  git,
  gitWrite,
  isAncestor,
  lastCommitTime,
  shortHead,
  ticketBranch,
  worktreePath,
} from './git.ts';
import { readHistory, record, rondasDeCambios } from './historial.ts';
import { binarioDe, correrMotor, motorPorNombre } from './motores/correr.ts';
import { leerDictamen, leerInformeImpl, renderRol } from './roles.ts';
import {
  cadenaDe,
  cmdShow,
  proyectoDe,
  readMeta,
  criterios,
  rel,
  repoWorkDir,
  reposObjetivo,
  repoPorDir,
  ticketDir,
  ticketMd,
  unRepo,
  type Meta,
} from './tickets.ts';
import { fail, flagText, isDryRun, log, readSection, type Flags } from './util.ts';

/** Corre un comando del JSON del proyecto (instalar, verificar) en una carpeta, con la salida a la vista. */
function shell(command: string, cwd: string): number {
  if (isDryRun()) {
    log(`[dry-run] ${command} (en ${cwd})`);
    return 0;
  }
  log(`$ ${command}   (en ${cwd})`);
  const result = spawnSync(command, { cwd, shell: true, stdio: 'inherit', windowsHide: true });
  return result.status ?? 1;
}

function instalarSiFalta(repo: RepoCfg, dir: string, flags: Flags): void {
  if (!repo.instalar || flags['sin-instalar'] || existsSync(join(dir, 'node_modules'))) return;
  if (shell(repo.instalar, dir) !== 0) log(`[WARN] La instalación falló en ${dir}: el worker lo intentará de nuevo.`);
}

const firmar = (cfg: Config, repo: RepoCfg | ProyectoCfg, text: string) =>
  signed(cfg.firma, 'dir' in repo ? repo.repository : repo.nombre, text);

/* ----------------------------------------------------------------------- start */

/**
 * Ticket apilado (`start <id> --sobre <otro>`): su rama nace de la rama del otro ticket (ya aprobado pero aún
 * no en la rama base) en lugar de la base. Se guarda en progress/tickets/<id>/sobre.json y lo usan `trabajar`
 * (el diff que ven los workers) y `start` al reanudar.
 */
const sobrePath = (id: number) => join(ticketDir(id), 'sobre.json');
type Sobre = { id: number; ramas: Record<string, string> };
export function sobreDe(id: number): Sobre | null {
  return existsSync(sobrePath(id)) ? (JSON.parse(readFileSync(sobrePath(id), 'utf8')) as Sobre) : null;
}
/** La base de un ticket en un repo: la rama del ticket del que cuelga, o la rama base del proyecto. */
export function baseDeTicket(p: ProyectoCfg, repo: RepoCfg, id: number): string {
  const rama = sobreDe(id)?.ramas[repo.dir];
  return rama && ticketBranch(repo, sobreDe(id)!.id) === rama ? rama : baseRef(repo, p.ramaBase);
}

export function cmdStart(cfg: Config, id: number, flags: Flags): void {
  const p = proyectoDe(cfg, id, flags);
  const sobre = flagText(flags, 'sobre') ? Number(flagText(flags, 'sobre')) : null;
  if (sobre !== null && !Number.isInteger(sobre)) fail('--sobre espera el id de otro ticket.');
  const meta = readMeta(id)?.repos.length && !flagText(flags, 'repo') ? readMeta(id)! : cmdShow(cfg, id, flags);
  if (meta.repos.length === 0) fail(`#${id} no tiene etiqueta de repo: inícialo con --repo <carpeta>.`);
  const rules = typeRules(p)[meta.type];
  if (!rules) fail(`El tipo "${meta.type}" no se trabaja con el orquestador (${Object.keys(typeRules(p)).join(', ')}).`);
  const repos = p.repos.filter((r) => meta.repos.includes(r.dir));
  const lines: string[] = [];
  for (const repo of repos) {
    const wanted = branchFor(meta.type, id, meta.title);
    let base = p.ramaBase;
    const ramaPadre = sobre !== null ? ticketBranch(repo, sobre) : '';
    if (sobre !== null && !ramaPadre) log(`#${sobre} no toca ${repo.dir}: #${id} nace ahí de ${p.ramaBase}.`);
    if (sobre !== null && ramaPadre) {
      base = ramaPadre;
      const prev = sobreDe(id) ?? { id: sobre, ramas: {} };
      if (!isDryRun()) writeFileSync(sobrePath(id), JSON.stringify({ id: sobre, ramas: { ...prev.ramas, [repo.dir]: ramaPadre } }, null, 2));
      log(`#${id} en ${repo.dir} nace de la rama de #${sobre} (${ramaPadre}): su PR debe entrar después del de #${sobre}.`);
    }
    const { dir, branch, created } = ensureTicketWorktree(repo, id, wanted, base);
    if (created) record({ id, proyecto: p.nombre, repo: repo.dir, event: 'iniciado', title: meta.title, branch });
    else log(`${dir} ya existe: se reanuda.`);
    if (!isDryRun()) instalarSiFalta(repo, dir, flags);
    lines.push(`${repo.dir} → ${dir} (${branch})`);
  }
  const state = fetchItem(p, id, { light: true });
  updateItem(
    p,
    id,
    {
      state: summarize(state).state !== rules.start ? rules.start : undefined,
      discussion: firmar(cfg, p, `Inicio del trabajo: ${lines.join(' · ')}.`),
    },
    `estado -> ${rules.start} y comentario de inicio`,
  );
  log(`done -> #${id} en "${rules.start}" · ${lines.join(' · ')}`);
}

/* -------------------------------------------------------------------- trabajar */

function siguienteIntento(dir: string, rol: Rol): number {
  if (!existsSync(dir)) return 1;
  return readdirSync(dir).filter((f) => f.startsWith(`brief-${rol}-`)).length + 1;
}

const newer = (a: string, b: string) => existsSync(a) && (!existsSync(b) || statSync(a).mtimeMs > statSync(b).mtimeMs);

/**
 * Los otros repos del mismo proyecto (el back para el front y al revés), con la carpeta donde leerlos:
 * su carpeta de ticket si este también lo toca y ya existe; si no, el checkout principal (en la rama base).
 */
function otrosRepos(p: ProyectoCfg, meta: Meta, repo: RepoCfg): { repo: RepoCfg; dir: string; delTicket: boolean }[] {
  return p.repos
    .filter((r) => r.dir !== repo.dir)
    .map((r) => {
      const wt = worktreePath(r, meta.id);
      const delTicket = meta.repos.includes(r.dir) && existsSync(wt);
      return { repo: r, dir: delTicket ? wt : r.path, delTicket };
    })
    .filter((o) => existsSync(o.dir));
}

/** El bloque que avisa de los otros repos del proyecto (la API y los contratos del back para el front). Siempre va. */
function contrato(p: ProyectoCfg, meta: Meta, repo: RepoCfg): string {
  const others = otrosRepos(p, meta, repo);
  if (others.length === 0) return '';
  const where = others
    .map((o) => `\`${o.repo.dir}\` (\`${o.dir}\`${o.delTicket ? ', la carpeta de este ticket' : `, checkout en ${p.ramaBase}`})`)
    .join(', ');
  return `
> Puedes leer (solo leer) los otros repos del proyecto: ${where}. Ahí están los contratos y la API de los que dependes (por ejemplo, \`documentacion/\` y los endpoints del back): léelos y no los inventes. Si el ticket también toca ese repo, lo que falta allí es dependencia: termina BLOQUEADO (dependencia).
`;
}

function correcciones(work: string, flags: Flags): string {
  const blocks: string[] = [];
  const review = join(work, 'review.md');
  const impl = join(work, 'impl.md');
  const dictamen = leerDictamen(review);
  if (dictamen?.dictamen === 'CAMBIOS' && newer(review, impl)) {
    blocks.push(
      '\n## Correcciones pedidas por la revisión\n',
      'Ya hay commits en la rama. Corrige **solo** esto y vuelve a verificar:\n',
      dictamen.bloqueantes || `(Lee la sección «Bloqueantes» de \`${review}\`.)`,
    );
  }
  const text = flagText(flags, 'text');
  if (text) blocks.push('\n## Indicaciones del coordinador\n', text);
  return blocks.length ? `${blocks.join('\n')}\n` : '';
}

type Resultado = { rol: Rol; resultado: string; motor: string; informe: string; detalle: string };

export function cmdTrabajar(cfg: Config, id: number, flags: Flags): Resultado {
  const rol = flagText(flags, 'rol') as Rol;
  if (rol !== 'implementer' && rol !== 'reviewer') fail('Uso: trabajar <id> --rol implementer|reviewer [--repo carpeta] [--motor motor:modelo[:esfuerzo]] [--text indicaciones]');
  const p = proyectoDe(cfg, id, flags);
  const meta = readMeta(id) ?? fail(`#${id} no está iniciado: start ${id}`);
  const repo = unRepo(p, id, flags);
  const cwd = worktreePath(repo, id);
  if (!existsSync(cwd)) fail(`No existe ${cwd}: start ${id}`);
  if (!existsSync(join(cwd, '.git'))) fail(`${cwd} existe pero ya no es un worktree (quedó solo lo que dejó clean, p. ej. node_modules): bórrala y corre start ${id} --repo ${repo.dir} para recrearlo sobre su rama.`);
  const work = repoWorkDir(id, repo);
  mkdirSync(work, { recursive: true });
  const branch = ticketBranch(repo, id);
  const base = baseDeTicket(p, repo, id);
  const informe = join(work, rol === 'implementer' ? 'impl.md' : 'review.md');

  const vars: Record<string, string> = {
    ID: String(id),
    TITULO: meta.title,
    PROYECTO: p.nombre,
    REPO: repo.dir,
    CARPETA: cwd,
    RAMA: branch,
    BASE: base,
    TICKET: ticketMd(id),
    INFORME: informe,
    IMPL: join(work, 'impl.md'),
    VERIFICAR: repo.verificar,
    INSTALAR: repo.instalar ?? '(el repo no define cómo instalar)',
    WORKSPACE,
    CONTRATO: contrato(p, meta, repo),
    CORRECCIONES: rol === 'implementer' ? correcciones(work, flags) : '',
  };
  if (rol === 'reviewer' && !existsSync(vars.IMPL)) fail(`Falta el informe del implementer (${rel(vars.IMPL)}).`);

  /** Lo común al terminar un worker con informe válido: clasificarlo, registrarlo y avisar. */
  const cerrar = (res: NonNullable<ReturnType<typeof leerInformeImpl> | ReturnType<typeof leerDictamen>>, motorTexto: string, headBefore: string): Resultado => {
    let resultado: string;
    let detalle: string;
    if ('estado' in res) {
      resultado = res.estado;
      detalle = res.estado === 'BLOQUEADO' ? `(${res.tipo ?? 'sin tipo'}) ${res.pregunta ?? 'ver informe'}` : res.resumen.split('\n')[0] ?? '';
      if (res.estado === 'LISTO' && dirtyIn(cwd)) {
        resultado = 'BLOQUEADO';
        detalle = '(informacion) el implementer dejó cambios sin confirmar';
      }
    } else {
      resultado = res.dictamen;
      detalle = res.resumen;
      if (shortHead(cwd) !== headBefore) detalle = `⚠ el reviewer cambió la rama (${headBefore} → ${shortHead(cwd)}); revisa. ${detalle}`;
    }
    record({ id, proyecto: p.nombre, repo: repo.dir, event: 'trabajo', rol, motor: motorTexto, resultado });
    const out = { rol, resultado, motor: motorTexto, informe: rel(informe), detalle };
    if (flags.json) log(JSON.stringify(out));
    else log(`${resultado} -> ${motorTexto} · ${rel(informe)}${detalle ? ` · ${detalle}` : ''}`);
    return out;
  };

  // Motor manual (Claude Desktop) en curso: si ya dejó el informe, se cierra; si no, sigue pendiente.
  const pendiente = join(work, `${rol}-desktop.pendiente.json`);
  if (existsSync(pendiente) && !isDryRun()) {
    const pend = JSON.parse(readFileSync(pendiente, 'utf8')) as { started: number; promptFile: string; head: string; motor: string; prompt: string };
    const res = rol === 'implementer' ? leerInformeImpl(informe, pend.started) : leerDictamen(informe, pend.started);
    if (res) {
      rmSync(pendiente);
      return cerrar(res, pend.motor, pend.head);
    }
    if (!flags['descartar-desktop']) {
      log(`DESKTOP_PENDIENTE -> ${pend.motor} · la sesión de Desktop aún no deja ${rel(informe)} · prompt: ${pend.prompt}`);
      log(`  (para olvidarla y lanzar otro motor: --descartar-desktop)`);
      return { rol, resultado: 'DESKTOP_PENDIENTE', motor: pend.motor, informe: rel(informe), detalle: pend.prompt };
    }
    rmSync(pendiente);
    log('Sesión de Desktop pendiente descartada.');
  }

  let specs: MotorSpec[];
  if (flagText(flags, 'motor')) specs = [parseSpec(flagText(flags, 'motor'))];
  else {
    const chain = cadenaDe(cfg, meta, rol);
    const skip = rol === 'implementer' ? Math.floor(rondasDeCambios(readHistory(), id, repo.dir) / escalarTras(cfg, meta.talla)) : 0;
    specs = chain.slice(Math.min(skip, chain.length - 1));
    if (skip > 0) log(`Escalado: ${skip} vuelta(s) sin aprobar → empieza en ${specs[0].texto}.`);
    // Un bucle de vueltas suele ser falta de capacidad: tras `escalarFuerteTras` salta al motor fuerte y, si falla, sigue la cadena.
    const vueltas = rol === 'implementer' ? rondasDeCambios(readHistory(), id, repo.dir) : 0;
    if (vueltas >= cfg.escalarFuerteTras) {
      const fuerte = parseSpec(cfg.motorFuerte);
      specs = [fuerte, ...specs.filter((s) => s.texto !== fuerte.texto)];
      log(`Bucle: ${vueltas} vueltas sin aprobar → empieza en el motor fuerte ${fuerte.texto}.`);
    }
  }

  // Un worktree guarda su índice y sus refs fuera de su carpeta (`.git/worktrees/<id>` y el `.git` común): sin
  // escritura ahí el worker no puede ni `git add` ni `git commit`.
  const dirsGit = [...new Set(['--git-dir', '--git-common-dir'].map((a) => resolve(cwd, git(['rev-parse', a], cwd).stdout.trim())))];
  const dirsExtra = [
    work,
    ...dirsGit,
    ...otrosRepos(p, meta, repo).map((o) => o.dir),
    ...flagText(flags, 'dir').split(',').map((d) => d.trim()).filter(Boolean),
  ];
  const intentos: string[] = [];
  for (const spec of specs) {
    const motor = motorPorNombre(spec.motor);
    if (!binarioDe(motor)) {
      intentos.push(`${spec.texto}: no instalado`);
      continue;
    }
    if (motor.manual) {
      const n = siguienteIntento(work, rol);
      const promptFile = join(work, `brief-${rol}-${n}.md`);
      const prompt = `Rol: ${rol} (lanzado por el orquestador en Claude Desktop). Lee ${promptFile} y cumple sus instrucciones al pie de la letra. Tu carpeta de trabajo es ${cwd}: haz ahí todos los cambios, comandos y commits.`;
      if (isDryRun()) {
        log(`[dry-run] ${spec.texto} en ${cwd} · prompt ${rel(promptFile)}`);
        return { rol, resultado: 'DRY_RUN', motor: spec.texto, informe: rel(informe), detalle: '' };
      }
      writeFileSync(promptFile, renderRol(rol, vars));
      writeFileSync(pendiente, JSON.stringify({ started: Date.now(), promptFile, head: shortHead(cwd), motor: spec.texto, prompt }, null, 2));
      record({ id, proyecto: p.nombre, repo: repo.dir, event: 'trabajo', rol, motor: spec.texto, resultado: 'DESKTOP_PENDIENTE' });
      const esfuerzo = spec.esfuerzo ? ` · esfuerzo ${spec.esfuerzo}` : '';
      log(`DESKTOP_PENDIENTE -> ${spec.texto} · abre una sesión de Claude Desktop (modelo ${spec.modelo}${esfuerzo}) con este prompt:`);
      log(`  ${prompt}`);
      log(`  Al terminar la sesión: trabajar ${id} --rol ${rol} --repo ${repo.dir}`);
      return { rol, resultado: 'DESKTOP_PENDIENTE', motor: spec.texto, informe: rel(informe), detalle: prompt };
    }
    let sinInformeReintentado = false;
    for (let red = 0; ; red += 1) {
      const n = siguienteIntento(work, rol);
      const promptFile = join(work, `brief-${rol}-${n}.md`);
      const logBase = join(work, `${rol}-${n}-${spec.motor}`);
      const nota = sinInformeReintentado
        ? `\n---\nEl intento anterior terminó sin dejar un informe válido en ${informe}: revisa \`git status\` y \`git diff\`, termina lo que falte y escribe el informe con el formato exacto del rol.\n`
        : red > 0
          ? '\n---\nEl intento anterior se cortó por un error de red: revisa `git status` y `git diff` y continúa desde ahí.\n'
          : '';
      const prompt = renderRol(rol, vars) + nota;
      const headBefore = shortHead(cwd);
      const started = Date.now();
      log(`→ ${rol} de #${id} en ${repo.dir} con ${spec.texto} (intento ${n})…`);
      if (isDryRun()) {
        log(`[dry-run] ${spec.texto} en ${cwd} · prompt ${rel(promptFile)}`);
        return { rol, resultado: 'DRY_RUN', motor: spec.texto, informe: rel(informe), detalle: '' };
      }
      const final = correrMotor(motor, { cwd, prompt, promptFile, modelo: spec.modelo, esfuerzo: spec.esfuerzo, dirsExtra: dirsExtra }, logBase);
      const res = rol === 'implementer' ? leerInformeImpl(informe, started) : leerDictamen(informe, started);
      if (res) return cerrar(res, spec.texto, headBefore);
      if (final.sinCuota) {
        record({ id, proyecto: p.nombre, repo: repo.dir, event: 'trabajo', rol, motor: spec.texto, resultado: 'SIN_CUOTA' });
        intentos.push(`${spec.texto}: sin cuota`);
        log(`${spec.texto} sin cuota: paso al siguiente motor.`);
        break;
      }
      if (final.corteRed && red < 2) {
        log(`${spec.texto}: corte de red, reintento ${red + 1} de 2 sobre la misma carpeta.`);
        continue;
      }
      if (!sinInformeReintentado) {
        sinInformeReintentado = true;
        record({ id, proyecto: p.nombre, repo: repo.dir, event: 'trabajo', rol, motor: spec.texto, resultado: 'SIN_INFORME' });
        log(`${spec.texto} no dejó un informe válido en ${rel(informe)}: reintento una vez con el mismo motor.`);
        continue;
      }
      record({ id, proyecto: p.nombre, repo: repo.dir, event: 'trabajo', rol, motor: spec.texto, resultado: 'SIN_INFORME' });
      intentos.push(`${spec.texto}: terminó (código ${final.code}) sin informe válido · ${rel(final.stderrFile)}`);
      log(`${spec.texto} no dejó un informe válido en ${rel(informe)}: paso al siguiente motor.`);
      break;
    }
  }
  return fail(`Ningún motor completó el ${rol} de #${id}:\n${intentos.map((i) => `  - ${i}`).join('\n')}`);
}

/* ---------------------------------------------------------------------- finish */

function assertAprobado(id: number, repo: RepoCfg, dir: string, ref = 'HEAD'): void {
  const path = join(repoWorkDir(id, repo), 'review.md');
  const dictamen = leerDictamen(path);
  if (!dictamen) fail(`Falta el dictamen de ${repo.dir} (${rel(path)}): trabajar ${id} --rol reviewer --repo ${repo.dir}`);
  if (dictamen.dictamen !== 'APROBADO') fail(`La revisión de #${id} en ${repo.dir} pidió CAMBIOS (${rel(path)}).`);
  if (Math.floor(statSync(path).mtimeMs / 1000) < lastCommitTime(dir, ref))
    fail(`La revisión de ${repo.dir} es anterior al último commit: vuelve a lanzar al reviewer.`);
}

export function cmdFinish(cfg: Config, id: number, flags: Flags): void {
  const p = proyectoDe(cfg, id, flags);
  const meta = readMeta(id) ?? fail(`#${id} no está iniciado.`);
  for (const repo of reposObjetivo(p, id, flags)) {
    const dir = worktreePath(repo, id);
    if (!existsSync(dir)) fail(`No existe ${dir}.`);
    if (dirtyIn(dir)) fail(`${dir} tiene cambios sin confirmar: el implementer debe hacer commit.`);
    const commits = commitsAhead(dir, baseRef(repo, p.ramaBase));
    if (commits.length === 0) fail(`${repo.dir}: la rama no tiene commits nuevos respecto a ${p.ramaBase}.`);
    assertAprobado(id, repo, dir);
    if (!flags['sin-verificar'] && shell(repo.verificar, dir) !== 0) {
      record({ id, proyecto: p.nombre, repo: repo.dir, event: 'trabajo', rol: 'implementer', motor: 'verificación', resultado: 'VERIFICACION_FALLIDA' });
      fail(`La verificación de ${repo.dir} falló: vuelve al implementer con la salida.`);
    }
    const resumen = readSection(join(repoWorkDir(id, repo), 'impl.md'), 'Resumen') || 'Ver los commits de la rama.';
    const item = fetchItem(p, id, { light: true });
    const tags = summarize(item).tags;
    updateItem(
      p,
      id,
      {
        tags: tags.some((t) => t.toLowerCase() === p.etiquetaListo.toLowerCase()) ? undefined : [...tags, p.etiquetaListo],
        discussion: firmar(
          cfg,
          repo,
          [
            'Trabajo terminado y revisado; pendiente de la prueba manual.',
            '',
            resumen.slice(0, 1500),
            '',
            ...guiaDePrueba(cfg, p, repo, id),
            '',
            'Commits:',
            ...commits.map(([h, s]) => `- ${h} ${s}`),
          ].join('\n'),
        ),
      },
      `etiqueta "${p.etiquetaListo}" y resumen de ${repo.dir}`,
    );
    log(`done -> #${id} en ${repo.dir} listo para la prueba: qa ${id}${meta.repos.length > 1 ? ` --repo ${repo.dir}` : ''}`);
  }
}

/* -------------------------------------------------------------------------- qa */

export function cmdQa(cfg: Config, id: number | null, flags: Flags): void {
  const branchQa = qaBranch(cfg);
  if (flags.reset) {
    const p = flagText(flags, 'proyecto') ? cfg.proyectos.find((x) => x.nombre === flagText(flags, 'proyecto'))! : cfg.proyectos[0];
    const repos = flagText(flags, 'repo') ? [repoPorDir(p, flagText(flags, 'repo'))] : p.repos;
    for (const repo of repos) {
      const dir = ensureQaWorktree(repo, branchQa, p.ramaBase);
      if (!existsSync(dir)) continue;
      if (dirtyIn(dir)) fail(`${dir} tiene cambios sin confirmar o un merge a medias.`);
      const from = baseRef(repo, p.ramaBase);
      gitWrite(['reset', '--hard', from], dir, `rehacer ${branchQa} de ${repo.dir} desde ${from}`);
      log(`done -> ${branchQa} de ${repo.dir} rehecha desde ${from}`);
    }
    return;
  }
  if (id === null) fail('Uso: qa <id> | qa <id> --falla --text "qué falló" | qa --reset');
  const p = proyectoDe(cfg, id, flags);
  const repos = reposObjetivo(p, id, flags);
  if (flags.falla) {
    const note = flagText(flags, 'text') || fail(`Uso: qa ${id} --falla --text "qué falló"`);
    updateItem(p, id, { discussion: firmar(cfg, p, `Prueba manual fallida en ${branchQa}: ${note}`) }, 'comentario de la prueba fallida');
    for (const repo of repos) record({ id, proyecto: p.nombre, repo: repo.dir, event: 'falló', note });
    log(`done -> #${id} anotado como fallido; vuelve al implementer con: trabajar ${id} --rol implementer --text "${note}"`);
    return;
  }
  for (const repo of repos) {
    const dir = ensureQaWorktree(repo, branchQa, p.ramaBase);
    if (isDryRun() && !existsSync(dir)) continue;
    instalarSiFalta(repo, dir, flags);
    if (dirtyIn(dir)) fail(`${dir} tiene cambios sin confirmar o un merge a medias; resuélvelo antes de seguir.`);
    const branch = ticketBranch(repo, id) || fail(`No hay rama de #${id} en ${repo.dir}: start ${id}`);
    const ticketDir = worktreePath(repo, id);
    assertAprobado(id, repo, existsSync(ticketDir) ? ticketDir : repo.path, branch);
    if (isDryRun()) {
      log(`[dry-run] mezclar ${branch} en ${branchQa}`);
      continue;
    }
    const merge = git(['merge', '--no-ff', '--no-edit', branch], dir, { allowFail: true });
    if (merge.status !== 0) {
      const files = git(['diff', '--name-only', '--diff-filter=U'], dir).stdout.trim();
      fail(
        [
          `Conflicto al mezclar ${branch} en ${branchQa}:`,
          files || (merge.stderr || merge.stdout).trim(),
          `Lo resuelve el implementer de #${id} en ${dir} (git add + git commit),`,
          `o se descarta con: git -C "${dir}" merge --abort`,
        ].join('\n'),
      );
    }
    const hash = shortHead(dir);
    updateItem(p, id, { discussion: firmar(cfg, repo, `Mezclado en ${branchQa} (${hash}) para la prueba manual.`) }, `comentario de la mezcla en ${branchQa}`);
    record({ id, proyecto: p.nombre, repo: repo.dir, event: 'en-prueba', branch, hash });
    log(`done -> #${id} mezclado en ${branchQa} de ${repo.dir} (${hash}) · carpeta ${dir}`);
  }
}

/* -------------------------------------------------------------------------- pr */

export function cmdPr(cfg: Config, id: number, flags: Flags): void {
  const p = proyectoDe(cfg, id, flags);
  const meta = readMeta(id) ?? fail(`#${id} no está iniciado.`);
  const probado = Boolean(flags.probado);
  const branchQa = probado ? qaBranch(cfg) : null;
  for (const repo of reposObjetivo(p, id, flags)) {
    const dir = worktreePath(repo, id);
    const branch = ticketBranch(repo, id) || fail(`No hay rama de #${id} en ${repo.dir}.`);
    const where = existsSync(dir) ? dir : repo.path;
    if (existsSync(dir) && dirtyIn(dir)) fail(`${dir} tiene cambios sin confirmar.`);
    const commits = git(['log', '--format=%h%x09%s', `${baseRef(repo, p.ramaBase)}..${branch}`], repo.path)
      .stdout.split('\n')
      .filter(Boolean)
      .map((l) => l.split('\t'));
    if (commits.length === 0) fail(`${repo.dir}: la rama ${branch} no tiene commits nuevos.`);
    assertAprobado(id, repo, where, branch);
    let tested: string | null = null;
    if (branchQa) {
      if (!isAncestor(repo.path, branch, `refs/heads/${branchQa}`))
        fail(`${branch} tiene commits que no se probaron en ${branchQa}: qa ${id} y prueba otra vez.`);
      tested = shortHead(repo.path, `refs/heads/${branchQa}`);
    }
    const work = repoWorkDir(id, repo);
    // El título sale del primer commit del ticket (el que lo nombra), no del más viejo de la rama: en un ticket
    // apilado (--sobre) o con commits de la base que entraron con squash, el más viejo es de otro ticket.
    // Entre los del ticket se prefiere el primer feat/fix: el primero a secas suele ser preparatorio
    // («build(deps): agregar …»).
    // «Del ticket» = el mensaje completo lo nombra (en el asunto o en el pie «Refs #<id>»).
    const nombran = new Set(
      git(['log', '-E', `--grep=#${id}([^0-9]|$)`, '--format=%h', `${baseRef(repo, p.ramaBase)}..${branch}`], repo.path)
        .stdout.split('\n')
        .filter(Boolean),
    );
    const delTicket = commits.filter(([h, s]) => nombran.has(h ?? '') && !/^merge\b|^Merge /i.test(s ?? ''));
    // Entre los feat/fix, los del alcance que más se repite: un feat(api) preparatorio no le gana a los
    // feat(records) que son el ticket. `commits` va del más nuevo al más viejo: `.at(-1)` es el primero.
    const featFix = delTicket.filter(([, s]) => /^(feat|fix)(\(|:|!)/.test(s ?? ''));
    const alcance = (s: string | undefined) => /^\w+\(([^)]+)\)/.exec(s ?? '')?.[1] ?? '';
    const veces = new Map<string, number>();
    for (const [, s] of featFix) veces.set(alcance(s), (veces.get(alcance(s)) ?? 0) + 1);
    const masComun = [...veces.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    const delAlcance = featFix.filter(([, s]) => alcance(s) === masComun);
    const feats = delAlcance.filter(([, s]) => /^feat/.test(s ?? ''));
    const principal = feats.at(-1) ?? delAlcance.at(-1) ?? featFix.at(-1) ?? delTicket.at(-1);
    const title = flagText(flags, 'title') || tituloDePr(p.tituloPr, id, principal?.[1] ?? meta.title);
    const description = [
      `Ticket: ${ticketUrl(p, id)} (#${id}, ${meta.type})`,
      '',
      '## Resumen',
      (readSection(join(work, 'impl.md'), 'Resumen') || '_Ver commits._').slice(0, 2500),
      '',
      '## Revisión automática',
      (leerDictamen(join(work, 'review.md'))?.resumen || 'APROBADO').slice(0, 1200),
      '',
      tested
        ? `Probado y aceptado por ${personaDe(cfg)} en ${branchQa} (${tested}). Se completa solo al pasar las políticas.`
        : 'Requiere revisión humana antes de completar.',
    ].join('\n');
    // Si la rama ya tiene un PR, no se abre otro: si sigue activo se empujan los commits nuevos (p. ej. la mezcla
    // de la base tras un conflicto); si ya se completó, no se empuja (recrearía la rama borrada).
    const previo = prOfBranch(p, repo.repository, branch);
    const vivo = previo && previo.status !== 'abandoned' ? previo : null;
    if (!vivo || vivo.status === 'active') gitWrite(['push', '-u', 'origin', branch], repo.path, `empujar ${branch}`);
    const pr =
      vivo ?? createPr(p, { repository: repo.repository, source: branch, title, description, workItem: id, autoComplete: Boolean(tested) });
    if (!pr) continue;
    if (vivo) log(`  ${repo.dir}: la rama ya tiene el PR ${pr.pullRequestId} (${pr.status}); no se abre otro.`);
    const url = prUrl(p, repo.repository, pr.pullRequestId);
    // Sin revisores obligatorios, el autocompletar cierra el PR al crearlo y ya no admite voto.
    if (tested && pr.status !== 'completed') approvePr(p, pr.pullRequestId);
    updateItem(
      p,
      id,
      {
        discussion: firmar(
          cfg,
          repo,
          tested ? `Prueba manual aceptada en ${branchQa} (${tested}). Pull Request en autocompletar: ${url}` : `Pull Request abierto: ${url}`,
        ),
      },
      `enlace al PR de ${repo.dir}`,
    );
    if (tested) record({ id, proyecto: p.nombre, repo: repo.dir, event: 'aceptado', pr: pr.pullRequestId, hash: tested });
    log(`done -> ${repo.dir} PR ${pr.pullRequestId}${tested ? ' (aprobado, autocompletar)' : ''}: ${url}`);
  }
}

/* ----------------------------------------------------------------------- clean */

export function cmdClean(cfg: Config, id: number, flags: Flags): void {
  const p = proyectoDe(cfg, id, flags);
  for (const repo of reposObjetivo(p, id, flags)) {
    const dir = worktreePath(repo, id);
    if (!existsSync(dir)) continue;
    // Sin --force: git se niega si quedan cambios sin confirmar, y así no se pierde trabajo.
    gitWrite(['worktree', 'remove', dir], repo.path, `borrar ${dir}`);
    record({ id, proyecto: p.nombre, repo: repo.dir, event: 'limpio' });
    log(`done -> ${dir} borrada; la rama del ticket se conserva`);
  }
}

/**
 * La guía de prueba de un ticket en un repo, para la persona: cómo levantarlo, cómo probarlo (del informe del
 * implementer) y los criterios de aceptación. Va en el comentario de `finish` y en `guia --publicar <id>`.
 */
export function guiaDePrueba(cfg: Config, p: ProyectoCfg, repo: RepoCfg, id: number): string[] {
  const como = readSection(join(repoWorkDir(id, repo), 'impl.md'), 'Cómo probarlo');
  const crit = criterios(id);
  return [
    `CÓMO PROBARLO (${repo.dir}, rama de pruebas qa/${cfg.qa ?? '<tu-nombre>'}):`,
    `- Levantar: en ${worktreePath(repo, 'qa')} → ${repo.levantar ?? '(ver README del repo)'}${repo.url ? ` · ${repo.url}` : ''}`,
    ...(como ? como.split('\n') : ['- El implementer no dejó los pasos: pídeselos al coordinador.']),
    '',
    'CRITERIOS DE ACEPTACIÓN (qué validar):',
    ...(crit.length ? crit.map((c) => `- [ ] ${c}`) : ['- El ticket no tiene criterios de aceptación escritos.']),
    '',
    `Si funciona: /qa-ok ${id} · Si falla: /qa-falla ${id} <qué falló>`,
  ];
}

/** `guia --publicar <id>`: deja la guía de prueba de cada repo del ticket como comentario en Azure. */
export function cmdPublicarGuia(cfg: Config, id: number, flags: Flags): void {
  const p = proyectoDe(cfg, id, flags);
  for (const repo of reposObjetivo(p, id, flags)) {
    updateItem(p, id, { discussion: firmar(cfg, repo, guiaDePrueba(cfg, p, repo, id).join('\n')) }, `guía de prueba de ${repo.dir}`);
    log(`done -> guía de prueba de #${id} (${repo.dir}) publicada en Azure`);
  }
}

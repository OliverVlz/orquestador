// Oficina pixel art del orquestador. Node 24, sin dependencias.
// Sirve index.html y /estado.json en http://localhost:4400 (--puerto N u OFICINA_PUERTO para otro).
// Solo lee el workspace (progress/, worktrees/, la config del orquestador) y Azure cada 5 min; no escribe nada.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ORQ = resolve(AQUI, '..');
const RAIZ = resolve(process.env.ORQ_WORKSPACE ?? join(ORQ, '..'));
const PROGRESS = join(RAIZ, 'progress');
const argumento = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PUERTO = Number(argumento('puerto') ?? process.env.OFICINA_PUERTO) || 4400;
const MAX_AGENTES = 5;
const CADA_MS = 10_000;

/* ------------------------------------------------------------------ utilidades */

const leerJson = (ruta) => {
  try {
    return JSON.parse(readFileSync(ruta, 'utf8'));
  } catch {
    return null;
  }
};
const leerTexto = (ruta) => {
  try {
    return readFileSync(ruta, 'utf8');
  } catch {
    return '';
  }
};
const mtime = (ruta) => {
  try {
    return statSync(ruta).mtimeMs;
  } catch {
    return 0;
  }
};

function git(args, cwd) {
  return new Promise((ok) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 8000, windowsHide: true, maxBuffer: 4 << 20 }, (err, stdout) =>
      ok(err ? null : stdout.trim()),
    );
  });
}

const shortstat = (s) => ({
  mas: Number(/(\d+) insertion/.exec(s ?? '')?.[1] ?? 0),
  menos: Number(/(\d+) deletion/.exec(s ?? '')?.[1] ?? 0),
});

/** Líneas de los archivos nuevos sin seguimiento (lo no confirmado que `git diff` no ve). */
async function lineasSinSeguimiento(dir) {
  const lista = await git(['ls-files', '--others', '--exclude-standard'], dir);
  if (!lista) return 0;
  let total = 0;
  for (const f of lista.split('\n').slice(0, 200)) {
    const ruta = join(dir, f);
    try {
      if (statSync(ruta).size > 1 << 20) continue;
      const txt = await readFile(ruta, 'utf8');
      if (txt.includes('\0')) continue;
      total += txt.split('\n').length - (txt.endsWith('\n') ? 1 : 0);
    } catch {}
  }
  return total;
}

/* ------------------------------------------------------------------ configuración */

const mayuscula = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : null);

/** orquestador.json (del workspace) y local.json (de cada persona): repos, carpetas de worktrees y quién eres. */
function config() {
  const cfg = leerJson(join(ORQ, 'orquestador.json')) ?? {};
  const local = leerJson(join(ORQ, 'local.json')) ?? {};
  const repos = new Map();
  let etiquetaListo = 'orq-listo';
  for (const p of cfg.proyectos ?? []) {
    etiquetaListo = p.etiquetaListo ?? etiquetaListo;
    for (const r of p.repos ?? []) repos.set(r.dir, { grupo: r.worktrees ?? r.dir, ramaBase: p.ramaBase ?? 'develop' });
  }
  return {
    repos,
    etiquetaListo,
    ola: cfg.ola ?? null,
    ados: (cfg.proyectos ?? []).map((p) => p.ado).filter((a) => a?.organization && a?.project),
    persona: mayuscula(local.qa),
    marca: cfg.marca?.nombre ?? null,
  };
}

/* ------------------------------------------------------------------ agentes sin agentes.json */

// Sin progress/oficina/agentes.json, los agentes son los tickets en curso (historial: iniciado o falló, aún no en
// pruebas ni aceptado; en Doing si Azure ya respondió) con carpeta en worktrees/, hasta 5. Cada uno conserva su
// escritorio entre refrescos.
const escritorios = [];
function agentesAutomaticos(cfg, eventos) {
  const hitos = new Map();
  const ultimo = new Map();
  for (const e of eventos) {
    ultimo.set(e.id, e.at);
    if (e.repo && ['iniciado', 'en-prueba', 'falló', 'aceptado', 'limpio'].includes(e.event)) hitos.set(`${e.id}|${e.repo}`, e);
  }
  const enDoing = azure.doing ? new Set(azure.doing) : null;
  const enCurso = [...hitos.values()]
    .filter((e) => e.event === 'iniciado' || e.event === 'falló')
    .filter((e) => !enDoing || enDoing.has(e.id))
    .filter((e) => existsSync(join(RAIZ, 'worktrees', cfg.repos.get(e.repo)?.grupo ?? e.repo, String(e.id))))
    .sort((a, b) => String(ultimo.get(b.id) ?? '').localeCompare(String(ultimo.get(a.id) ?? '')));
  const clave = (e) => `${e.id}|${e.repo}`;
  const vigentes = new Set(enCurso.map(clave));
  for (let i = 0; i < escritorios.length; i++) if (escritorios[i] && !vigentes.has(clave(escritorios[i]))) escritorios[i] = null;
  const sentados = new Set(escritorios.filter(Boolean).map(clave));
  for (const e of enCurso) {
    if (sentados.has(clave(e))) continue;
    const libre = Array.from({ length: MAX_AGENTES }, (_, i) => i).find((i) => !escritorios[i]);
    if (libre === undefined) break;
    escritorios[libre] = e;
    sentados.add(clave(e));
  }
  return Array.from({ length: MAX_AGENTES }, (_, i) => ({
    nombre: `Agente ${i + 1}`,
    ticket: escritorios[i]?.id ?? null,
    repo: escritorios[i]?.repo ?? null,
  }));
}

/* ------------------------------------------------------------------ historial */

function historial() {
  return leerTexto(join(PROGRESS, 'historial.jsonl'))
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

const diaLocal = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${x.getMonth() + 1}-${x.getDate()}`;
};

/* ------------------------------------------------------------------ fase de un ticket */

const ESTADO_RE = /^ESTADO:\s*([A-ZÁÉÍÓÚ_]+)(.*)$/m;

/* ------------------------------------------------------------------ actividad, pruebas y atascos */

// Salidas de las pruebas: cuentan como actividad del ticket (no como «pruebas corriendo»).
const ARTEFACTOS_PRUEBA = [
  'coverage', 'coverage/lcov.info', 'coverage/coverage-final.json', 'coverage/coverage-summary.json',
  'junit.xml', 'test-results', 'playwright-report', 'node_modules/.vitest',
];
const ATASCADO_MS = 20 * 60_000;
// Solo ejecutores de tests: lint, prettier, tsc o build no son pruebas. Incluye los workers de jest
// (…\jest-worker\build\processChild.js) y vitest, que son los que de verdad gastan CPU.
const TEST_RE = /\b(jest|vitest|playwright|cypress|mocha)\b|\s--test\b/i;
// Un test corre si sus procesos gastaron al menos esto de CPU entre dos lecturas: un proceso huérfano o colgado
// sigue vivo pero quieto, y no cuenta.
const CPU_MIN_S = 0.5;

function mtimeRecursivo(dir, profundidad = 3) {
  let max = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const ruta = join(dir, e.name);
      if (!e.isDirectory()) max = Math.max(max, mtime(ruta));
      else if (profundidad > 0) max = Math.max(max, mtimeRecursivo(ruta, profundidad - 1));
    }
  } catch {}
  return max;
}

// Procesos node cada 15 s con su CPU acumulada: un test corriendo en un worktree lleva su ruta en la línea de
// comando (…\worktrees\back\366\node_modules\jest\bin\jest.js) y gasta CPU entre una lectura y la siguiente.
let procesos = []; // { pid, cpuDelta (s, null en la primera lectura), cmd }
let procesosAt = 0;
const cpuPrevia = new Map();
const segundosPs = (t) => {
  const [dias, resto] = t.includes('-') ? t.split('-') : ['0', t];
  return Number(dias) * 86_400 + resto.split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
};
function leerProcesos() {
  if (Date.now() - procesosAt < 15_000) return;
  procesosAt = Date.now();
  const [exe, args] =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { '{0}|{1}|{2}' -f $_.ProcessId, ($_.UserModeTime + $_.KernelModeTime), $_.CommandLine }`]]
      : ['ps', ['-eo', 'pid=,time=,args=']];
  execFile(exe, args, { encoding: 'buffer', timeout: 10_000, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => {
    if (err) return;
    const vistos = new Map();
    procesos = decodificar(stdout).split(/\r?\n/).filter(Boolean).flatMap((linea) => {
      let pid, cpu, cmd;
      if (process.platform === 'win32') {
        const m = /^(\d+)\|(\d*)\|(.*)$/.exec(linea);
        if (!m) return [];
        [pid, cpu, cmd] = [m[1], Number(m[2] || 0) / 1e7, m[3]];
      } else {
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(linea);
        if (!m) return [];
        [pid, cpu, cmd] = [m[1], segundosPs(m[2]), m[3]];
      }
      vistos.set(pid, cpu);
      return [{ pid, cpuDelta: cpuPrevia.has(pid) ? cpu - cpuPrevia.get(pid) : null, cmd }];
    });
    cpuPrevia.clear();
    for (const [pid, cpu] of vistos) cpuPrevia.set(pid, cpu);
  });
}
// Workers vivos: procesos `orq.ts trabajar <id> …` (el coordinador los lanza así, con cualquier motor).
const trabajadoresVivos = () => {
  const vivos = new Map(); // id → rol ('reviewer' gana si hay dos)
  for (const p of procesos) {
    const m = /orq\.ts\s+trabajar\s+(\d+)/.exec(p.cmd);
    if (!m) continue;
    const rol = /--rol\s+reviewer/.test(p.cmd) ? 'reviewer' : 'implementer';
    const id = Number(m[1]);
    if (vivos.get(id) !== 'reviewer') vivos.set(id, rol);
  }
  return vivos;
};
const normalizar = (s) => s.toLowerCase().replace(/\//g, '\\');

/** Último cambio en la carpeta del ticket (worktree y progress/tickets/<id>/) y si hay tests corriendo en ella. */
async function actividadDe(tdir, wt) {
  let ultima = mtimeRecursivo(tdir);
  let pruebas = false;
  if (existsSync(wt)) {
    const [gitDir, cambiados, nuevos, ct] = await Promise.all([
      git(['rev-parse', '--absolute-git-dir'], wt),
      git(['diff', '--name-only', 'HEAD'], wt),
      git(['ls-files', '--others', '--exclude-standard'], wt),
      git(['log', '-1', '--format=%ct'], wt),
    ]);
    ultima = Math.max(ultima, Number(ct ?? 0) * 1000);
    if (gitDir) ultima = Math.max(ultima, mtime(join(gitDir, 'index')), mtime(join(gitDir, 'logs', 'HEAD')));
    for (const f of [...(cambiados ?? '').split('\n'), ...(nuevos ?? '').split('\n')].filter(Boolean).slice(0, 400))
      ultima = Math.max(ultima, mtime(join(wt, f)));
    ultima = Math.max(ultima, ...ARTEFACTOS_PRUEBA.map((a) => mtime(join(wt, a))));
    const carpeta = normalizar(wt) + '\\';
    const cpu = procesos
      .filter((p) => p.cpuDelta !== null && normalizar(p.cmd).includes(carpeta) && TEST_RE.test(p.cmd))
      .reduce((total, p) => total + p.cpuDelta, 0);
    pruebas = cpu >= CPU_MIN_S;
    if (pruebas) ultima = Date.now();
  }
  const ahora = Date.now();
  return {
    actividad: ultima ? new Date(ultima).toISOString() : null,
    inactivoMin: ultima ? Math.max(0, Math.floor((ahora - ultima) / 60_000)) : null,
    pruebas,
    inactivo: ultima > 0 && ahora - ultima > ATASCADO_MS,
  };
}

async function faseDe(id, repo, cfg, eventos) {
  const fase = await faseBase(id, repo, cfg, eventos);
  const tdir = join(PROGRESS, 'tickets', String(id));
  const wt = join(RAIZ, 'worktrees', cfg.repos.get(repo)?.grupo ?? repo, String(id));
  const { inactivo, ...act } = await actividadDe(tdir, wt);
  const rolVivo = trabajadoresVivos().get(id) ?? null;
  const vivo = rolVivo !== null;
  // Un reviewer vivo es otro proceso: el ticket se ve «En revisión» (aparece el revisor junto al escritorio).
  if (rolVivo === 'reviewer' && !fase.done && fase.modo !== 'libre')
    return { ...fase, ...act, pct: Math.max(fase.pct, 65), fase: 'En revisión', modo: 'revisando', vivo, rolVivo, atascado: false };
  // «Trabajando» solo con un worker vivo o pruebas corriendo; sin eso el ticket está detenido (p. ej. tras un reinicio).
  if (['trabajando', 'revisando'].includes(fase.modo) && !vivo && !act.pruebas)
    return { ...fase, ...act, modo: 'detenido', fase: `Detenido · ${fase.fase}`, vivo, atascado: false };
  // Atascado: sin cambios en 20 min, sin pruebas corriendo y con el trabajo aún en manos del agente (antes de
  // aprobado). Lo aprobado o en QA espera a una persona, no al agente.
  return { ...fase, ...act, vivo, atascado: inactivo && !act.pruebas && !fase.done && fase.pct < 75 };
}

async function faseBase(id, repo, cfg, eventos) {
  const tdir = join(PROGRESS, 'tickets', String(id));
  const meta = leerJson(join(tdir, 'ticket.json')) ?? {};
  const titulo = String(meta.title ?? `Ticket ${id}`);
  const partes = titulo.split('·').map((s) => s.trim());
  const base = {
    grupo: cfg.repos.get(repo)?.grupo ?? repo,
    codigo: partes.length > 1 ? partes[0] : '',
    titulo: partes.at(-1) ?? titulo,
    talla: meta.talla ?? null,
    mas: 0,
    menos: 0,
    commits: 0,
  };
  if (!existsSync(tdir)) return { ...base, pct: 0, fase: 'Sin carpeta', modo: 'libre' };

  const delTicket = eventos.filter((e) => e.id === id);
  const delRepo = delTicket.filter((e) => !e.repo || e.repo === repo);
  const hito = [...delRepo].reverse().find((e) => ['iniciado', 'en-prueba', 'falló', 'aceptado', 'limpio'].includes(e.event));
  const ultimaPregunta = delTicket.findLast((e) => e.event === 'pregunta');
  const ultimaRespuesta = delTicket.findLast((e) => e.event === 'respondido');
  const pregunta = ultimaPregunta && (!ultimaRespuesta || ultimaRespuesta.at < ultimaPregunta.at);
  const ultimoTrabajo = delRepo.findLast((e) => e.event === 'trabajo');

  const repoCfg = cfg.repos.get(repo) ?? { grupo: repo, ramaBase: 'develop' };
  const wt = join(RAIZ, 'worktrees', repoCfg.grupo, String(id));
  const sobre = leerJson(join(tdir, 'sobre.json'));
  const baseRef = sobre?.ramas?.[repo] ?? `origin/${repoCfg.ramaBase}`;

  // Líneas y commits: lo confirmado contra la base más lo no confirmado.
  let ultimoCommit = 0;
  if (existsSync(wt)) {
    const [conf, sinConf, cuenta, ct, nuevas] = await Promise.all([
      git(['diff', '--shortstat', `${baseRef}...HEAD`], wt),
      git(['diff', '--shortstat', 'HEAD'], wt),
      git(['rev-list', '--count', `${baseRef}..HEAD`], wt),
      git(['log', '-1', '--format=%ct'], wt),
      lineasSinSeguimiento(wt),
    ]);
    const a = shortstat(conf);
    const b = shortstat(sinConf);
    base.mas = a.mas + b.mas + nuevas;
    base.menos = a.menos + b.menos;
    base.commits = Number(cuenta ?? 0) || 0;
    ultimoCommit = Number(ct ?? 0) * 1000;
  }
  const empujada = async () => {
    const rama = hito?.branch ?? (existsSync(wt) ? await git(['branch', '--show-current'], wt) : null);
    return rama ? (await git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${rama}`], existsSync(wt) ? wt : join(RAIZ, repo))) !== null : false;
  };

  const ultimo = ultimoTrabajo ? { rol: ultimoTrabajo.rol, motor: ultimoTrabajo.motor, resultado: ultimoTrabajo.resultado } : null;
  const con = (pct, fase, modo, extra = {}) => ({ ...base, pct, fase, modo, ultimo, ...extra });

  if (hito?.event === 'aceptado' || hito?.event === 'limpio')
    return con(100, hito.pr ? `Done · PR ${hito.pr}` : 'Done', 'libre', { done: true });
  if (hito?.event === 'en-prueba') {
    const push = await empujada();
    return con(92, push ? 'En QA · empujada' : 'En QA', 'libre');
  }

  const rdir = join(tdir, repo);
  const briefs = existsSync(rdir) ? readdirSync(rdir).filter((f) => /^brief-implementer-\d+\.md$/.test(f)) : [];
  const ultimoBrief = Math.max(0, ...briefs.map((f) => mtime(join(rdir, f))));
  const reviewTxt = leerTexto(join(rdir, 'review.md'));
  const reviewT = mtime(join(rdir, 'review.md'));
  const dictamen = /^DICTAMEN:\s*(APROBADO|CAMBIOS)/im.exec(reviewTxt)?.[1]?.toUpperCase();
  const implTxt = leerTexto(join(rdir, 'impl.md'));
  const implT = mtime(join(rdir, 'impl.md'));
  const estadoImpl = ESTADO_RE.exec(implTxt);
  const pendRev = join(rdir, 'reviewer-desktop.pendiente.json');
  const pendRevT = mtime(pendRev);
  const fallo = hito?.event === 'falló' ? Date.parse(hito.at) : 0;

  if (pregunta) return con(Math.max(20, Math.min(50, 20 + base.commits * 6)), 'Esperando respuesta', 'bloqueado', { pregunta: ultimaPregunta.note ?? '' });

  if (dictamen === 'APROBADO' && reviewT >= ultimoCommit - 1000 && reviewT > fallo) {
    const tags = (meta.tags ?? []).map((t) => String(t).toLowerCase());
    if (tags.includes(cfg.etiquetaListo.toLowerCase())) return con(85, 'Finish hecho', 'libre');
    return con(75, 'Aprobado', 'libre');
  }
  const revisando =
    (pendRevT && reviewT < pendRevT) ||
    (ultimoTrabajo?.rol === 'reviewer' && /PENDIENTE/.test(ultimoTrabajo.resultado ?? '') && reviewT < Date.parse(ultimoTrabajo.at));
  if (revisando) return con(65, 'En revisión', 'revisando');

  const implVigente = implT > ultimoBrief && implT > reviewT && implT > fallo;
  if (implVigente && estadoImpl?.[1] === 'LISTO') return con(55, 'Impl. LISTO', 'esperando');
  if (implVigente && estadoImpl?.[1] === 'BLOQUEADO')
    return con(
      Math.max(20, Math.min(50, 20 + base.commits * 6)),
      `Bloqueado · ${(/^TIPO_BLOQUEO:\s*(\S+)/m.exec(implTxt)?.[1] ?? estadoImpl[2].trim().slice(0, 30)) || 'sin detalle'}`,
      'bloqueado',
    );

  const corrigiendo = (dictamen === 'CAMBIOS' && reviewT > 0) || fallo > 0;
  if (existsSync(wt) && (base.commits > 0 || base.mas + base.menos > 0))
    return con(Math.min(50, 20 + base.commits * 6), corrigiendo ? 'Corrigiendo' : 'Programando', 'trabajando');
  if (briefs.length) return con(existsSync(wt) ? 20 : 15, corrigiendo ? 'Corrigiendo' : existsSync(wt) ? 'Arrancando' : 'Brief listo', 'trabajando');
  return con(5, 'Carpeta creada', 'trabajando');
}

/* ------------------------------------------------------------------ estado completo */

const ETIQUETA_EVENTO = {
  iniciado: 'iniciado',
  'en-prueba': 'a la rama de pruebas',
  aceptado: 'aceptado ✔',
  falló: 'falló en la prueba',
  pregunta: 'pregunta al jefe',
  respondido: 'respondido',
  limpio: 'limpio',
};

async function calcular() {
  leerProcesos();
  const cfg = config();
  const eventos = historial();
  const asignacion = leerJson(join(PROGRESS, 'oficina', 'agentes.json'));
  let lista = (asignacion?.agentes ?? agentesAutomaticos(cfg, eventos)).slice(0, MAX_AGENTES);
  if (asignacion) {
    const vivos = trabajadoresVivos();
    for (const id of vivos.keys()) {
      if (lista.some((a) => Number(a.ticket) === id)) continue;
      const repo = historial().findLast((e) => e.id === id && e.repo)?.repo;
      const libre = lista.findIndex((a) => a.ticket == null || !vivos.has(Number(a.ticket)));
      const nuevo = { nombre: `Agente ${libre < 0 ? lista.length + 1 : libre + 1}`, ticket: id, repo };
      if (libre >= 0) lista[libre] = nuevo;
      else if (lista.length < MAX_AGENTES) lista.push(nuevo);
    }
  }
  const agentes = await Promise.all(
    lista.map(async (a, i) => {
      const comun = { n: i + 1, nombre: a.nombre ?? `Agente ${i + 1}`, sesion: a.sesion ?? null, ticket: a.ticket ?? null, repo: a.repo ?? null };
      if (a.ticket == null) return { ...comun, pct: null, fase: 'Libre', modo: 'libre' };
      try {
        return { ...comun, ...(await faseDe(Number(a.ticket), a.repo ?? [...cfg.repos.keys()][0], cfg, eventos)) };
      } catch (e) {
        return { ...comun, pct: 0, fase: 'Sin datos', modo: 'libre', error: String(e?.message ?? e) };
      }
    }),
  );
  for (const a of agentes) a.falta = a.pct == null ? null : 100 - a.pct;

  const hoy = diaLocal(Date.now());
  const cerradosHoy = new Set(eventos.filter((e) => e.event === 'aceptado' && diaLocal(e.at) === hoy).map((e) => e.id)).size;
  const enQaHoy = new Set(eventos.filter((e) => e.event === 'en-prueba' && diaLocal(e.at) === hoy).map((e) => e.id)).size;
  const recientes = eventos.slice(-10).reverse().map((e) => {
    const hora = new Date(e.at).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: false });
    const que = e.event === 'trabajo' ? `${e.rol ?? ''} ${e.resultado ?? ''}`.trim() : ETIQUETA_EVENTO[e.event] ?? e.event;
    return `${hora} #${e.id} ${que}`;
  });

  return {
    actualizado: new Date().toISOString(),
    ola: cfg.ola,
    // Azure manda cuando ya respondió alguna vez; si no, lo que diga el historial local.
    cerradosHoy: azure.at ? azure.hoy : cerradosHoy,
    cerrados: { ...azure, fuente: azure.at ? 'azure' : 'historial', hoyLocal: cerradosHoy },
    enQaHoy,
    trabajando: agentes.filter((a) => ['trabajando', 'revisando'].includes(a.modo)).length,
    agentes,
    recientes,
    agentesDe: asignacion ? 'agentes.json' : 'tickets en curso',
    persona: cfg.persona ?? azure.persona ?? null,
    marca: cfg.marca,
    aviso: null,
  };
}

/* ------------------------------------------------------------------ cerrados en Azure (cada 5 min) */

const AZ_CADA_MS = 5 * 60_000;
// Por defecto, los tickets de quien tenga la sesión de az (@Me); OFICINA_AZ_USUARIO para mirar los de otra persona.
const AZ_USUARIO = process.env.OFICINA_AZ_USUARIO ? `'${process.env.OFICINA_AZ_USUARIO.replace(/'/g, "''")}'` : '@Me';
const ESTADOS_CERRADO = "'Done','Closed'";
const ESTADOS_EN_CURSO = "'Doing','Active','In Progress','Committed'";
const azure = { ok: null, at: null, intento: null, hoy: 0, semana: 0, listaHoy: [], listaSemana: [], doing: null, persona: null, error: null };

/** az.cmd solo lanza el python que trae Azure CLI: llamarlo directo evita las comillas de cmd. */
function comandoAz() {
  for (const dir of (process.env.PATH ?? '').split(';')) {
    if (!dir || !existsSync(join(dir, 'az.cmd'))) continue;
    const py = resolve(dir, '..', 'python.exe');
    if (existsSync(py)) return { exe: py, pre: ['-IBm', 'azure.cli'], shell: false };
  }
  return { exe: 'az', pre: [], shell: process.platform === 'win32' };
}
const AZ = comandoAz();

/** az en Windows escribe en cp1252: se intenta UTF-8 estricto y, si no cuadra, windows-1252. */
function decodificar(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

function az(args) {
  const final = AZ.shell ? args.map((a) => (/[\s'"<>|&^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
  return new Promise((ok, mal) => {
    execFile(
      AZ.exe,
      [...AZ.pre, ...final],
      { encoding: 'buffer', timeout: 90_000, windowsHide: true, maxBuffer: 8 << 20, shell: AZ.shell, env: { ...process.env, AZ_INSTALLER: 'MSI' } },
      (err, stdout, stderr) => {
        if (err) return mal(new Error(decodificar(stderr ?? Buffer.alloc(0)).trim().split('\n').at(-1) || err.message));
        try {
          ok(JSON.parse(decodificar(stdout)));
        } catch (e) {
          mal(new Error(`respuesta de az ilegible: ${e.message}`));
        }
      },
    );
  });
}

async function consulta(ado, condicion) {
  const wiql =
    `SELECT [System.Id],[System.Title],[Microsoft.VSTS.Common.StateChangeDate] FROM WorkItems ` +
    `WHERE [System.TeamProject]='${ado.project}' AND [System.AssignedTo]=${AZ_USUARIO} AND ${condicion} ` +
    `ORDER BY [Microsoft.VSTS.Common.StateChangeDate] DESC`;
  const filas = await az(['boards', 'query', '--wiql', wiql, '--org', ado.organization, '-o', 'json']);
  return (Array.isArray(filas) ? filas : []).map((f) => ({
    id: f.id ?? f.fields?.['System.Id'],
    titulo: String(f.fields?.['System.Title'] ?? ''),
    at: f.fields?.['Microsoft.VSTS.Common.StateChangeDate'] ?? null,
  }));
}
const cerradosDesde = (ado, desde) =>
  consulta(ado, `[System.State] IN (${ESTADOS_CERRADO}) AND [Microsoft.VSTS.Common.StateChangeDate] >= ${desde}`);
const porFecha = (a, b) => String(b.at ?? '').localeCompare(String(a.at ?? ''));

let consultandoAz = false;
async function consultarAzure() {
  if (consultandoAz) return;
  consultandoAz = true;
  azure.intento = new Date().toISOString();
  try {
    const cfg = config();
    if (!cfg.ados.length) throw new Error('orquestador.json no tiene proyectos con ado');
    const hoy = [], semana = [], doing = [];
    for (const ado of cfg.ados) {
      hoy.push(...(await cerradosDesde(ado, '@Today')));
      semana.push(...(await cerradosDesde(ado, '@Today - 7')));
      doing.push(...(await consulta(ado, `[System.State] IN (${ESTADOS_EN_CURSO})`)).map((x) => x.id));
    }
    if (!azure.persona && !cfg.persona) {
      // Sin local.json: el nombre sale de la cuenta de az (nombre.apellido@… -> Nombre).
      const cuenta = await az(['account', 'show', '-o', 'json']).catch(() => null);
      const nombre = String(cuenta?.user?.name ?? '').split('@')[0].split(/[._-]/)[0].replace(/\d+$/, '');
      azure.persona = mayuscula(nombre);
    }
    Object.assign(azure, {
      ok: true,
      at: new Date().toISOString(),
      error: null,
      hoy: hoy.length,
      semana: semana.length,
      listaHoy: hoy.sort(porFecha).slice(0, 50),
      listaSemana: semana.sort(porFecha).slice(0, 100),
      doing,
    });
    console.log(`Azure: ${hoy.length} cerrados hoy, ${semana.length} en la semana, ${doing.length} en curso`);
  } catch (e) {
    // Se queda el último valor bueno; el panel muestra «sin conexión».
    Object.assign(azure, { ok: false, error: String(e?.message ?? e).slice(0, 200) });
    console.log(`Azure sin conexión: ${azure.error}`);
  } finally {
    consultandoAz = false;
    await refrescar();
  }
}
let estado = { actualizado: null, agentes: [], recientes: [], cerradosHoy: 0 };
let calculando = false;
async function refrescar() {
  if (calculando) return;
  calculando = true;
  try {
    estado = await calcular();
  } catch (e) {
    estado = { ...estado, aviso: `Error al leer: ${e?.message ?? e}` };
  } finally {
    calculando = false;
  }
}
await refrescar();
setInterval(refrescar, CADA_MS);
consultarAzure();
setInterval(consultarAzure, AZ_CADA_MS);

/* ------------------------------------------------------------------ servidor */

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/estado.json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(estado));
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = await readFile(join(AQUI, 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    } catch {
      res.writeHead(500);
      return res.end('Falta oficina/index.html');
    }
  }
  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('No existe');
})
  .on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `El puerto ${PUERTO} está ocupado: usa --puerto N.` : e.message);
    process.exit(1);
  })
  .listen(PUERTO, '127.0.0.1', () => console.log(`Oficina en http://localhost:${PUERTO} · workspace ${RAIZ}`));

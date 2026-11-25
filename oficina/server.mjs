// Oficina pixel art del orquestador. Node 24, sin dependencias.
// Sirve index.html y /estado.json en http://localhost:4400 (--puerto N u OFICINA_PUERTO para otro).
// Lee el workspace (progress/, worktrees/, la config del orquestador), los procesos node y Azure cada 5 min. Solo
// escribe en progress/oficina/ (orden.json, prs.json, mascotas.json) y solo mata procesos node de worktrees/ cuando
// la persona lo confirma en la página. Las acciones (POST) exigen el token que lleva la página servida aquí.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crearAjustes } from './ajustes.mjs';
import { crearAvisos } from './avisos.mjs';
import { crearLinea } from './linea.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const ORQ = resolve(AQUI, '..');
const RAIZ = resolve(process.env.ORQ_WORKSPACE ?? join(ORQ, '..'));
const PROGRESS = join(RAIZ, 'progress');
// La config local (orquestador.json, local.json) no se versiona: si este código corre desde otra copia del repo (un
// worktree), se usa la del orquestador del workspace.
const ORQ_CFG = existsSync(join(ORQ, 'orquestador.json')) ? ORQ : join(RAIZ, 'orquestador');
const argumento = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const PUERTO = Number(argumento('puerto') ?? process.env.OFICINA_PUERTO) || 4400;
const MAX_AGENTES = 5;
const CADA_MS = 10_000;
const TOKEN = randomUUID();
const ajustes = crearAjustes(AQUI);
const GB = 1024 ** 3;
// El mismo tope de RAM que usa el orquestador para lanzar workers (src/ram.ts).
const RAM_TOPE_GB = Number(process.env.ORQ_RAM_MAX_GB ?? 11);

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
/** Escribe un JSON de forma atómica (archivo temporal y renombrar). */
function escribirJson(ruta, datos) {
  mkdirSync(dirname(ruta), { recursive: true });
  const tmp = `${ruta}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(datos, null, 2)}\n`);
  renameSync(tmp, ruta);
}
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
  const cfg = leerJson(join(ORQ_CFG, 'orquestador.json')) ?? {};
  const local = leerJson(join(ORQ_CFG, 'local.json')) ?? {};
  const repos = new Map();
  let etiquetaListo = 'orq-listo';
  for (const p of cfg.proyectos ?? []) {
    etiquetaListo = p.etiquetaListo ?? etiquetaListo;
    for (const r of p.repos ?? [])
      repos.set(r.dir, { grupo: r.worktrees ?? r.dir, ramaBase: p.ramaBase ?? 'develop', repository: r.repository ?? r.dir, ado: p.ado ?? null });
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
let procesos = []; // { pid, cpuDelta (s, null en la primera lectura), memMb, edadMin (null si no se sabe), cmd }
let procesosAt = 0;
let leyendo = null;
const cpuPrevia = new Map();
const segundosPs = (t) => {
  const [dias, resto] = t.includes('-') ? t.split('-') : ['0', t];
  return Number(dias) * 86_400 + resto.split(':').reduce((acc, x) => acc * 60 + Number(x), 0);
};
/** Lee los procesos node (como mucho cada 15 s, o ya con `forzar`). Devuelve la lista leída; nunca bloquea el refresco. */
function leerProcesos(forzar = false) {
  if (leyendo) return leyendo;
  if (!forzar && Date.now() - procesosAt < 15_000) return Promise.resolve(procesos);
  procesosAt = Date.now();
  const [exe, args] =
    process.platform === 'win32'
      ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { $c = if ($_.CreationDate) { [long]($_.CreationDate.ToUniversalTime() - [datetime]'1970-01-01').TotalMilliseconds } else { 0 }; '{0}|{1}|{2}|{3}|{4}' -f $_.ProcessId, ($_.UserModeTime + $_.KernelModeTime), $_.WorkingSetSize, $c, $_.CommandLine }`]]
      : ['ps', ['-eo', 'pid=,time=,etimes=,rss=,args=']];
  leyendo = new Promise((ok) => {
    execFile(exe, args, { encoding: 'buffer', timeout: 15_000, windowsHide: true, maxBuffer: 8 << 20 }, (err, stdout) => {
      leyendo = null;
      if (err) return ok(procesos);
      const vistos = new Map();
      const ahora = Date.now();
      procesos = decodificar(stdout).split(/\r?\n/).filter(Boolean).flatMap((linea) => {
        let pid, cpu, memMb, edadMin, cmd;
        if (process.platform === 'win32') {
          const m = /^(\d+)\|(\d*)\|(\d*)\|(\d*)\|(.*)$/.exec(linea);
          if (!m) return [];
          const creado = Number(m[4] || 0);
          [pid, cpu, memMb, edadMin, cmd] = [m[1], Number(m[2] || 0) / 1e7, Number(m[3] || 0) / 1024 ** 2, creado ? (ahora - creado) / 60_000 : null, m[5]];
        } else {
          const m = /^\s*(\d+)\s+(\S+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(linea);
          if (!m) return [];
          [pid, cpu, memMb, edadMin, cmd] = [m[1], segundosPs(m[2]), Number(m[4]) / 1024, Number(m[3]) / 60, m[5]];
        }
        vistos.set(pid, cpu);
        return [{ pid, cpuDelta: cpuPrevia.has(pid) ? cpu - cpuPrevia.get(pid) : null, memMb: Math.round(memMb), edadMin, cmd }];
      });
      cpuPrevia.clear();
      for (const [pid, cpu] of vistos) cpuPrevia.set(pid, cpu);
      ok(procesos);
    });
  });
  return leyendo;
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

/* ------------------------------------------------------------------ carga del PC, colgados y huérfanos */

const PREFIJO_WT = normalizar(join(RAIZ, 'worktrees')) + '\\';
/** Grupo y carpeta de worktrees/ que aparece en la línea de comando (`{ grupo: 'back', carpeta: '366' }`), o null. */
function ubicar(cmd) {
  const n = normalizar(cmd);
  const i = n.indexOf(PREFIJO_WT);
  if (i < 0) return null;
  const m = /^([^\\"'\s]+)\\([^\\"'\s]+)/.exec(n.slice(i + PREFIJO_WT.length));
  return m ? { grupo: m[1], carpeta: m[2] } : null;
}
const NOMBRE_PROCESO = /\b(jest-worker|jest|vitest|eslint|prettier|tsc|vite|playwright|nest|next|tsx|ts-node|pnpm)\b/i;
const nombreProceso = (cmd) => NOMBRE_PROCESO.exec(cmd)?.[1]?.toLowerCase() ?? 'node';
/** Procesos node de worktrees/ que la oficina puede llegar a matar: nunca la rama de pruebas (qa) ni el orquestador. */
const nodosDeWorktrees = () =>
  procesos.filter((p) => !/orq\.ts/.test(p.cmd)).map((p) => ({ ...p, u: ubicar(p.cmd) })).filter((p) => p.u && p.u.carpeta !== 'qa');
const describir = (p, motivo) => ({
  pid: Number(p.pid), ticket: p.u.carpeta, grupo: p.u.grupo, herramienta: nombreProceso(p.cmd),
  edadMin: p.edadMin == null ? null : Math.round(p.edadMin), memMb: p.memMb, motivo,
});

let muestraCpu = null;
let cpuLibre = null;
function medirCpu() {
  const t = cpus().map((c) => c.times);
  const total = t.reduce((s, x) => s + x.user + x.nice + x.sys + x.idle + x.irq, 0);
  const ocioso = t.reduce((s, x) => s + x.idle, 0);
  if (muestraCpu && total > muestraCpu.total) cpuLibre = Math.round(((ocioso - muestraCpu.ocioso) / (total - muestraCpu.total)) * 100);
  muestraCpu = { total, ocioso };
}
const redondo = (n) => Math.round(n * 10) / 10;
function cargaDelPc(aj) {
  medirCpu();
  const total = totalmem();
  const libre = freemem();
  const ramLibrePct = Math.round((libre / total) * 100);
  const ramUsadaGb = redondo((total - libre) / GB);
  const wt = procesos.filter((p) => ubicar(p.cmd));
  return {
    ramLibrePct, ramUsadaGb, ramTotalGb: redondo(total / GB), ramTopeGb: RAM_TOPE_GB, cpuLibrePct: cpuLibre,
    nodeTotal: procesos.length, nodeWorktrees: wt.length, memWorktreesGb: redondo(wt.reduce((s, p) => s + (p.memMb ?? 0), 0) / 1024),
    umbral: aj.carga, alta: ramLibrePct < aj.carga.ramLibreMinPct, sobreTope: ramUsadaGb > RAM_TOPE_GB,
  };
}

const LARGA_RE = /\b(jest|vitest|eslint)\b/i;
/** Por qué está quieto un ticket en curso, y qué hacer. Null si no está colgado. */
function colgadoDe(a, procs, cola, aj) {
  if (a.done || (a.pct ?? 0) >= 75) return null;
  const bloqueo = cola.bloqueados?.[String(a.ticket)];
  if (bloqueo) {
    const otro = /#?(\d{2,})/.exec(String(bloqueo))?.[1];
    return { causa: 'bloqueado', titulo: 'Bloqueado', detalle: String(bloqueo).slice(0, 120), accion: otro ? `Priorizar #${otro}` : 'Destrabar la dependencia' };
  }
  if (a.espera === 'negocio')
    return { causa: 'persona', titulo: 'Esperando a la persona', detalle: String(a.pregunta ?? '').slice(0, 160), accion: 'Responder su pregunta' };
  const largas = procs.filter((p) => LARGA_RE.test(p.cmd) && (p.edadMin ?? 0) >= aj.colgados.pruebasLargasMin).sort((x, y) => y.edadMin - x.edadMin);
  if (largas.length) {
    const p = largas[0];
    const quieto = p.cpuDelta !== null && p.cpuDelta < CPU_MIN_S ? ' sin gastar CPU' : '';
    return {
      causa: 'pruebas-largas', titulo: `Pruebas largas · ${Math.round(p.edadMin)} min`,
      detalle: `${nombreProceso(p.cmd)} (PID ${p.pid}) lleva ${Math.round(p.edadMin)} min${quieto}`, accion: `Matar el proceso ${p.pid}`, pid: Number(p.pid),
    };
  }
  if (!procs.length && !a.vivo && a.inactivoMin != null && a.inactivoMin >= aj.colgados.sinActividadMin) {
    const rol = a.modo === 'revisando' || a.modo === 'esperando' || /revisi/i.test(a.fase ?? '') ? 'reviewer' : 'implementer';
    return {
      causa: 'sin-trabajo', titulo: `Sin trabajo vivo · ${a.inactivoMin} min`,
      detalle: 'Ni procesos ni cambios en el ticket o su worktree: el worker (o el subagente que esperaba) ya no corre.',
      accion: `Pedirle al agente que relance el ${rol} en primer plano`,
    };
  }
  return null;
}

/** Node de worktrees/ sin agente activo en su ticket, o viejos sin que su ticket tenga una suite gastando CPU. */
function huerfanos() {
  const aj = ajustes();
  const nodos = nodosDeWorktrees();
  const cpuTicket = new Map();
  for (const p of nodos) cpuTicket.set(p.u.carpeta, (cpuTicket.get(p.u.carpeta) ?? 0) + (p.cpuDelta ?? 0));
  const activos = new Set(
    (estado.agentes ?? []).filter((a) => a.ticket != null && (a.vivo || a.pruebas || (a.inactivoMin ?? Infinity) < 5)).map((a) => String(a.ticket)),
  );
  for (const id of trabajadoresVivos().keys()) activos.add(String(id));
  return nodos.flatMap((p) => {
    const id = p.u.carpeta;
    if (!activos.has(id)) return [describir(p, 'su ticket no tiene agente activo')];
    if ((p.edadMin ?? 0) > aj.huerfanos.viejosMin && (cpuTicket.get(id) ?? 0) < CPU_MIN_S)
      return [describir(p, `${Math.round(p.edadMin)} min y ninguna suite en curso`)];
    return [];
  });
}

/** Mata, uno a uno y sin árbol (/T), solo los PID que están en `permitidos` en este momento. */
function matar(pids, permitidos) {
  const lista = new Map(permitidos.map((p) => [p.pid, p]));
  const hechos = [];
  const fallos = [];
  for (const pid of new Set((Array.isArray(pids) ? pids : []).map(Number))) {
    if (!lista.has(pid)) {
      fallos.push({ pid, error: 'ya no está en la lista' });
      continue;
    }
    try {
      process.kill(pid);
      hechos.push(lista.get(pid));
    } catch (e) {
      fallos.push({ pid, error: e?.code ?? String(e) });
    }
  }
  return { hechos, fallos };
}

/* ------------------------------------------------------------------ mascotas (solo visual) */

const TIPOS_MASCOTA = ['perro', 'gato', 'iguana', 'pecera', 'loro', 'hamster', 'tortuga', 'conejo'];
const NOMBRE_MASCOTA = { perro: 'Firulais', gato: 'Michi', iguana: 'Iggy', pecera: 'Nemo', loro: 'Lorenzo', hamster: 'Bolita', tortuga: 'Manuelita', conejo: 'Copito' };
const MAX_MASCOTAS = 3;
const RUTA_MASCOTAS = join(PROGRESS, 'oficina', 'mascotas.json');
function mascotas() {
  const m = leerJson(RUTA_MASCOTAS);
  return Array.isArray(m?.mascotas) ? m.mascotas.filter((x) => TIPOS_MASCOTA.includes(x.tipo)).slice(0, MAX_MASCOTAS) : [];
}
function cambiarMascotas({ accion, tipo, id } = {}) {
  const lista = mascotas();
  const ahora = new Date().toISOString();
  if (accion === 'poner') {
    if (!TIPOS_MASCOTA.includes(tipo)) throw new Error('Esa mascota no existe');
    if (lista.length >= MAX_MASCOTAS) throw new Error(`Máximo ${MAX_MASCOTAS} mascotas a la vez`);
    if (lista.some((m) => m.tipo === tipo)) throw new Error('Ya está en la oficina');
    lista.push({ id: randomUUID().slice(0, 8), tipo, nombre: NOMBRE_MASCOTA[tipo], desde: ahora, comio: ahora, acariciada: ahora });
  } else {
    const m = lista.find((x) => x.id === id);
    if (!m) throw new Error('Esa mascota ya no está');
    if (accion === 'quitar') lista.splice(lista.indexOf(m), 1);
    else if (accion === 'alimentar') m.comio = ahora;
    else if (accion === 'acariciar') m.acariciada = ahora;
    else throw new Error('Acción desconocida');
  }
  escribirJson(RUTA_MASCOTAS, { $comentario: 'Mascotas de la oficina (solo visual): las pone y las quita la página.', mascotas: lista });
  return lista;
}

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
    vueltas: 0,
    motor: null,
    motores: [],
    sync: null,
  };
  if (!existsSync(tdir)) return { ...base, pct: 0, fase: 'Sin carpeta', modo: 'libre' };

  const delTicket = eventos.filter((e) => e.id === id);
  const delRepo = delTicket.filter((e) => !e.repo || e.repo === repo);
  const hito = [...delRepo].reverse().find((e) => ['iniciado', 'en-prueba', 'falló', 'aceptado', 'limpio'].includes(e.event));
  const ultimaPregunta = delTicket.findLast((e) => e.event === 'pregunta');
  const ultimaRespuesta = delTicket.findLast((e) => e.event === 'respondido');
  const pregunta = ultimaPregunta && (!ultimaRespuesta || ultimaRespuesta.at < ultimaPregunta.at);
  const ultimoTrabajo = delRepo.findLast((e) => e.event === 'trabajo');
  // Vueltas: veces que el reviewer devolvió CAMBIOS desde el último inicio (como `rondasDeCambios` del orquestador).
  const desdeInicio = delRepo.slice(delRepo.findLastIndex((e) => e.event === 'iniciado') + 1);
  base.vueltas = desdeInicio.filter((e) => e.event === 'trabajo' && e.rol === 'reviewer' && e.resultado === 'CAMBIOS').length;
  // Motores del implementer en orden de uso (sin repetir): más de uno = el ticket escaló en la cadena.
  base.motores = [...new Set(desdeInicio.filter((e) => e.event === 'trabajo' && e.rol === 'implementer' && e.motor && e.motor !== 'orquestador').map((e) => e.motor))];
  base.motor = [...desdeInicio].reverse().find((e) => e.event === 'trabajo' && e.motor && e.motor !== 'orquestador')?.motor ?? null;

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
    // Sincronía con la base: commits de la base que la rama no tiene. Un CONFLICTO sin resolver lo registra `trabajar`.
    const atras = Number(await git(['rev-list', '--count', `HEAD..${baseRef}`], wt)) || 0;
    const ultTrabajoSync = delRepo.findLast((e) => e.event === 'trabajo' && e.rol === 'implementer' && e.resultado !== 'SIN_CUOTA');
    const ultConflicto = delRepo.findLast((e) => e.event === 'trabajo' && e.resultado === 'CONFLICTO');
    const conflicto = Boolean(ultConflicto && (!ultTrabajoSync || ultTrabajoSync.at < ultConflicto.at));
    base.sync = { atras, conflicto };
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

  if (pregunta) return con(Math.max(20, Math.min(50, 20 + base.commits * 6)), 'Esperando respuesta', 'bloqueado', { pregunta: ultimaPregunta.note ?? '', espera: 'negocio' });

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
  if (implVigente && estadoImpl?.[1] === 'BLOQUEADO') {
    const tipo = /^TIPO_BLOQUEO:\s*(\S+)/m.exec(implTxt)?.[1] ?? estadoImpl[2].trim().slice(0, 30);
    return con(Math.max(20, Math.min(50, 20 + base.commits * 6)), `Bloqueado · ${tipo || 'sin detalle'}`, 'bloqueado', {
      pregunta: (/^PREGUNTA:\s*(.+)$/m.exec(implTxt)?.[1] ?? '').slice(0, 300),
      espera: tipo || 'bloqueo',
    });
  }

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

  const aj = ajustes();
  const carga = cargaDelPc(aj);
  const cola = leerJson(join(PROGRESS, 'oficina', 'cola.json')) ?? {};
  for (const a of agentes) {
    if (a.ticket == null) continue;
    const grupo = String(cfg.repos.get(a.repo)?.grupo ?? a.grupo ?? a.repo ?? '').toLowerCase();
    const procs = procesos.filter((p) => {
      const u = ubicar(p.cmd);
      return u && u.grupo === grupo && u.carpeta === String(a.ticket);
    });
    a.nodos = procs.length;
    a.memMb = procs.reduce((s, p) => s + (p.memMb ?? 0), 0);
    a.suda = a.nodos > aj.carga.nodePorAgenteMax || (carga.alta && a.nodos > 0);
    a.colgado = colgadoDe(a, procs, cola, aj);
  }
  avisos.revisarAgentes(agentes);

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
    carga,
    cola: { proximos: cola.proximos ?? [], bloqueados: cola.bloqueados ?? {}, pendientePr: cola.pendiente_pr ?? {} },
    develop: avisos.develop,
    avisos: avisos.estado(),
    orden: leerJson(join(PROGRESS, 'oficina', 'orden.json')),
    mascotas: mascotas(),
    // Lo último que pasó, para las reacciones de la escena (el loro repite los dictámenes, el perro celebra los PR).
    dictamenes: eventos.filter((e) => e.event === 'trabajo' && e.rol === 'reviewer' && /^(APROBADO|CAMBIOS)$/.test(e.resultado ?? ''))
      .slice(-10).map((e) => ({ id: e.id, at: e.at, resultado: e.resultado })),
    aceptados: eventos.filter((e) => e.event === 'aceptado').slice(-10).map((e) => ({ id: e.id, at: e.at })),
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
          // `az boards query` sin resultados no imprime nada (ni `[]`): es una lista vacía, no un error.
          const texto = decodificar(stdout).trim();
          ok(texto ? JSON.parse(texto) : []);
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
    // Una sola consulta de los cerrados (con un día de colchón) y el corte de «hoy» y «semana» se hace aquí, con el
    // día local: `@Today` de Azure usa la zona de la organización (UTC) y a media tarde ya es «mañana» allí.
    const cerrados = [], doing = [];
    for (const ado of cfg.ados) {
      cerrados.push(...(await cerradosDesde(ado, '@Today - 8')));
      doing.push(...(await consulta(ado, `[System.State] IN (${ESTADOS_EN_CURSO})`)).map((x) => x.id));
    }
    const inicioHoy = new Date().setHours(0, 0, 0, 0);
    const hoy = cerrados.filter((x) => x.at && new Date(x.at).getTime() >= inicioHoy);
    const semana = cerrados.filter((x) => x.at && new Date(x.at).getTime() >= inicioHoy - 7 * 86_400_000);
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
const avisos = crearAvisos({ ajustes, az, log: (m) => console.log(m) });
const linea = crearLinea({ PROGRESS, leerJson, escribirJson, az, repoCfg: (dir) => config().repos.get(dir) });
async function vigilarDevelop() {
  await avisos.revisarDevelop(config().ados);
  setTimeout(vigilarDevelop, Math.max(5, Number(ajustes().develop?.cadaMin) || 15) * 60_000);
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
setTimeout(vigilarDevelop, 20_000);

/* ------------------------------------------------------------------ servidor */

const json = (res, codigo, datos) => {
  res.writeHead(codigo, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(datos));
};
async function cuerpo(req) {
  let texto = '';
  for await (const trozo of req) {
    texto += trozo;
    if (texto.length > 64 * 1024) throw new Error('Petición demasiado grande');
  }
  return texto ? JSON.parse(texto) : {};
}
// Solo se atiende a localhost (evita que otra página use la oficina por DNS rebinding) y las acciones exigen el token
// de la página: un sitio ajeno no puede leerlo ni mandar la cabecera sin que el navegador lo bloquee.
const HOST_OK = /^(localhost|127\.0\.0\.1)(:\d+)?$/;
const ORIGEN_OK = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const ESTATICOS = { '/panel.js': 'text/javascript; charset=utf-8', '/mascotas.js': 'text/javascript; charset=utf-8' };
const FRASE = { pausar: 'pausa todos los agentes', reanudar: 'reanuda todos los agentes' };
function orden(accion, extra = {}) {
  const datos = { accion, fecha: new Date().toISOString(), origen: 'oficina', ...extra };
  escribirJson(join(PROGRESS, 'oficina', 'orden.json'), datos);
  return { ...datos, frase: FRASE[accion], nota: 'La oficina no controla las sesiones de los agentes: pégale la frase al coordinador.' };
}

async function api(req, res, url) {
  const ruta = `${req.method} ${url.pathname}`;
  if (req.method === 'POST') {
    const origen = req.headers.origin;
    if ((origen && !ORIGEN_OK.test(origen)) || req.headers['x-oficina-token'] !== TOKEN) return json(res, 403, { error: 'Token inválido: recarga la página.' });
  }
  switch (ruta) {
    case 'GET /api/huerfanos':
      await leerProcesos(true);
      return json(res, 200, { lista: huerfanos(), viejosMin: ajustes().huerfanos.viejosMin });
    case 'POST /api/huerfanos/matar': {
      const { pids } = await cuerpo(req);
      await leerProcesos(true);
      return json(res, 200, matar(pids, huerfanos()));
    }
    case 'GET /api/pausar':
      await leerProcesos(true);
      return json(res, 200, { lista: nodosDeWorktrees().map((p) => describir(p, 'pausa')), frase: FRASE.pausar });
    case 'POST /api/pausar': {
      const { pids } = await cuerpo(req);
      await leerProcesos(true);
      const r = matar(pids, nodosDeWorktrees().map((p) => describir(p, 'pausa')));
      return json(res, 200, { ...r, ...orden('pausar', { procesosTerminados: r.hechos.length }) });
    }
    case 'POST /api/reanudar':
      return json(res, 200, orden('reanudar'));
    case 'POST /api/procesos/matar': {
      // Un proceso concreto (p. ej. la acción sugerida de «pruebas largas»): solo si es un node de worktrees/.
      const { pids } = await cuerpo(req);
      await leerProcesos(true);
      return json(res, 200, matar(pids, nodosDeWorktrees().map((p) => describir(p, 'a pedido'))));
    }
    case 'GET /api/linea': {
      const id = Number(url.searchParams.get('ticket'));
      const repo = url.searchParams.get('repo') ?? '';
      if (!Number.isInteger(id) || id <= 0 || !config().repos.has(repo)) return json(res, 400, { error: 'ticket o repo inválido' });
      return json(res, 200, await linea.lineaDe(id, repo, historial(), azure.listaSemana ?? []));
    }
    case 'GET /api/mascotas':
      return json(res, 200, { mascotas: mascotas(), tipos: TIPOS_MASCOTA, max: MAX_MASCOTAS });
    case 'POST /api/mascotas':
      try {
        const lista = cambiarMascotas(await cuerpo(req));
        estado = { ...estado, mascotas: lista };
        return json(res, 200, { mascotas: lista });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    case 'POST /api/avisos/probar':
      if (!avisos.estado().configurado) return json(res, 400, { error: 'Los avisos están apagados: falta el tema en oficina/config.local.json.' });
      return json(res, 200, { enviado: await avisos.enviar('Prueba de la oficina') });
    default:
      return json(res, 404, { error: 'No existe' });
  }
}

createServer(async (req, res) => {
  if (!HOST_OK.test(String(req.headers.host ?? ''))) {
    res.writeHead(403);
    return res.end();
  }
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
  } catch (e) {
    return json(res, 500, { error: String(e?.message ?? e) });
  }
  if (url.pathname === '/estado.json') return json(res, 200, estado);
  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      const html = (await readFile(join(AQUI, 'index.html'), 'utf8')).replace('__OFICINA_TOKEN__', TOKEN);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html);
    } catch {
      res.writeHead(500);
      return res.end('Falta oficina/index.html');
    }
  }
  if (ESTATICOS[url.pathname]) {
    try {
      const js = await readFile(join(AQUI, url.pathname.slice(1)));
      res.writeHead(200, { 'content-type': ESTATICOS[url.pathname], 'cache-control': 'no-store' });
      return res.end(js);
    } catch {
      res.writeHead(404);
      return res.end();
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

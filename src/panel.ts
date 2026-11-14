/**
 * El panel del orquestador en el navegador. Corre en tu máquina y solo escucha en 127.0.0.1:
 *   node orquestador/orq.ts tablero --servir [--puerto 4321]
 *
 * Al recargar lee el historial, las preguntas, la rama de pruebas y tus tickets asignados, así que
 * siempre está al día. Desde la página respondes las preguntas de los workers; lo demás (aceptar o
 * rechazar una prueba) se copia como comando para el coordinador.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { prStatus, prUrl, prsPorRama, ticketUrl } from './ado.ts';
import { WORKSPACE, loadConfig, type Config, type ProyectoCfg } from './config.ts';
import { cmdResponder, pendientesData } from './conversacion.ts';
import { capacidad } from './doctor.ts';
import { boardState, readHistory } from './historial.ts';
import { planData, proyectoPorNombre } from './tickets.ts';
import { CliError } from './util.ts';
import { guiaData } from './vistas.ts';
import { CAPTURA_VALIDA, capturasDir, leerValidacion } from './validacion.ts';

const CACHE_MS = 20_000;

/** La etiqueta corta de un repo para la página: la primera de sus etiquetas (Backend, Frontend…). */
function etiquetaRepo(cfg: Config, dir: string | undefined): string {
  if (!dir || dir === '—') return 'ticket';
  for (const p of cfg.proyectos) {
    const repo = p.repos.find((r) => r.dir === dir);
    if (repo) return repo.etiquetas[0] ?? repo.dir;
  }
  return dir;
}

function seguro<T>(fallas: string[], que: string, fn: () => T, vacio: T): T {
  try {
    return fn();
  } catch (error) {
    fallas.push(`${que}: ${(error as Error).message.split('\n')[0]}`);
    return vacio;
  }
}

/** Todo lo que muestra la página. Cada sección que falla se informa aparte; las demás salen igual. */
export function datos(cfg: Config) {
  const fallas: string[] = [];
  const proyecto = (nombre?: string) => (nombre ? proyectoPorNombre(cfg, nombre) : cfg.proyectos[0]);
  const historial = readHistory();
  // Estado de los PR: una lista por repo en vez de un `az` por ticket aceptado (cada uno tarda casi 2 s).
  const estados = new Map<string, Map<number, string> | null>();
  const estadoPr = (p: ProyectoCfg, repository: string, prId: number): string => {
    const clave = `${p.nombre}/${repository}`;
    if (!estados.has(clave)) {
      const prs = prsPorRama(p, repository);
      estados.set(clave, prs ? new Map([...prs.values()].map((pr) => [pr.pullRequestId, pr.status])) : null);
    }
    const lista = estados.get(clave);
    return lista ? (lista.get(prId) ?? prStatus(p, prId)) : '?';
  };
  const tickets = boardState(historial).map((t) => {
    const p = proyecto(t.proyecto);
    const repo = p.repos.find((r) => r.dir === t.repo);
    const aceptado = t.state === 'aceptado' && t.pr && repo;
    return {
      ...t,
      repoLabel: etiquetaRepo(cfg, t.repo),
      url: ticketUrl(p, t.id),
      carpeta: t.cleaned || !repo ? null : join(WORKSPACE, `${repo.dir}--${t.id}`),
      prUrl: aceptado ? prUrl(p, repo.repository, t.pr!) : null,
      prStatus: aceptado ? estadoPr(p, repo.repository, t.pr!) : null,
      validacion: repo ? leerValidacion(t.id, repo) : null,
    };
  });
  const titulos = new Map(tickets.map((t) => [t.id, t.title]));
  const vacioGuia = { rama: cfg.qa ? `qa/${cfg.qa}` : '', levantar: [], tareas: [] };
  const guia = cfg.qa ? seguro(fallas, 'la rama de pruebas', () => guiaData(cfg), vacioGuia) : vacioGuia;
  return {
    generado: new Date().toISOString(),
    marca: { nombre: cfg.marca.nombre, sigla: cfg.marca.sigla },
    proyectos: cfg.proyectos.map((p) => p.ado.project),
    rama: cfg.qa ? `qa/${cfg.qa}` : null,
    capacidad: capacidad(cfg.ola),
    tickets,
    historial: historial
      .slice(-300)
      .reverse()
      .map((e) => ({ ...e, repoLabel: etiquetaRepo(cfg, e.repo), title: titulos.get(e.id) ?? '', url: ticketUrl(proyecto(e.proyecto), e.id) })),
    preguntas: seguro(fallas, 'las preguntas', () => pendientesData(cfg), []),
    probar: {
      levantar: guia.levantar.map((l) => ({ ...l, repoLabel: etiquetaRepo(cfg, l.repo) })),
      tareas: guia.tareas.map((t) => ({ ...t, repoLabel: etiquetaRepo(cfg, t.repo) })),
    },
    plan: seguro(fallas, 'tus tickets de Azure', () => planData(cfg), []).map((f) => ({
      ...f,
      repoLabels: f.repos.map((r) => etiquetaRepo(cfg, r)),
    })),
    fallas,
  };
}

/* --------------------------------------------------------------------- servidor */

function enviar(res: ServerResponse, status: number, type: string, body: string | Buffer): void {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(body);
}

function leerCuerpo(req: IncomingMessage): Promise<string> {
  return new Promise((done, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 20_000) reject(new Error('demasiado largo'));
    });
    req.on('end', () => done(body));
  });
}

/** El monograma de la marca (la sigla en un cuadro redondeado), en versión clara u oscura. */
export function monograma(sigla: string, oscuro: boolean): string {
  const fondo = oscuro ? '#e8ebf1' : '#121826';
  const letra = oscuro ? '#121826' : '#ffffff';
  const texto = sigla.replace(/[^\p{L}\p{N}]/gu, '').slice(0, 3).toUpperCase();
  const size = texto.length > 2 ? 21 : 27;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img" aria-label="${texto}"><rect x="2" y="2" width="60" height="60" rx="16" fill="${fondo}"/><text x="32" y="42" text-anchor="middle" font-family="'Inter','Segoe UI',system-ui,sans-serif" font-weight="800" font-size="${size}" letter-spacing="-1" fill="${letra}">${texto}</text></svg>`;
}

type Opciones = { token?: string; cargarConfig?: () => Config; leerDatos?: (cfg: Config) => unknown };

/**
 * El servidor del panel. El token va en la página y lo exige cada escritura: así otra pestaña o un
 * sitio externo no puede responder por ti aunque sepa el puerto.
 */
export function crearServidor({ token = randomBytes(16).toString('hex'), cargarConfig = loadConfig, leerDatos = datos }: Opciones = {}): Server {
  let cache: { at: number; data: unknown } | null = null;
  const obtener = (fresco: boolean) => {
    if (!fresco && cache && Date.now() - cache.at < CACHE_MS) return cache.data;
    const data = leerDatos(cargarConfig());
    cache = { at: Date.now(), data };
    return data;
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const cfg = cargarConfig();
      if (req.method === 'GET' && url.pathname === '/') return enviar(res, 200, 'text/html; charset=utf-8', pagina(token, cfg));
      if (req.method === 'GET' && url.pathname === '/api/datos')
        return enviar(res, 200, 'application/json; charset=utf-8', JSON.stringify(obtener(url.searchParams.has('fresco'))));
      if (req.method === 'POST' && url.pathname === '/api/responder') {
        if (req.headers['x-token'] !== token) return enviar(res, 403, 'text/plain; charset=utf-8', 'Token inválido');
        const { id, texto } = JSON.parse(await leerCuerpo(req)) as { id?: unknown; texto?: unknown };
        const respuesta = typeof texto === 'string' ? texto.trim() : '';
        if (!Number.isInteger(id) || !respuesta) return enviar(res, 400, 'text/plain; charset=utf-8', 'Falta el ticket o la respuesta');
        cmdResponder(cfg, id as number, { text: respuesta });
        cache = null;
        return enviar(res, 200, 'application/json', JSON.stringify({ ok: true }));
      }
      // Capturas de la validación IA: /captura/<id>/<repo>/<archivo>, solo de repos configurados y sin rutas.
      const captura = /^\/captura\/(\d+)\/([\w.-]+)\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && captura) {
        const [, id, dir, archivo] = captura;
        const repo = cfg.proyectos.flatMap((p) => p.repos).find((r) => r.dir === dir);
        const path = repo && CAPTURA_VALIDA.test(archivo) ? join(capturasDir(Number(id), repo), archivo) : null;
        if (!path || !existsSync(path)) return enviar(res, 404, 'text/plain; charset=utf-8', 'No existe');
        const tipo = /\.png$/i.test(archivo) ? 'image/png' : /\.webp$/i.test(archivo) ? 'image/webp' : 'image/jpeg';
        res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'max-age=60', 'X-Content-Type-Options': 'nosniff' });
        return res.end(readFileSync(path));
      }
      if (req.method === 'GET' && (url.pathname === '/logo.svg' || url.pathname === '/logo-oscuro.svg')) {
        const oscuro = url.pathname === '/logo-oscuro.svg';
        const propio = oscuro ? (cfg.marca.logoOscuro ?? cfg.marca.logo) : cfg.marca.logo;
        const path = propio ? join(WORKSPACE, propio) : null;
        const svg = path && existsSync(path) ? readFileSync(path) : monograma(cfg.marca.sigla, oscuro);
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=3600' });
        return res.end(svg);
      }
      return enviar(res, 404, 'text/plain; charset=utf-8', 'No existe');
    } catch (error) {
      const status = error instanceof CliError ? 400 : 500;
      return enviar(res, status, 'text/plain; charset=utf-8', (error as Error).message);
    }
  });
}

export function servir(puerto = 4321): Server {
  const cfg = loadConfig();
  const server = crearServidor();
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      process.stderr.write(`[FAIL] El puerto ${puerto} está ocupado: usa --puerto <otro>\n`);
      process.exit(1);
    }
    throw error;
  });
  server.listen(puerto, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : puerto;
    process.stdout.write(`Panel de ${cfg.marca.nombre} en http://localhost:${port} (${cfg.proyectos.map((p) => p.ado.project).join(', ')}). Ctrl+C para cerrarlo.\n`);
  });
  return server;
}

/* ---------------------------------------------------------------------- página */

const ICONOS = {
  tema: '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9z"/></svg>',
  actualizar:
    '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/></svg>',
};

const escapar = (text: string) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function pagina(token: string, cfg: Config): string {
  const nombre = escapar(cfg.marca.nombre);
  const proyectos = escapar(cfg.proyectos.map((p) => p.ado.project).join(', '));
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="orq-token" content="${token}">
<title>Panel · ${nombre}</title>
<link rel="icon" href="/logo.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..800&display=swap">
<style>${ESTILOS}</style>
</head>
<body>
<a class="saltar" href="#contenido">Saltar al contenido</a>
<header class="barra">
  <div class="barra-in">
    <div class="marca">
      <img class="iso claro" src="/logo.svg" alt="" width="30" height="30">
      <img class="iso oscuro" src="/logo-oscuro.svg" alt="" width="30" height="30">
      <div>
        <div class="marca-nombre">${nombre}</div>
        <div class="marca-sub">${proyectos} · <span id="rama">qa/…</span></div>
      </div>
    </div>
    <div class="barra-acciones">
      <span class="actualizado" id="actualizado" aria-live="polite">Cargando…</span>
      <button class="btn btn-icono" id="tema" type="button" aria-label="Cambiar entre modo claro y oscuro" title="Modo claro u oscuro">${ICONOS.tema}</button>
      <button class="btn btn-primario" id="actualizar" type="button">${ICONOS.actualizar}Actualizar</button>
    </div>
  </div>
  <nav class="pestanas" role="tablist" aria-label="Secciones">
    <button role="tab" id="tab-pendientes" aria-controls="pendientes" aria-selected="true">Pendientes <span class="contador" id="n-pendientes" hidden></span></button>
    <button role="tab" id="tab-plan" aria-controls="plan" aria-selected="false">Plan <span class="contador tenue" id="n-plan" hidden></span></button>
    <button role="tab" id="tab-tablero" aria-controls="tablero" aria-selected="false">Tablero</button>
    <button role="tab" id="tab-historial" aria-controls="historial" aria-selected="false">Historial</button>
  </nav>
</header>

<main id="contenido">
  <section id="pendientes" role="tabpanel" aria-labelledby="tab-pendientes">
    <p class="resumen" id="resumen">Cargando lo que te toca…</p>
    <div id="avisos"></div>

    <section class="paso" aria-labelledby="t-responde">
      <div class="paso-cab">
        <span class="paso-n" aria-hidden="true">1</span>
        <div>
          <h2 id="t-responde">Responde</h2>
          <p class="ayuda">Un worker necesita una decisión tuya. Ese ticket espera; los demás siguen.</p>
        </div>
      </div>
      <div class="lista" id="preguntas"></div>
    </section>

    <section class="paso" aria-labelledby="t-prueba">
      <div class="paso-cab">
        <span class="paso-n" aria-hidden="true">2</span>
        <div>
          <h2 id="t-prueba">Prueba</h2>
          <p class="ayuda">Lo aprobado ya está en tu rama de pruebas. Levántalo, revisa cada tarea y dile al coordinador cómo te fue.</p>
        </div>
      </div>
      <div id="levantar"></div>
      <div class="plegar" id="plegar-probar"></div>
      <div class="lista" id="probar"></div>
    </section>
  </section>

  <section id="plan" role="tabpanel" aria-labelledby="tab-plan" hidden>
    <p class="resumen" id="resumen-plan">Tus tickets asignados</p>
    <p class="ayuda ayuda-plan">Repos, talla y motores de cada ticket. El coordinador los fija con <code>/planear</code>; la ola solo toma los planeados.</p>
    <div class="segmentos" id="filtros-plan" role="group" aria-label="Filtrar por estado del plan"></div>
    <div class="lista" id="lista-plan"></div>
  </section>

  <section id="tablero" role="tabpanel" aria-labelledby="tab-tablero" hidden>
    <div class="plegar" id="plegar-tablero"></div>
    <div class="kanban" id="kanban"></div>
  </section>

  <section id="historial" role="tabpanel" aria-labelledby="tab-historial" hidden>
    <div class="segmentos" id="filtros" role="group" aria-label="Filtrar por repo"></div>
    <ol class="linea" id="linea"></ol>
  </section>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<dialog class="visor" id="visor" aria-label="Captura de la validación IA">
  <form method="dialog"><button class="btn cerrar" aria-label="Cerrar">Cerrar</button></form>
  <img id="visor-img" alt="">
  <p id="visor-texto"></p>
</dialog>
<script>${SCRIPT}</script>
</body>
</html>`;
}

const ESTILOS = `
:root {
  color-scheme: light;
  --bg: #f5f7fa; --surface: #ffffff; --surface-2: #f0f3f8; --hover: #e9eef6;
  --text: #121826; --muted: #5a6475; --hairline: #e8ecf2;
  --primary: #1d4ed8; --primary-hover: #1e40af; --primary-fg: #ffffff; --primary-soft: #e9f0ff; --ring: #3b82f6;
  --warning: #8a5300; --warning-soft: #fff3df; --danger: #b42318; --danger-soft: #fdeceb;
  --success: #1c7a4b; --success-soft: #e6f5ed; --neutral: #5a6475; --neutral-soft: #edf0f5;
  --info: #1d4ed8; --info-soft: #e9f0ff;
  --shadow: 0 1px 2px rgb(15 23 42 / 0.04), 0 6px 20px rgb(15 23 42 / 0.05);
  --r-sm: 8px; --r: 12px; --r-lg: 16px;
}
.dark {
  color-scheme: dark;
  --bg: #0d1015; --surface: #161a21; --surface-2: #1d222b; --hover: #232a35;
  --text: #e8ebf1; --muted: #a2abba; --hairline: #232933;
  --primary: #7aa2ff; --primary-hover: #9ab8ff; --primary-fg: #0d1015; --primary-soft: #1b2740; --ring: #7aa2ff;
  --warning: #f0c060; --warning-soft: #2a2314; --danger: #f29b8f; --danger-soft: #2d1a18;
  --success: #6fd3a0; --success-soft: #13281f; --neutral: #a2abba; --neutral-soft: #1d222b;
  --info: #7aa2ff; --info-soft: #1b2740;
  --shadow: 0 1px 2px rgb(0 0 0 / 0.5);
}
* { box-sizing: border-box; }
html { background: var(--bg); }
body { margin: 0; font: 15px/1.55 'Inter', ui-sans-serif, system-ui, 'Segoe UI', sans-serif; font-optical-sizing: auto; color: var(--text); background: var(--bg); -webkit-font-smoothing: antialiased; }
a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; text-decoration-color: var(--primary); text-underline-offset: 3px; }
:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; border-radius: 6px; }
.saltar { position: absolute; left: -999px; } .saltar:focus { left: 16px; top: 8px; background: var(--surface); padding: 6px 10px; z-index: 10; }
code, .mono { font-family: Consolas, ui-monospace, 'SF Mono', monospace; font-size: 13px; }

/* barra */
.barra { background: var(--surface); position: sticky; top: 0; z-index: 5; box-shadow: 0 1px 0 var(--hairline); }
.barra-in, .pestanas, main { max-width: 1120px; margin: 0 auto; padding-left: 32px; padding-right: 32px; }
.barra-in { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; padding-top: 18px; padding-bottom: 14px; }
.marca { display: flex; align-items: center; gap: 12px; }
.marca-nombre { font-weight: 700; font-size: 17px; letter-spacing: -0.01em; line-height: 1.2; }
.marca-sub { font-size: 13px; color: var(--muted); }
.marca-sub span { font-family: Consolas, ui-monospace, monospace; font-size: 12.5px; }
.iso.oscuro, .dark .iso.claro { display: none; } .dark .iso.oscuro { display: block; }
.barra-acciones { display: flex; align-items: center; gap: 8px; }
.actualizado { font-size: 13px; color: var(--muted); margin-right: 8px; }
.pestanas { display: flex; gap: 28px; overflow-x: auto; }
.pestanas button { font: inherit; font-size: 14px; font-weight: 600; background: none; border: 0; padding: 10px 0 12px; color: var(--muted); box-shadow: inset 0 -2px 0 transparent; cursor: pointer; display: inline-flex; gap: 8px; align-items: center; white-space: nowrap; }
.pestanas button:hover { color: var(--text); }
.pestanas button[aria-selected=true] { color: var(--text); box-shadow: inset 0 -2px 0 var(--primary); }
.contador { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 999px; background: var(--primary); color: var(--primary-fg); font-size: 12px; font-weight: 700; display: inline-grid; place-items: center; }
.contador.tenue { background: var(--warning-soft); color: var(--warning); }

/* botones */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 36px; padding: 0 14px; border-radius: var(--r-sm); border: 0; background: var(--surface-2); color: var(--text); font: inherit; font-size: 14px; font-weight: 600; cursor: pointer; transition: background .15s; white-space: nowrap; }
.btn:hover { background: var(--hover); }
.btn-primario { background: var(--primary); color: var(--primary-fg); }
.btn-primario:hover { background: var(--primary-hover); }
.btn-icono { width: 36px; padding: 0; background: transparent; color: var(--muted); }
.btn-icono:hover { color: var(--text); }
.btn-texto { background: transparent; color: var(--primary); height: auto; padding: 2px 4px; font-size: 13px; }
.btn-texto:hover { background: var(--primary-soft); }
.btn[disabled] { opacity: .55; cursor: progress; }

main { padding-top: 36px; padding-bottom: 96px; }
.resumen { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; margin: 0 0 8px; }
.resumen .tenue { color: var(--muted); font-weight: 500; }
#avisos .nota-aviso { font-size: 13px; color: var(--muted); margin: 0 0 8px; }

/* pasos */
.paso { margin-top: 44px; }
.paso-cab { display: flex; gap: 14px; align-items: flex-start; margin-bottom: 18px; }
.paso-n { width: 28px; height: 28px; border-radius: 50%; background: var(--primary-soft); color: var(--primary); font-weight: 700; font-size: 14px; display: grid; place-items: center; flex: none; margin-top: 1px; }
h2 { font-size: 18px; margin: 0; letter-spacing: -0.01em; }
.ayuda { margin: 2px 0 0; color: var(--muted); font-size: 14px; max-width: 64ch; }
.ayuda-plan { margin-bottom: 20px; }
.lista { display: grid; gap: 16px; }

/* tarjetas: superficie y sombra suave, sin bordes */
.tarjeta { background: var(--surface); border-radius: var(--r-lg); padding: 22px 24px; box-shadow: var(--shadow); }
.encabezado { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }
.repo { font-size: 11.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
.titulo { font-weight: 650; font-size: 16px; }
.meta { font-size: 13px; color: var(--muted); display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; margin-top: 4px; }
.sep::before { content: '·'; margin-right: 16px; color: var(--hairline); }
.pregunta { font-size: 18px; font-weight: 600; line-height: 1.45; margin: 14px 0 0; letter-spacing: -0.005em; }
.sugerencia { margin-top: 16px; background: var(--surface-2); border-radius: var(--r); padding: 12px 14px; display: flex; gap: 12px; align-items: center; justify-content: space-between; flex-wrap: wrap; font-size: 14px; }
.sugerencia .quien { color: var(--muted); }
form.respuesta { margin-top: 18px; display: grid; gap: 10px; }
label { font-size: 13px; font-weight: 600; color: var(--muted); }
textarea, input[type=text] { width: 100%; font: inherit; font-size: 15px; color: var(--text); background: var(--surface-2); border: 0; border-radius: var(--r); padding: 12px 14px; box-shadow: inset 0 0 0 1px transparent; transition: box-shadow .15s, background .15s; }
textarea:focus, input[type=text]:focus { outline: none; background: var(--surface); box-shadow: inset 0 0 0 2px var(--ring); }
textarea { min-height: 76px; resize: vertical; }
.acciones { display: flex; gap: 10px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }

/* estados */
.estado { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 10px; border-radius: 999px; font-size: 12.5px; font-weight: 600; white-space: nowrap; }
.punto { width: 7px; height: 7px; border-radius: 50%; background: currentColor; flex: none; }
.t-atencion { background: var(--warning-soft); color: var(--warning); } .t-info { background: var(--info-soft); color: var(--info); }
.t-critico { background: var(--danger-soft); color: var(--danger); } .t-neutro { background: var(--neutral-soft); color: var(--neutral); }
.t-exito { background: var(--success-soft); color: var(--success); }

/* levantar */
.levantar { background: var(--surface); border-radius: var(--r-lg); box-shadow: var(--shadow); padding: 18px 24px; margin-bottom: 16px; }
.levantar h3 { font-size: 14px; margin: 0 0 10px; }
.levantar ol { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; counter-reset: paso; }
.levantar li { counter-increment: paso; display: grid; grid-template-columns: 22px 84px minmax(0, 1fr) auto auto; gap: 12px; align-items: center; font-size: 14px; }
.levantar li::before { content: counter(paso); color: var(--muted); font-weight: 700; font-size: 13px; }
.comando { background: var(--surface-2); border-radius: var(--r-sm); padding: 7px 10px; overflow-x: auto; white-space: nowrap; }

/* probar */
.avance { display: flex; align-items: center; gap: 12px; margin: 18px 0 8px; font-size: 13px; color: var(--muted); }
.barra-avance { flex: 1; height: 6px; background: var(--surface-2); border-radius: 999px; overflow: hidden; }
.barra-avance span { display: block; height: 100%; background: var(--primary); border-radius: 999px; transition: width .2s; }
.subtitulo { font-size: 13px; font-weight: 600; letter-spacing: .02em; text-transform: uppercase; color: var(--muted); margin: 18px 0 6px; }
.como { background: var(--surface-2); border-radius: var(--r); padding: 4px 16px 12px; margin-top: 14px; }
.como ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
.como li { font-size: 14px; line-height: 1.5; color: var(--text); overflow-wrap: anywhere; }
.como a { color: var(--primary); }
.checks { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; }
.checks label { display: flex; gap: 12px; align-items: flex-start; font-weight: 500; font-size: 15px; color: var(--text); padding: 8px 10px; margin: 0 -10px; border-radius: var(--r-sm); cursor: pointer; }
.checks label:hover { background: var(--surface-2); }
.checks input { margin-top: 4px; accent-color: var(--primary); width: 17px; height: 17px; flex: none; }
.checks input:checked + span { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--muted); }
.cambio { margin-top: 14px; background: var(--warning-soft); color: var(--text); border-radius: var(--r); padding: 10px 14px; font-size: 14px; }
.pie { margin-top: 18px; display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.falla { margin-top: 12px; display: flex; gap: 10px; flex-wrap: wrap; }
.falla input { flex: 1 1 280px; }
[hidden] { display: none !important; }
.vacio { padding: 28px 24px; border-radius: var(--r-lg); background: color-mix(in srgb, var(--surface) 55%, transparent); color: var(--muted); font-size: 14px; }

/* plan */
.plan-cab { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.plan-datos { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 24px; margin-top: 16px; }
.dato .rotulo { display: block; font-size: 11.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 4px; }
.cadena { display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: center; font-size: 13px; }
.cadena .motor { background: var(--surface-2); border-radius: 6px; padding: 2px 8px; font-family: Consolas, ui-monospace, monospace; font-size: 12.5px; }
.cadena .motor:first-child { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.cadena .flecha { color: var(--muted); font-size: 12px; }
.talla { display: inline-grid; place-items: center; min-width: 34px; height: 26px; padding: 0 8px; border-radius: 8px; background: var(--surface-2); font-weight: 700; font-size: 13px; }
.talla.sin { color: var(--muted); font-weight: 600; }
.nota-plan { margin: 14px 0 0; font-size: 14px; color: var(--muted); }

/* tablero */
.kanban { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 20px; align-items: start; }
.columna h3 { margin: 0 0 14px; font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 8px; color: var(--text); }
.columna h3 .punto { width: 8px; height: 8px; }
.columna h3 .n { color: var(--muted); font-weight: 600; margin-left: auto; }
.columna .lista { gap: 10px; }
.columna .tarjeta { padding: 14px 16px; border-radius: var(--r); }
.columna .titulo { font-size: 14px; display: block; margin-top: 2px; }
.columna .nota { font-size: 13px; color: var(--muted); margin: 8px 0 0; }
.ultimo { margin-top: 8px; font-size: 12.5px; color: var(--muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.ultimo .mono { font-size: 12px; }
.col-vacia { font-size: 13px; color: var(--muted); padding: 4px 0; }
.p-atencion { color: var(--warning); } .p-info { color: var(--info); } .p-critico { color: var(--danger); } .p-neutro { color: var(--neutral); } .p-exito { color: var(--success); }

/* plegables */
.plegar { display: flex; gap: 4px; justify-content: flex-end; margin: 0 0 10px; }
details.plegable > summary { list-style: none; cursor: pointer; display: flex; align-items: flex-start; gap: 10px; }
details.plegable > summary::-webkit-details-marker { display: none; }
details.plegable > summary::before { content: '▸'; color: var(--muted); font-size: 13px; line-height: 22px; flex: none; transition: transform .15s; }
details.plegable[open] > summary::before { transform: rotate(90deg); }
.cab-plegable { flex: 1; min-width: 0; }
.cuerpo-plegable { margin-top: 12px; }
.resumen-ia { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; font-size: 13px; color: var(--muted); }

/* validación IA */
.ia { margin: 14px 0; padding: 14px 16px; border-radius: var(--r); background: var(--surface-2); }
.ia-cab { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.ia-criterios { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 6px; font-size: 13.5px; }
.ia-criterios li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 6px; overflow-wrap: anywhere; }
.m-ok { color: var(--success); font-weight: 700; } .m-mal { color: var(--danger); font-weight: 700; } .m-nada { color: var(--muted); }
.ia details { margin-top: 10px; font-size: 13px; }
.ia details summary { cursor: pointer; font-weight: 600; }
.ia-hallazgos { white-space: pre-wrap; margin: 6px 0 0; overflow-wrap: anywhere; }
.galeria { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; margin-top: 12px; }
.galeria button { padding: 0; border: 0; background: none; cursor: zoom-in; text-align: left; font: inherit; color: inherit; }
.galeria img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; object-position: top; border-radius: 8px; display: block; box-shadow: 0 0 0 1px var(--hairline); background: var(--surface); }
.galeria span { display: block; font-size: 11.5px; color: var(--muted); margin-top: 4px; overflow-wrap: anywhere; }
.columna .galeria { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; }
.columna .ia { padding: 10px 12px; margin: 10px 0 0; }
dialog.visor { border: 0; padding: 0; background: transparent; max-width: 96vw; max-height: 96vh; overflow: visible; }
dialog.visor::backdrop { background: rgb(0 0 0 / .78); }
dialog.visor img { max-width: 96vw; max-height: 86vh; display: block; border-radius: 8px; }
dialog.visor p { color: #fff; margin: 8px 0 0; font-size: 14px; }
dialog.visor form { display: flex; justify-content: flex-end; margin-bottom: 8px; }

/* historial */
.segmentos { display: inline-flex; gap: 4px; background: var(--surface-2); padding: 4px; border-radius: var(--r); margin-bottom: 20px; flex-wrap: wrap; }
.segmentos button { font: inherit; font-size: 13px; font-weight: 600; border: 0; background: transparent; color: var(--muted); padding: 6px 14px; border-radius: var(--r-sm); cursor: pointer; }
.segmentos button[aria-pressed=true] { background: var(--surface); color: var(--text); box-shadow: var(--shadow); }
.linea { list-style: none; margin: 0; padding: 6px 0; background: var(--surface); border-radius: var(--r-lg); box-shadow: var(--shadow); }
.linea li { display: grid; grid-template-columns: 150px 84px minmax(0, 1fr) auto; gap: 16px; align-items: center; padding: 12px 24px; font-size: 14px; }
.linea li + li { box-shadow: 0 -1px 0 var(--hairline); }
.linea time { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 13px; }
.linea .detalle { min-width: 0; overflow-wrap: anywhere; }

.toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(16px); background: var(--text); color: var(--bg); padding: 10px 16px; border-radius: var(--r); font-size: 14px; font-weight: 600; opacity: 0; pointer-events: none; transition: opacity .2s, transform .2s; box-shadow: var(--shadow); }
.toast.visible { opacity: 1; transform: translateX(-50%) translateY(0); }
.cargando { animation: latido 1.2s ease-in-out infinite; }
@keyframes latido { 50% { opacity: .45; } }
@media (max-width: 1000px) { .kanban { grid-template-columns: repeat(2, minmax(0, 1fr)); } .plan-datos { grid-template-columns: 1fr 1fr; } }
@media (max-width: 640px) {
  .barra-in, .pestanas, main { padding-left: 16px; padding-right: 16px; }
  .kanban, .plan-datos { grid-template-columns: 1fr; }
  .tarjeta { padding: 18px; }
  .levantar li { grid-template-columns: 22px minmax(0, 1fr); }
  .levantar li > :nth-child(n+2) { grid-column: 2; }
  .linea li { grid-template-columns: 1fr auto; padding: 12px 16px; }
  .linea li .repo { display: none; }
  .actualizado { display: none; }
}
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
`;

const SCRIPT = `
const $ = (id) => document.getElementById(id);
const TOKEN = document.querySelector('meta[name=orq-token]').content;
const ESTADOS = {
  esperando: { texto: 'Esperan respuesta', tono: 'atencion' },
  'en-prueba': { texto: 'Por probar', tono: 'info' },
  'falló': { texto: 'Corrigiendo', tono: 'critico' },
  iniciado: { texto: 'En desarrollo', tono: 'neutro' },
  aceptado: { texto: 'Aceptados', tono: 'exito' },
};
const EVENTOS = { iniciado: 'Iniciado', 'en-prueba': 'Listo para probar', 'falló': 'Falló la prueba', aceptado: 'Aceptado', pregunta: 'Pregunta', respondido: 'Respondido', limpio: 'Carpeta borrada' };
const TONO_EVENTO = { iniciado: 'neutro', 'en-prueba': 'info', 'falló': 'critico', aceptado: 'exito', pregunta: 'atencion', respondido: 'exito', limpio: 'neutro' };
const RESULTADOS = {
  LISTO: ['Implementado', 'exito'], APROBADO: ['Aprobado', 'exito'], CAMBIOS: ['Pidió cambios', 'atencion'],
  BLOQUEADO: ['Bloqueado', 'critico'], SIN_CUOTA: ['Sin cuota', 'atencion'], SIN_INFORME: ['Sin informe', 'critico'],
  VERIFICACION_FALLIDA: ['Verificación fallida', 'critico'], DESKTOP_PENDIENTE: ['En Claude Desktop', 'info'],
};
const ROLES = { implementer: 'Implementer', reviewer: 'Reviewer' };
const PLAN = { 'sin plan': ['Sin plan', 'atencion'], planeado: ['Planeado', 'info'], 'en curso': ['En curso', 'neutro'] };
let datos = null;
let filtroRepo = 'todos';
let filtroPlan = 'todos';

function el(tag, attrs = {}, ...hijos) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const h of hijos.flat()) if (h !== null && h !== undefined && h !== false) n.append(h);
  return n;
}
const estado = (texto, tono) => el('span', { class: 'estado t-' + tono }, el('span', { class: 'punto', 'aria-hidden': 'true' }), texto);
const repo = (t) => el('span', { class: 'repo', title: t.repo }, t.repoLabel ?? t.repo);
const corta = (p) => p.split(/[\\\\/]/).pop();
const tituloTarea = (t) => el('a', { class: 'titulo', href: t.url, target: '_blank', rel: 'noopener' }, '#' + t.id + (t.title ? ' ' + t.title : ''));
const vacio = (texto) => el('p', { class: 'vacio' }, texto);
const resultado = (r) => RESULTADOS[r] ?? [r, 'neutro'];
function hace(iso) {
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'hace un momento';
  if (min < 60) return 'hace ' + min + ' min';
  const h = Math.round(min / 60);
  if (h < 24) return 'hace ' + h + ' h';
  const d = Math.round(h / 24);
  return 'hace ' + d + (d === 1 ? ' día' : ' días');
}
const fecha = (iso) => new Date(iso).toLocaleString('es-CO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
function aviso(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('visible');
  clearTimeout(aviso.timer);
  aviso.timer = setTimeout(() => t.classList.remove('visible'), 2600);
}
async function copiar(texto, que) {
  try { await navigator.clipboard.writeText(texto); aviso('Copiado: ' + (que ?? texto)); }
  catch { prompt('Copia este texto', texto); }
}
const plural = (n, uno, varios) => n + ' ' + (n === 1 ? uno : varios);
const cadena = (specs) => el('div', { class: 'cadena' }, ...specs.flatMap((s, i) => [i ? el('span', { class: 'flecha', 'aria-hidden': 'true' }, '→') : null, el('span', { class: 'motor' }, s)]));

/* ---------- pestañas ---------- */
const PESTANAS = ['pendientes', 'plan', 'tablero', 'historial'];
function mostrar(nombre) {
  for (const id of PESTANAS) {
    $('tab-' + id).setAttribute('aria-selected', String(id === nombre));
    $('tab-' + id).tabIndex = id === nombre ? 0 : -1;
    $(id).hidden = id !== nombre;
  }
  history.replaceState(null, '', '#' + nombre);
}
for (const id of PESTANAS) $('tab-' + id).addEventListener('click', () => mostrar(id));
document.querySelector('[role=tablist]').addEventListener('keydown', (e) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
  const tabs = [...document.querySelectorAll('[role=tab]')];
  const i = tabs.indexOf(document.activeElement);
  const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
  next.focus(); next.click();
});

/* ---------- tema ---------- */
function aplicarTema(t) { document.documentElement.classList.toggle('dark', t === 'oscuro'); }
let tema = (() => { try { return localStorage.getItem('orq-tema'); } catch { return null; } })()
  ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'oscuro' : 'claro');
aplicarTema(tema);
$('tema').addEventListener('click', () => {
  tema = tema === 'oscuro' ? 'claro' : 'oscuro';
  aplicarTema(tema);
  try { localStorage.setItem('orq-tema', tema); } catch {}
});

/* ---------- pendientes ---------- */
function pintarResumen() {
  const p = datos.preguntas.length;
  const t = datos.probar.tareas.length;
  const sinPlan = datos.plan.filter((x) => x.estado === 'sin plan').length;
  const partes = [];
  if (p) partes.push(plural(p, 'pregunta por responder', 'preguntas por responder'));
  if (t) partes.push(plural(t, 'tarea por probar', 'tareas por probar'));
  const enCurso = new Set(datos.tickets.filter((x) => x.state === 'iniciado' || x.state === 'falló').map((x) => x.id)).size;
  const r = $('resumen');
  r.replaceChildren();
  if (partes.length) r.append('Tienes ' + partes.join(' y ') + '.');
  else r.append('Todo al día.');
  if (enCurso) r.append(' ', el('span', { class: 'tenue' }, plural(enCurso, 'ticket sigue', 'tickets siguen') + ' en manos de los workers.'));
  if (sinPlan) r.append(' ', el('span', { class: 'tenue' }, plural(sinPlan, 'ticket tuyo está', 'tickets tuyos están') + ' sin plan.'));
}

function tarjetaPregunta(p) {
  const campo = 'resp-' + p.id;
  const area = el('textarea', { id: campo, name: campo, placeholder: 'Escribe la decisión tal como debe quedar en el ticket' });
  const boton = el('button', { class: 'btn btn-primario', type: 'submit' }, 'Responder');
  const enviarRespuesta = async (e) => {
    e.preventDefault();
    const texto = area.value.trim();
    if (!texto) { area.focus(); aviso('Escribe tu respuesta'); return; }
    boton.disabled = true; boton.textContent = 'Enviando…';
    try {
      const r = await fetch('/api/responder', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Token': TOKEN }, body: JSON.stringify({ id: p.id, texto }) });
      if (!r.ok) throw new Error(await r.text());
      aviso('Respondido. Dile al coordinador que siga con #' + p.id);
      cargar(true);
    } catch (err) {
      aviso('No se pudo responder: ' + err.message);
      boton.disabled = false; boton.textContent = 'Responder';
    }
  };
  return el('article', { class: 'tarjeta' },
    el('div', { class: 'encabezado' }, el('span', { class: 'repo' }, p.proyecto), tituloTarea(p)),
    ...p.questions.map((q) => el('p', { class: 'pregunta' }, q.text)),
    el('div', { class: 'meta' }, 'Preguntó ' + hace(p.since)),
    p.replyInAzure ? el('div', { class: 'sugerencia' },
      el('div', {}, el('span', { class: 'quien' }, p.replyInAzure.author + ' respondió en Azure: '), p.replyInAzure.text),
      el('button', { class: 'btn btn-texto', type: 'button', onclick: () => { area.value = p.replyInAzure.text; area.focus(); } }, 'Usar esta respuesta')) : null,
    el('form', { class: 'respuesta', onsubmit: enviarRespuesta },
      el('label', { for: campo }, 'Tu respuesta'),
      area,
      el('div', { class: 'acciones' }, boton)));
}

function pintarLevantar() {
  const filas = datos.probar.levantar;
  if (!filas.length) { $('levantar').replaceChildren(); return; }
  $('levantar').replaceChildren(el('div', { class: 'levantar' },
    el('h3', {}, 'Antes de probar, levanta en este orden'),
    el('ol', {}, ...filas.map((l) => {
      const cmd = 'cd "' + l.carpeta + '" && ' + l.comando;
      return el('li', {},
        repo(l),
        el('code', { class: 'comando', title: cmd }, 'cd ' + corta(l.carpeta) + ' && ' + l.comando),
        el('button', { class: 'btn btn-texto', type: 'button', onclick: () => copiar(cmd, 'comando de ' + (l.repoLabel ?? l.repo)) }, 'Copiar'),
        l.url ? el('a', { class: 'btn btn-texto', href: l.url, target: '_blank', rel: 'noopener' }, 'Abrir') : el('span'));
    }))));
}

/** «Cómo probarlo» del informe del implementer: viñetas y pasos como lista, «Dónde:» en negrita, URLs como enlace. */
function comoProbar(texto) {
  if (!texto) return el('p', { class: 'meta' }, 'El implementer no dejó escrito cómo probarlo: pídeselo al coordinador.');
  const conEnlaces = (s) => {
    const partes = [];
    let resto = s;
    const re = /(https?:\\/\\/[^\\s)]+)/;
    let m;
    while ((m = re.exec(resto))) {
      if (m.index) partes.push(resto.slice(0, m.index));
      partes.push(el('a', { href: m[1], target: '_blank', rel: 'noopener' }, m[1]));
      resto = resto.slice(m.index + m[1].length);
    }
    if (resto) partes.push(resto);
    return partes;
  };
  const item = (s) => {
    const limpio = s.replace(/^\\s*(?:[-*•]|\\d+[.)])\\s*/, '').replace(/\\*\\*/g, '').replace(/\\x60/g, '');
    const rot = /^([^:]{2,28}):\\s*(.*)$/.exec(limpio);
    return rot ? el('li', {}, el('strong', {}, rot[1] + ': '), ...conEnlaces(rot[2])) : el('li', {}, ...conEnlaces(limpio));
  };
  const lineas = texto.split('\\n').filter((l) => l.trim());
  return el('section', { class: 'como' }, el('h4', { class: 'subtitulo' }, 'Cómo probarlo'), el('ul', {}, ...lineas.map(item)));
}

/* ---------- plegables y validación IA ---------- */
const ABIERTOS = (() => { try { return new Set(JSON.parse(localStorage.getItem('orq-abiertos') ?? '[]')); } catch { return new Set(); } })();
function guardarAbiertos() { try { localStorage.setItem('orq-abiertos', JSON.stringify([...ABIERTOS])); } catch {} }
function plegable(clave, cabecera, cuerpo) {
  const d = el('details', { class: 'plegable', open: ABIERTOS.has(clave) },
    el('summary', {}, el('div', { class: 'cab-plegable' }, ...cabecera)),
    el('div', { class: 'cuerpo-plegable' }, ...cuerpo));
  d.addEventListener('toggle', () => { if (d.open) ABIERTOS.add(clave); else ABIERTOS.delete(clave); guardarAbiertos(); });
  return d;
}
function botonesPlegar(id, contenedor) {
  const todos = (abrir) => () => { for (const d of $(contenedor).querySelectorAll('details.plegable')) d.open = abrir; };
  $(id).replaceChildren(
    el('button', { class: 'btn btn-texto', type: 'button', onclick: todos(true) }, 'Expandir todo'),
    el('button', { class: 'btn btn-texto', type: 'button', onclick: todos(false) }, 'Contraer todo'));
}
const IA = { 'PASÓ': ['IA: pasó', 'exito'], 'FALLÓ': ['IA: falló', 'critico'], 'PARCIAL': ['IA: parcial', 'atencion'], 'NO SE PUDO PROBAR': ['IA: no pudo probar', 'neutro'] };
const insigniaIa = (v) => v ? estado(...(IA[v.resultado] ?? ['IA: ' + v.resultado, 'neutro'])) : estado('IA: sin validar', 'neutro');
const MARCAS = { '✔': 'm-ok', '✘': 'm-mal', '–': 'm-nada' };
function abrirCaptura(src, texto) {
  $('visor-img').src = src;
  $('visor-img').alt = texto;
  $('visor-texto').textContent = texto;
  $('visor').showModal();
}
function galeria(t, v) {
  if (!v.capturas.length) return null;
  return el('div', { class: 'galeria' }, ...v.capturas.map((c) => {
    const src = '/captura/' + t.id + '/' + encodeURIComponent(t.repo) + '/' + encodeURIComponent(c.archivo);
    const texto = c.descripcion || c.archivo;
    return el('button', { type: 'button', title: texto, onclick: () => abrirCaptura(src, texto) },
      el('img', { src, alt: texto, loading: 'lazy' }), el('span', {}, texto));
  }));
}
function validacionIa(t, v) {
  if (!v) return el('div', { class: 'ia' }, el('div', { class: 'ia-cab' }, insigniaIa(null), 'La IA todavía no validó esta tarea.'));
  const n = (m) => v.criterios.filter((c) => c.marca === m).length;
  const cuando = v.fecha ? (Number.isNaN(Date.parse(v.fecha)) ? v.fecha : fecha(v.fecha)) : '';
  return el('section', { class: 'ia', 'aria-label': 'Validación de la IA' },
    el('div', { class: 'ia-cab' }, insigniaIa(v), n('✔') + ' ✔ · ' + n('✘') + ' ✘ · ' + n('–') + ' sin verificar',
      cuando ? el('span', {}, '· ' + cuando) : null, v.qa ? el('span', { class: 'mono' }, '@' + v.qa) : null),
    v.criterios.length ? el('ul', { class: 'ia-criterios' }, ...v.criterios.map((c) => el('li', {}, el('span', { class: MARCAS[c.marca] ?? 'm-nada' }, c.marca), el('span', {}, c.texto)))) : null,
    v.hallazgos ? el('details', { open: v.resultado !== 'PASÓ' }, el('summary', {}, 'Hallazgos de la IA'), el('p', { class: 'ia-hallazgos' }, v.hallazgos)) : null,
    galeria(t, v));
}

function tarjetaProbar(t) {
  const clave = 'orq-check-' + t.repo + '-' + t.id + '-' + t.tip;
  let marcados = [];
  try { marcados = JSON.parse(localStorage.getItem(clave) ?? '[]'); } catch {}
  const total = t.checks.length;
  const relleno = el('span');
  const texto = el('span');
  const textoCab = el('span');
  const barra = el('div', { class: 'barra-avance', role: 'progressbar', 'aria-label': 'Comprobaciones hechas', 'aria-valuemin': '0', 'aria-valuemax': String(total) }, relleno);
  const actualizar = () => {
    relleno.style.width = (total ? (marcados.length / total) * 100 : 0) + '%';
    barra.setAttribute('aria-valuenow', String(marcados.length));
    texto.textContent = marcados.length + ' de ' + total;
    textoCab.textContent = 'Comprobado ' + marcados.length + ' de ' + total;
  };
  actualizar();
  const checks = total ? el('ul', { class: 'checks' }, ...t.checks.map((c, i) => {
    const caja = el('input', { type: 'checkbox', checked: marcados.includes(i) });
    caja.addEventListener('change', () => {
      marcados = caja.checked ? [...marcados, i] : marcados.filter((x) => x !== i);
      try { localStorage.setItem(clave, JSON.stringify(marcados)); } catch {}
      actualizar();
    });
    return el('li', {}, el('label', {}, caja, el('span', {}, c)));
  })) : el('p', { class: 'meta' }, 'El ticket no tiene criterios de aceptación: míralos en la tarea de Azure.');

  const campoFalla = 'falla-' + t.repo + '-' + t.id;
  const inputFalla = el('input', { type: 'text', id: campoFalla, placeholder: 'Qué falló, en una frase', 'aria-label': 'Qué falló' });
  const falla = el('div', { class: 'falla', hidden: true },
    inputFalla,
    el('button', { class: 'btn', type: 'button', onclick: () => {
      const motivo = inputFalla.value.trim();
      if (!motivo) { inputFalla.focus(); aviso('Escribe qué falló'); return; }
      copiar('/qa-falla ' + t.id + ' ' + motivo, '/qa-falla ' + t.id + '. Pégalo en el coordinador');
    } }, 'Copiar /qa-falla'));

  return el('article', { class: 'tarjeta' }, plegable('p-' + t.repo + '-' + t.id,
    [el('div', { class: 'encabezado' }, repo(t), tituloTarea(t)),
      el('div', { class: 'resumen-ia' }, insigniaIa(t.validacion), total ? textoCab : null, t.tested ? null : estado('Rama cambiada', 'atencion'))],
    [el('div', { class: 'meta' },
      el('span', { class: 'mono', title: t.dir }, corta(t.dir)),
      el('button', { class: 'btn btn-texto', type: 'button', onclick: () => copiar(t.dir, 'ruta de la carpeta') }, 'Copiar ruta'),
      t.prUrl ? el('a', { class: 'sep', href: t.prUrl, target: '_blank', rel: 'noopener' }, 'PR ' + t.pr) : el('span', { class: 'sep' }, 'Sin PR todavía')),
    t.tested ? null : el('div', { class: 'cambio' }, 'La rama cambió después de mezclarla. Pídele al coordinador «qa ' + t.id + '» antes de probar.'),
    validacionIa(t, t.validacion),
    comoProbar(t.comoProbar),
    el('h4', { class: 'subtitulo' }, 'Criterios de aceptación · qué validar'),
    total ? el('div', { class: 'avance' }, el('span', {}, 'Comprobado'), barra, texto) : null,
    checks,
    el('div', { class: 'pie' },
      el('button', { class: 'btn btn-primario', type: 'button', onclick: () => copiar('/qa-ok ' + t.id, '/qa-ok ' + t.id + '. Pégalo en el coordinador') }, 'Funciona'),
      el('button', { class: 'btn', type: 'button', 'aria-expanded': 'false', 'aria-controls': campoFalla, onclick: (e) => {
        falla.hidden = !falla.hidden;
        e.currentTarget.setAttribute('aria-expanded', String(!falla.hidden));
        if (!falla.hidden) inputFalla.focus();
      } }, 'No funciona')),
    falla]));
}

function pintarPendientes() {
  pintarResumen();
  const n = datos.preguntas.length;
  $('n-pendientes').textContent = String(n);
  $('n-pendientes').hidden = n === 0;
  $('preguntas').replaceChildren(...(n ? datos.preguntas.map(tarjetaPregunta) : [vacio('Ninguna pregunta. Los workers avanzan sin esperarte.')]));
  pintarLevantar();
  botonesPlegar('plegar-probar', 'probar');
  $('probar').replaceChildren(...(datos.probar.tareas.length ? datos.probar.tareas.map(tarjetaProbar) : [vacio('Nada por probar todavía. Cuando un ticket pase la revisión aparecerá aquí.')]));
}

/* ---------- plan ---------- */
function tarjetaPlan(f) {
  const [texto, tono] = PLAN[f.estado] ?? [f.estado, 'neutro'];
  const sinTalla = f.talla === '*';
  return el('article', { class: 'tarjeta' },
    el('div', { class: 'plan-cab' },
      el('div', {},
        el('div', { class: 'encabezado' }, el('span', { class: 'repo' }, f.type + (f.prioridad ? ' · P' + f.prioridad : '')), tituloTarea(f)),
        f.parent ? el('div', { class: 'meta' }, 'Historia #' + f.parent) : null),
      estado(texto, tono)),
    el('div', { class: 'plan-datos' },
      el('div', { class: 'dato' }, el('span', { class: 'rotulo' }, 'Repos y talla'),
        el('div', { class: 'cadena' },
          el('span', { class: 'talla' + (sinTalla ? ' sin' : ''), title: sinTalla ? 'Sin talla: se usa la cadena por defecto' : 'Talla' }, sinTalla ? '—' : f.talla),
          f.repoLabels.length ? f.repoLabels.join(' + ') : el('span', { class: 'meta', style: 'margin:0' }, 'repo por decidir'))),
      el('div', { class: 'dato' }, el('span', { class: 'rotulo' }, 'Implementer'), cadena(f.implementer)),
      el('div', { class: 'dato' }, el('span', { class: 'rotulo' }, 'Reviewer'), cadena(f.reviewer))),
    f.nota ? el('p', { class: 'nota-plan' }, f.nota) : null);
}

function pintarPlan() {
  const sinPlan = datos.plan.filter((f) => f.estado === 'sin plan').length;
  $('n-plan').textContent = String(sinPlan);
  $('n-plan').hidden = sinPlan === 0;
  $('n-plan').title = plural(sinPlan, 'ticket sin plan', 'tickets sin plan');
  $('resumen-plan').textContent = datos.plan.length
    ? plural(datos.plan.length, 'ticket asignado', 'tickets asignados') + (sinPlan ? ', ' + sinPlan + ' sin plan' : ', todos planeados')
    : 'No tienes tickets asignados para tomar.';
  const estados = ['todos', ...Object.keys(PLAN).filter((s) => datos.plan.some((f) => f.estado === s))];
  if (!estados.includes(filtroPlan)) filtroPlan = 'todos';
  $('filtros-plan').replaceChildren(...estados.map((s) => el('button', { type: 'button', 'aria-pressed': String(s === filtroPlan), onclick: () => { filtroPlan = s; pintarPlan(); } },
    s === 'todos' ? 'Todos' : PLAN[s][0], ' ', el('span', { class: 'meta', style: 'display:inline;margin:0' }, String(s === 'todos' ? datos.plan.length : datos.plan.filter((f) => f.estado === s).length)))));
  const lista = datos.plan.filter((f) => filtroPlan === 'todos' || f.estado === filtroPlan);
  $('lista-plan').replaceChildren(...(lista.length ? lista.map(tarjetaPlan) : [vacio('Nada en este filtro.')]));
}

/* ---------- tablero ---------- */
function ultimoPaso(u) {
  if (!u) return null;
  const [texto, tono] = resultado(u.resultado);
  return el('div', { class: 'ultimo' }, estado((ROLES[u.rol] ?? u.rol) + ': ' + texto, tono), el('span', { class: 'mono' }, u.motor));
}
function tarjetaKanban(t) {
  const extra = [];
  if (t.state === 'esperando') extra.push(el('p', { class: 'nota' }, t.questions.map((q) => q.text).join(' · ')));
  if (t.state === 'falló' && t.note) extra.push(el('p', { class: 'nota' }, 'Falló: ' + t.note));
  if (t.state === 'aceptado' && t.pr) {
    const completo = t.prStatus === 'completed';
    extra.push(el('div', { class: 'meta' }, t.prUrl ? el('a', { href: t.prUrl, target: '_blank', rel: 'noopener' }, 'PR ' + t.pr) : 'PR ' + t.pr, completo ? 'completado' : t.prStatus === 'active' ? 'en curso' : t.prStatus));
  }
  if (t.state === 'iniciado' || t.state === 'falló') extra.push(ultimoPaso(t.ultimo));
  const cabecera = [
    el('div', { class: 'encabezado' }, repo(t), el('span', { class: 'meta', style: 'margin:0' }, hace(t.since))),
    tituloTarea(t),
    t.state === 'en-prueba' || t.validacion ? el('div', { class: 'resumen-ia' }, insigniaIa(t.validacion)) : null];
  if (!t.validacion) return el('article', { class: 'tarjeta' }, ...cabecera, ...extra);
  // Lo urgente (preguntas, fallas) sigue a la vista; la validación con sus capturas se pliega.
  return el('article', { class: 'tarjeta' }, plegable('k-' + t.repo + '-' + t.id, [...cabecera, ...extra], [validacionIa(t, t.validacion)]));
}
function pintarTablero() {
  botonesPlegar('plegar-tablero', 'kanban');
  $('kanban').replaceChildren(...Object.entries(ESTADOS).map(([s, { texto, tono }]) => {
    const lista = datos.tickets.filter((t) => t.state === s).sort((a, b) => b.since.localeCompare(a.since));
    return el('section', { class: 'columna', 'aria-label': texto },
      el('h3', {}, el('span', { class: 'punto p-' + tono, 'aria-hidden': 'true' }), texto, el('span', { class: 'n' }, String(lista.length))),
      el('div', { class: 'lista' }, ...(lista.length ? lista.map(tarjetaKanban) : [el('p', { class: 'col-vacia' }, 'Nada aquí')])));
  }));
}

/* ---------- historial ---------- */
function eventoTexto(e) {
  if (e.event === 'trabajo') {
    const [texto, tono] = resultado(e.resultado);
    return [(ROLES[e.rol] ?? e.rol) + ': ' + texto, tono, e.motor];
  }
  return [EVENTOS[e.event] ?? e.event, TONO_EVENTO[e.event] ?? 'neutro', e.note];
}
function pintarHistorial() {
  const repos = ['todos', ...new Set(datos.historial.map((e) => e.repoLabel))];
  if (!repos.includes(filtroRepo)) filtroRepo = 'todos';
  $('filtros').replaceChildren(...repos.map((r) => el('button', { type: 'button', 'aria-pressed': String(r === filtroRepo), onclick: () => { filtroRepo = r; pintarHistorial(); } }, r === 'todos' ? 'Todos' : r)));
  const lista = datos.historial.filter((e) => filtroRepo === 'todos' || e.repoLabel === filtroRepo).slice(0, 200);
  $('linea').replaceChildren(...(lista.length ? lista.map((e) => {
    const [texto, tono, detalle] = eventoTexto(e);
    return el('li', {},
      el('time', { datetime: e.at }, fecha(e.at)),
      el('span', { class: 'repo' }, e.repoLabel),
      el('span', { class: 'detalle' }, el('a', { href: e.url, target: '_blank', rel: 'noopener' }, el('strong', {}, '#' + e.id)), e.title ? ' ' + e.title : '', detalle ? el('span', { class: 'meta', style: 'display:block;margin:2px 0 0' }, detalle) : '', e.pr ? ' · PR ' + e.pr : ''),
      estado(texto, tono));
  }) : [el('li', {}, 'Sin movimientos todavía.')]));
}

/* ---------- carga ---------- */
async function cargar(fresco) {
  const boton = $('actualizar');
  boton.disabled = true;
  $('actualizado').textContent = 'Consultando Azure…';
  $('actualizado').classList.add('cargando');
  try {
    const r = await fetch('/api/datos' + (fresco ? '?fresco' : ''));
    if (!r.ok) throw new Error(await r.text());
    datos = await r.json();
    $('rama').textContent = datos.rama ?? 'sin rama de pruebas';
    const c = datos.capacidad;
    const avisos = datos.fallas.map((f) => el('p', { class: 'nota-aviso' }, 'No se pudo leer ' + f));
    if (c.cupo < 3) avisos.push(el('p', { class: 'nota-aviso' }, 'Memoria: ' + c.libreGb + ' GB libres, conviene no pasar de ' + plural(c.cupo, 'ticket', 'tickets') + ' a la vez.'));
    $('avisos').replaceChildren(...avisos);
    pintarPendientes(); pintarPlan(); pintarTablero(); pintarHistorial();
    $('actualizado').textContent = 'Actualizado ' + new Date(datos.generado).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  } catch (err) {
    $('actualizado').textContent = 'No se pudo actualizar';
    $('avisos').replaceChildren(el('p', { class: 'nota-aviso' }, err.message));
  } finally {
    boton.disabled = false;
    $('actualizado').classList.remove('cargando');
  }
}
$('actualizar').addEventListener('click', () => cargar(true));
mostrar(PESTANAS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'pendientes');
cargar(false);
`;

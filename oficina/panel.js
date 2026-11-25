'use strict';
/* Oficina · panel: carga del PC, control (huérfanos, pausar, reanudar), causa de los colgados, línea de tiempo del
   ticket, sudor y confeti. Usa lo que define index.html (agentes, ESCRITORIOS, R, X, ganchos, esc, hora…). */

/* =========================================================== API con el token de la página */
const TOKEN_OFICINA = document.querySelector('meta[name="oficina-token"]')?.content ?? '';
async function apiOficina(ruta, datos) {
  const opciones = datos === undefined
    ? { cache: 'no-store' }
    : { method: 'POST', headers: { 'content-type': 'application/json', 'x-oficina-token': TOKEN_OFICINA }, body: JSON.stringify(datos) };
  const r = await fetch(ruta, opciones);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

/* =========================================================== ventanas */
function abrirVentana(html, alAbrir) {
  cerrarListas();
  const velo = document.createElement('div');
  velo.className = 'velo';
  velo.innerHTML = `<div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  const cerrar = () => { velo.remove(); removeEventListener('keydown', teclas); };
  const teclas = (ev) => { if (ev.key === 'Escape') cerrar(); };
  velo.addEventListener('click', (ev) => { if (ev.target === velo || ev.target.closest('[data-cerrar]')) cerrar(); });
  addEventListener('keydown', teclas);
  document.body.appendChild(velo);
  alAbrir?.(velo.querySelector('.modal'), cerrar);
  return cerrar;
}
const fraseHtml = (texto) =>
  `<div class="frase"><code>${esc(texto)}</code><button type="button" data-copiar="${esc(texto)}">Copiar</button></div>`;
document.addEventListener('click', async (ev) => {
  const b = ev.target.closest('[data-copiar]');
  if (!b) return;
  try { await navigator.clipboard.writeText(b.dataset.copiar); b.textContent = '¡Copiada!'; } catch { b.textContent = 'Cópiala a mano'; }
});
const AVISO_COORDINADOR =
  '<div class="coordinador">🧭 <b>El coordinador es quien ejecuta.</b> La oficina no puede pausar ni reanudar las sesiones de ' +
  'Claude Desktop: deja la orden en <code>progress/oficina/orden.json</code> y tú le pegas la frase al coordinador.</div>';

/** Tabla de procesos con casillas (todas marcadas). Devuelve el HTML. */
function tablaProcesos(lista) {
  if (!lista.length) return '<p class="nota">No hay procesos que cumplan la condición. 🎉</p>';
  return `<table><thead><tr><th><input type="checkbox" data-todos checked></th><th>PID</th><th>Ticket</th><th>Proceso</th><th>Edad</th><th>RAM</th><th>Por qué</th></tr></thead><tbody>` +
    lista.map((p) => `<tr><td><input type="checkbox" data-pid="${p.pid}" checked></td><td>${p.pid}</td><td>${esc(p.grupo)}/#${esc(p.ticket)}</td>` +
      `<td>${esc(p.herramienta)}</td><td>${p.edadMin == null ? '–' : duracion(p.edadMin)}</td><td>${fmt(p.memMb)} MB</td><td class="motivo">${esc(p.motivo)}</td></tr>`).join('') +
    '</tbody></table>';
}
function pidsMarcados(modal) {
  return [...modal.querySelectorAll('input[data-pid]:checked')].map((c) => Number(c.dataset.pid));
}
function enlazarTodos(modal) {
  modal.querySelector('[data-todos]')?.addEventListener('change', (ev) => {
    modal.querySelectorAll('input[data-pid]').forEach((c) => { c.checked = ev.target.checked; });
  });
}
const resumenMuertes = (r) =>
  `<p>${r.hechos.length ? `✔ Terminé ${r.hechos.length} proceso(s): ${r.hechos.map((p) => p.pid).join(', ')}.` : 'No terminé ningún proceso.'}</p>` +
  (r.fallos.length ? `<p class="nota">No pude con: ${r.fallos.map((f) => `${f.pid} (${esc(f.error)})`).join(', ')}.</p>` : '');

/* =========================================================== control: huérfanos, pausar, reanudar, avisos */
async function matarHuerfanos() {
  const cerrarCarga = abrirVentana('<h2>🧹 Procesos huérfanos</h2><p>Buscando…</p>');
  let datos;
  try { datos = await apiOficina('/api/huerfanos'); } catch (e) { cerrarCarga(); return abrirVentana(`<h2>Error</h2><p>${esc(e.message)}</p><div class="botones"><button data-cerrar>Cerrar</button></div>`); }
  cerrarCarga();
  abrirVentana(
    `<h2>🧹 Matar procesos huérfanos</h2>` +
    `<p>Procesos <b>node</b> de <code>worktrees/</code> cuyo ticket no tiene un agente activo, o con más de ${datos.viejosMin} min sin que su ticket tenga una suite en curso. ` +
    `Nunca toca la rama de pruebas (<code>qa</code>) ni el orquestador, y mata cada PID por separado (sin árbol).</p>` +
    tablaProcesos(datos.lista) +
    `<div class="botones"><button class="secundario" data-cerrar>Cancelar</button>${datos.lista.length ? '<button class="peligro" data-ok>Matar los marcados</button>' : ''}</div>`,
    (modal, cerrar) => {
      enlazarTodos(modal);
      modal.querySelector('[data-ok]')?.addEventListener('click', async () => {
        const pids = pidsMarcados(modal);
        if (!pids.length) return;
        cerrar();
        try {
          const r = await apiOficina('/api/huerfanos/matar', { pids });
          abrirVentana(`<h2>🧹 Listo</h2>${resumenMuertes(r)}<div class="botones"><button data-cerrar>Cerrar</button></div>`);
        } catch (e) { abrirVentana(`<h2>Error</h2><p>${esc(e.message)}</p><div class="botones"><button data-cerrar>Cerrar</button></div>`); }
        traer();
      });
    },
  );
}

async function pausarTodo() {
  let datos;
  try { datos = await apiOficina('/api/pausar'); } catch (e) { return abrirVentana(`<h2>Error</h2><p>${esc(e.message)}</p><div class="botones"><button data-cerrar>Cerrar</button></div>`); }
  abrirVentana(
    `<h2>⏸ Pausar todo</h2>${AVISO_COORDINADOR}` +
    `<p>Al confirmar: <b>1)</b> termino estos procesos node de <code>worktrees/</code> (no la rama de pruebas), <b>2)</b> dejo la orden «pausar» en ` +
    `<code>orden.json</code> y <b>3)</b> te muestro la frase para el coordinador.</p>` + tablaProcesos(datos.lista) +
    `<div class="botones"><button class="secundario" data-cerrar>Cancelar</button><button class="peligro" data-ok>Pausar</button></div>`,
    (modal, cerrar) => {
      enlazarTodos(modal);
      modal.querySelector('[data-ok]').addEventListener('click', async () => {
        const pids = pidsMarcados(modal);
        cerrar();
        try {
          const r = await apiOficina('/api/pausar', { pids });
          abrirVentana(`<h2>⏸ Orden de pausa escrita</h2>${resumenMuertes(r)}<p>Ahora pégale esto al coordinador:</p>${fraseHtml(r.frase)}${AVISO_COORDINADOR}` +
            '<div class="botones"><button data-cerrar>Entendido</button></div>');
        } catch (e) { abrirVentana(`<h2>Error</h2><p>${esc(e.message)}</p><div class="botones"><button data-cerrar>Cerrar</button></div>`); }
        traer();
      });
    },
  );
}

function reanudarTodo() {
  abrirVentana(
    `<h2>▶ Reanudar todo</h2>${AVISO_COORDINADOR}<p>Dejo la orden «reanudar» en <code>orden.json</code> y te muestro la frase para el coordinador. No arranco nada por mi cuenta.</p>` +
    '<div class="botones"><button class="secundario" data-cerrar>Cancelar</button><button data-ok>Escribir la orden</button></div>',
    (modal, cerrar) => {
      modal.querySelector('[data-ok]').addEventListener('click', async () => {
        cerrar();
        try {
          const r = await apiOficina('/api/reanudar', {});
          abrirVentana(`<h2>▶ Orden de reanudar escrita</h2><p>Pégale esto al coordinador:</p>${fraseHtml(r.frase)}${AVISO_COORDINADOR}<div class="botones"><button data-cerrar>Entendido</button></div>`);
        } catch (e) { abrirVentana(`<h2>Error</h2><p>${esc(e.message)}</p><div class="botones"><button data-cerrar>Cerrar</button></div>`); }
        traer();
      });
    },
  );
}

async function probarAviso() {
  try {
    const r = await apiOficina('/api/avisos/probar', {});
    abrirVentana(`<h2>🔔 Aviso de prueba</h2><p>${r.enviado ? '✔ Enviado: revisa el celular.' : 'ntfy no respondió bien.'}</p><div class="botones"><button data-cerrar>Cerrar</button></div>`);
  } catch (e) { abrirVentana(`<h2>🔔 Avisos</h2><p>${esc(e.message)}</p><div class="botones"><button data-cerrar>Cerrar</button></div>`); }
}

function pintarControl(e) {
  const c = e.carga ?? {};
  const av = e.avisos ?? {};
  const o = e.orden;
  const lista = document.getElementById('lista-control');
  lista.innerHTML =
    `<h3>🖥 Carga del PC</h3><div class="nota">RAM ${c.ramUsadaGb ?? '–'} de ${c.ramTotalGb ?? '–'} GB (${c.ramLibrePct ?? '–'} % libre · tope del orquestador ${c.ramTopeGb ?? '–'} GB)` +
    ` · CPU ${c.cpuLibrePct == null ? '–' : c.cpuLibrePct + ' % libre'} · node: ${c.nodeTotal ?? 0} (${c.nodeWorktrees ?? 0} en worktrees, ${c.memWorktreesGb ?? 0} GB)</div>` +
    '<h3>🎛 Acciones</h3>' +
    '<button type="button" data-accion="huerfanos">🧹 Matar procesos huérfanos…</button>' +
    '<button type="button" data-accion="pausar">⏸ Pausar todo…</button>' +
    '<button type="button" data-accion="reanudar">▶ Reanudar todo…</button>' +
    '<div class="nota">Pausar y reanudar los ejecuta el coordinador: la oficina deja la orden y te da la frase.</div>' +
    (o?.accion ? `<div class="nota">Última orden: <b>${esc(o.accion)}</b> · ${hora(o.fecha, true)}</div>` : '') +
    '<h3>🔔 Avisos al celular</h3>' +
    `<button type="button" data-accion="probar"${av.configurado ? '' : ' disabled'}>🔔 Enviar un aviso de prueba</button>` +
    (av.configurado
      ? `<div class="nota">Activos (ntfy).${av.ultimoEnvio ? ` Último envío ${hora(av.ultimoEnvio.at, true)} ${av.ultimoEnvio.ok ? '✔' : '✖'}` : ''}</div>`
      : '<div class="nota">Apagados: pon tu tema de ntfy en <code>oficina/config.local.json</code> (ver config.example.json).</div>');
}
document.getElementById('lista-control').addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-accion]');
  if (!b) return;
  ({ huerfanos: matarHuerfanos, pausar: pausarTodo, reanudar: reanudarTodo, probar: probarAviso })[b.dataset.accion]?.();
});

/* =========================================================== HUD: carga y develop */
function pintarCarga(c) {
  if (!c) return;
  const chip = document.getElementById('carga');
  document.getElementById('carga-ram').style.width = `calc(${100 - c.ramLibrePct}% - 2px)`;
  document.getElementById('carga-cpu').style.width = `calc(${c.cpuLibrePct == null ? 0 : 100 - c.cpuLibrePct}% - 2px)`;
  document.getElementById('carga-txt').textContent = `RAM ${c.ramLibrePct}% · CPU ${c.cpuLibrePct ?? '–'}% libres`;
  chip.classList.toggle('alta', Boolean(c.alta));
  chip.title = `RAM: ${c.ramUsadaGb} de ${c.ramTotalGb} GB en uso (${c.ramLibrePct} % libre; umbral ${c.umbral?.ramLibreMinPct} %).` +
    `${c.sobreTope ? ` Por encima del tope del orquestador (${c.ramTopeGb} GB).` : ''}\nnode: ${c.nodeTotal} procesos, ${c.nodeWorktrees} de worktrees (${c.memWorktreesGb} GB).` +
    `\nUn agente suda con más de ${c.umbral?.nodePorAgenteMax} procesos node o si la RAM libre baja del umbral.`;
}
function pintarDevelop(d) {
  const chip = document.getElementById('develop');
  if (!d?.at) {
    chip.className = 'chip dev';
    chip.textContent = d?.ok === false ? '⎇ develop: sin datos' : '⎇ develop …';
    chip.title = d?.error ?? 'Consultando los pipelines de develop…';
    return;
  }
  if (!d.pipelines.length) {
    chip.className = 'chip dev';
    chip.textContent = '⎇ develop: sin pipeline';
    chip.title = 'Ningún pipeline de Azure corre sobre develop, así que no hay cómo saber si está en rojo sin compilarlo.';
  } else if (d.rojos.length) {
    chip.className = 'chip dev rojo';
    chip.textContent = `✖ develop en rojo (${d.rojos.length})`;
    chip.title = `Fallidos: ${d.rojos.join(', ')}`;
  } else {
    chip.className = 'chip dev ok';
    chip.textContent = '✔ develop';
    chip.title = d.pipelines.map((p) => `${p.nombre}: ${p.resultado}`).join('\n');
  }
}

/* =========================================================== causa de un colgado (clic en la etiqueta) */
function verColgado(i) {
  const d = agentes[i]?.dato;
  const c = d?.colgado;
  if (!c) return d?.ticket ? abrirLinea(i) : undefined;
  const instrucciones = {
    'pruebas-largas': `Una prueba o un lint lleva demasiado. Si no termina, mátalo y que el agente lo vuelva a correr.`,
    'sin-trabajo': `El ticket está en curso pero no corre nada ni cambia ningún archivo: el worker o el subagente que esperaba ya murió.`,
    persona: 'El ticket espera tu respuesta: respóndela en el panel del orquestador o con /responder.',
    bloqueado: 'El coordinador lo dejó en espera en cola.json.',
  }[c.causa] ?? '';
  const textoCoordinador = c.causa === 'sin-trabajo' ? `#${d.ticket}: ${c.accion.toLowerCase()}` : c.causa === 'bloqueado' ? `#${d.ticket}: ${c.detalle}` : '';
  abrirVentana(
    `<h2>${ICONO_COLGADO[c.causa] ?? '⚠'} #${d.ticket} · ${esc(c.titulo)}</h2><p>${esc(c.detalle ?? '')}</p><p class="nota">${esc(instrucciones)}</p>` +
    `<p><b>Acción sugerida:</b> ${esc(c.accion)}</p>` + (textoCoordinador ? `<p>Para el coordinador:</p>${fraseHtml(textoCoordinador)}` : '') +
    `<div class="botones"><button class="secundario" data-linea>Ver la línea de tiempo</button>` +
    (c.pid ? `<button class="peligro" data-matar="${c.pid}">Matar el proceso ${c.pid}…</button>` : '') + '<button data-cerrar>Cerrar</button></div>',
    (modal, cerrar) => {
      modal.querySelector('[data-linea]').addEventListener('click', () => { cerrar(); abrirLinea(i); });
      modal.querySelector('[data-matar]')?.addEventListener('click', (ev) => {
        const pid = Number(ev.target.dataset.matar);
        cerrar();
        abrirVentana(`<h2>¿Matar el proceso ${pid}?</h2><p>Solo ese PID (sin árbol). El agente tendrá que volver a correr la prueba.</p>` +
          '<div class="botones"><button class="secundario" data-cerrar>Cancelar</button><button class="peligro" data-ok>Matar</button></div>',
        (m2, cerrar2) => m2.querySelector('[data-ok]').addEventListener('click', async () => {
          cerrar2();
          try {
            const r = await apiOficina('/api/procesos/matar', { pids: [pid] });
            abrirVentana(`<h2>Listo</h2>${resumenMuertes(r)}<div class="botones"><button data-cerrar>Cerrar</button></div>`);
          } catch (e) { abrirVentana(`<h2>Error</h2><p>${esc(e.message)}</p><div class="botones"><button data-cerrar>Cerrar</button></div>`); }
          traer();
        }));
      });
    },
  );
}

/* =========================================================== línea de tiempo */
const COLOR_EVENTO = { start: '#2a9d8f', brief: '#c9b08a', lanzado: '#79c0ff', impl: '#e07a32', aprobado: '#2d6a4f', cambios: '#d62839',
  qa: '#8e6cc9', pr: '#1f6feb', done: '#2d6a4f', pregunta: '#c98a1a', respuesta: '#c98a1a', alerta: '#d62839', otro: '#8a5a3b' };
async function abrirLinea(i) {
  const d = agentes[i]?.dato;
  if (!d?.ticket) return;
  const cerrarCarga = abrirVentana(`<h2>🕒 #${d.ticket}</h2><p>Armando la línea de tiempo… (la primera vez busca el PR en Azure)</p>`);
  let l;
  try { l = await apiOficina(`/api/linea?ticket=${encodeURIComponent(d.ticket)}&repo=${encodeURIComponent(d.repo ?? '')}`); }
  catch (e) { cerrarCarga(); return abrirVentana(`<h2>Error</h2><p>${esc(e.message)}</p><div class="botones"><button data-cerrar>Cerrar</button></div>`); }
  cerrarCarga();
  const fecha = (iso) => new Date(iso).toLocaleString('es-CO', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  const pr = l.pr ? `<p>🔗 <a href="${esc(l.pr.url)}" target="_blank" rel="noopener">PR ${esc(l.pr.id)}</a> · ${esc(l.pr.estado ?? '')}${l.pr.viejo ? ' (dato guardado)' : ''}</p>` : '<p class="nota">Sin PR todavía.</p>';
  abrirVentana(
    `<h2>🕒 #${l.ticket} · ${esc(l.titulo)}</h2><p class="nota">${esc(l.repo)}${l.talla ? ' · talla ' + esc(l.talla) : ''} · ${duracion(l.totalMin)} de punta a punta</p>${pr}` +
    (l.eventos.length
      ? `<ul class="linea">${l.eventos.map((e) => `<li style="--c:${COLOR_EVENTO[e.tipo] ?? '#8a5a3b'}"><time>${fecha(e.at)}</time><b>${esc(e.titulo)}</b>` +
        `${e.durMin ? `<span class="dur">+${duracion(e.durMin)}</span>` : ''}${e.detalle ? `<span class="det">${esc(e.detalle)}</span>` : ''}</li>`).join('')}</ul>`
      : '<p class="nota">Todavía no hay eventos.</p>') +
    '<div class="botones"><button data-cerrar>Cerrar</button></div>',
  );
}

/* =========================================================== clics en la escena */
document.getElementById('carteles').addEventListener('click', (ev) => {
  const rojo = ev.target.closest('[id^="rojo-"]');
  if (rojo) return verColgado(Number(rojo.id.slice(5)));
  const c = ev.target.closest('[id^="cartel-"]');
  const i = c ? Number(c.id.slice(7)) : NaN;
  if (Number.isInteger(i)) abrirLinea(i);
});
/** Punto lógico de la escena (640×270) bajo el ratón. */
function puntoEscena(ev) {
  const r = cv.getBoundingClientRect();
  return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
}
cv.addEventListener('click', (ev) => {
  const p = puntoEscena(ev);
  if (ganchos.clic?.some((g) => g(p))) return;
  // ¿Un agente de pie (café, sofá, caminando)?
  for (const a of agentes) {
    const pos = a.pose === 'sofa' ? { x: SOFA[a.destino.k].x, y: SOFA_Y + 10 } : a.pose === 'escritorio' ? null : { x: a.x, y: a.y };
    if (pos && Math.abs(p.x - pos.x) < 9 && p.y > pos.y - 34 && p.y < pos.y + 2) return abrirLinea(a.i);
  }
  // ¿Un escritorio?
  const i = ESCRITORIOS.findIndex((cx) => Math.abs(p.x - cx) < 34 && p.y > 125 && p.y < 216);
  if (i >= 0) abrirLinea(i);
});
cv.style.cursor = 'pointer';

/* =========================================================== sudor y confeti */
function cabezaDe(a) {
  if (a.pose === 'escritorio') return alEscritorio(a.dato) ? { x: ESCRITORIOS[a.i], y: 159 } : null;
  if (a.pose === 'sofa') return { x: SOFA[a.destino.k].x, y: SOFA_Y - 25 };
  return { x: a.x, y: a.y - 32 };
}
const confeti = [];
const COLORES_CONFETI = ['#ffd166', '#ef476f', '#06d6a0', '#118ab2', '#f4a261', '#c77dff'];
function lanzarConfeti(x, y, n = 40) {
  for (let k = 0; k < n; k++) {
    const ang = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
    const v = 40 + Math.random() * 70;
    confeti.push({ x, y, vx: Math.cos(ang) * v, vy: Math.sin(ang) * v, vida: 1.6 + Math.random() * 1.2, c: COLORES_CONFETI[k % COLORES_CONFETI.length] });
  }
}
ganchos.mover.push((dt) => {
  for (const p of confeti) { p.vy += 90 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.985; p.vida -= dt; }
  for (let k = confeti.length - 1; k >= 0; k--) if (confeti[k].vida <= 0) confeti.splice(k, 1);
});
ganchos.encima.push((t) => {
  for (const a of agentes) {
    if (!a.dato?.suda) continue;
    const c = cabezaDe(a);
    if (!c) continue;
    for (let k = 0; k < 3; k++) {
      const p = ((t / 650) + k / 3 + a.n * 0.17) % 1;
      const x = c.x + (k - 1) * 8 - 1;
      const y = c.y + 1 + p * 9;
      X.globalAlpha = 1 - p * 0.8;
      R(x, y, 2, 3, '#5fb0f0'); R(x, y, 1, 1, '#e6f7ff'); R(x + 1, y - 1, 1, 1, '#9fd6ff'); R(x, y + 3, 2, 1, '#3d8fd0');
      X.globalAlpha = 1;
    }
  }
  for (const p of confeti) { X.globalAlpha = Math.min(1, p.vida); R(p.x, p.y, 2, 1 + ((p.x | 0) % 2), p.c); }
  X.globalAlpha = 1;
});

/* =========================================================== cada refresco */
const aceptadosVistos = new Set();
ganchos.datos.push((e, primera) => {
  pintarCarga(e.carga);
  pintarDevelop(e.develop);
  pintarControl(e);
  for (const ac of e.aceptados ?? []) {
    const clave = `${ac.id}|${ac.at}`;
    if (aceptadosVistos.has(clave)) continue;
    aceptadosVistos.add(clave);
    if (primera) continue;
    const a = agentes.find((x) => Number(x.dato?.ticket) === Number(ac.id));
    const c = a ? cabezaDe(a) ?? { x: ESCRITORIOS[a.i], y: 150 } : { x: JEFE_X, y: 135 };
    lanzarConfeti(c.x, c.y);
    window.dispatchEvent(new CustomEvent('oficina:pr-cerrado', { detail: { ticket: ac.id, agente: a?.i ?? null } }));
  }
});

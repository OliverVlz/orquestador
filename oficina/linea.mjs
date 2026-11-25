// Línea de tiempo de un ticket: start, cada vuelta de implementación y de revisión (con su dictamen), QA, PR y Done.
// Las fechas salen del historial y de los archivos de progress/tickets/<id>/<repo>/. El PR se busca con az solo al
// abrir la línea de tiempo y queda en caché en progress/oficina/prs.json (30 min).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const PR_CACHE_MS = 30 * 60_000;
const mtime = (ruta) => {
  try {
    return statSync(ruta).mtimeMs;
  } catch {
    return 0;
  }
};

export function crearLinea({ PROGRESS, leerJson, escribirJson, az, repoCfg }) {
  const CACHE = join(PROGRESS, 'oficina', 'prs.json');

  function urlPr(r, n) {
    return `${r.ado.organization.replace(/\/+$/, '')}/${encodeURIComponent(r.ado.project)}/_git/${encodeURIComponent(r.repository)}/pullrequest/${n}`;
  }

  async function prDe(id, repo, eventos) {
    const r = repoCfg(repo);
    if (!r?.ado) return null;
    const aceptado = eventos.findLast((e) => e.event === 'aceptado' && e.pr);
    if (aceptado) return { id: aceptado.pr, estado: 'aceptado', url: urlPr(r, aceptado.pr) };
    const cache = leerJson(CACHE) ?? {};
    const clave = `${id}|${repo}`;
    const guardado = cache[clave];
    if (guardado && Date.now() - Date.parse(guardado.consultado) < PR_CACHE_MS)
      return guardado.id ? { ...guardado, url: urlPr(r, guardado.id) } : null;
    const rama = eventos.findLast((e) => e.branch)?.branch;
    if (!rama) return null;
    try {
      const lista = await az(['repos', 'pr', 'list', '--org', r.ado.organization, '--project', r.ado.project,
        '--repository', r.repository, '--source-branch', rama, '--status', 'all', '--top', '5',
        '--query', '[].{id:pullRequestId,estado:status}', '-o', 'json']);
      const pr = Array.isArray(lista) ? lista[0] : null;
      cache[clave] = { id: pr?.id ?? null, estado: pr?.estado ?? null, consultado: new Date().toISOString() };
      escribirJson(CACHE, cache);
      return pr ? { ...cache[clave], url: urlPr(r, pr.id) } : null;
    } catch {
      return guardado?.id ? { ...guardado, url: urlPr(r, guardado.id), viejo: true } : null;
    }
  }

  /** Eventos ordenados con la duración desde el anterior. `cerrados` es la lista de Azure (Done con fecha). */
  async function lineaDe(id, repo, historial, cerrados = []) {
    const tdir = join(PROGRESS, 'tickets', String(id));
    const rdir = join(tdir, repo);
    const meta = leerJson(join(tdir, 'ticket.json')) ?? {};
    const eventos = historial.filter((e) => e.id === id && (!e.repo || e.repo === repo));
    const lista = [];
    let revisiones = 0;
    let implementaciones = 0;
    for (const e of eventos) {
      const motor = e.motor && e.motor !== 'orquestador' ? e.motor : '';
      const r = e.resultado ?? '';
      if (e.event === 'iniciado') lista.push({ at: e.at, tipo: 'start', titulo: 'Start', detalle: e.branch ?? '' });
      else if (e.event === 'trabajo' && e.rol === 'reviewer') {
        if (r === 'APROBADO' || r === 'CAMBIOS') {
          revisiones++;
          lista.push({ at: e.at, tipo: r === 'APROBADO' ? 'aprobado' : 'cambios', titulo: `Revisión ${revisiones} · ${r}`, detalle: motor });
        } else if (/PENDIENTE/.test(r)) lista.push({ at: e.at, tipo: 'lanzado', titulo: `Revisión ${revisiones + 1} lanzada`, detalle: motor });
        else lista.push({ at: e.at, tipo: 'otro', titulo: `Reviewer · ${r}`, detalle: motor });
      } else if (e.event === 'trabajo') {
        if (r === 'LISTO') {
          implementaciones++;
          lista.push({ at: e.at, tipo: 'impl', titulo: `Implementación ${implementaciones} lista`, detalle: motor });
        } else if (/PENDIENTE/.test(r)) lista.push({ at: e.at, tipo: 'lanzado', titulo: 'Implementer lanzado', detalle: motor });
        else lista.push({ at: e.at, tipo: /BLOQUEADO|FALL|CONFLICTO/.test(r) ? 'alerta' : 'otro', titulo: `Implementer · ${r}`, detalle: motor });
      } else if (e.event === 'pregunta') lista.push({ at: e.at, tipo: 'pregunta', titulo: 'Pregunta a la persona', detalle: String(e.note ?? '').slice(0, 200) });
      else if (e.event === 'respondido') lista.push({ at: e.at, tipo: 'respuesta', titulo: 'Pregunta respondida' });
      else if (e.event === 'en-prueba') lista.push({ at: e.at, tipo: 'qa', titulo: 'QA · en la rama de pruebas', detalle: e.hash ?? '' });
      else if (e.event === 'falló') lista.push({ at: e.at, tipo: 'alerta', titulo: 'Falló en la prueba', detalle: String(e.note ?? '').slice(0, 200) });
      else if (e.event === 'aceptado') lista.push({ at: e.at, tipo: 'pr', titulo: `PR ${e.pr ?? ''} aprobado y en autocompletar`.replace('  ', ' ') });
      else if (e.event === 'limpio') lista.push({ at: e.at, tipo: 'otro', titulo: 'Carpetas limpias' });
    }
    // Inicio de cada vuelta: la fecha del brief que la arrancó.
    if (existsSync(rdir))
      for (const f of readdirSync(rdir)) {
        const m = /^brief-(implementer|reviewer)-(\d+)\.md$/.exec(f);
        if (m) lista.push({ at: new Date(mtime(join(rdir, f))).toISOString(), tipo: 'brief', titulo: `Brief ${m[1]} ${m[2]}` });
      }
    const done = cerrados.find((x) => Number(x.id) === id);
    if (done?.at) lista.push({ at: done.at, tipo: 'done', titulo: 'Done en Azure' });

    lista.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    lista.forEach((e, i) => { e.durMin = i ? Math.round((Date.parse(e.at) - Date.parse(lista[i - 1].at)) / 60_000) : 0; });
    const inicio = lista[0]?.at ?? null;
    const fin = lista.at(-1)?.at ?? null;
    return {
      ticket: id,
      repo,
      titulo: meta.title ?? `Ticket ${id}`,
      talla: meta.talla ?? null,
      eventos: lista,
      totalMin: inicio && fin ? Math.round((Date.parse(fin) - Date.parse(inicio)) / 60_000) : 0,
      pr: await prDe(id, repo, eventos),
    };
  }

  return { lineaDe };
}

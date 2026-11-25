// Avisos al celular con ntfy.sh y el estado de develop según sus pipelines de Azure.
// Nada sale si no hay un tema elegido en config.local.json (ntfy.activo y ntfy.tema). Los mensajes llevan solo el id
// del ticket y su estado: nada de nombres, correos, rutas ni secretos.

const ESTADO_AVISO = {
  'pruebas-largas': 'colgado: pruebas largas',
  'sin-trabajo': 'colgado: sin trabajo vivo',
  persona: 'esperando respuesta',
  bloqueado: 'bloqueado',
};

export function crearAvisos({ ajustes, az, log }) {
  const previo = new Map(); // id → último estado avisable
  let primeraVuelta = true;
  let ultimoEnvio = null;
  const develop = { at: null, ok: null, pipelines: [], rojos: [], error: null };
  const previoDevelop = new Map(); // id de pipeline → último resultado

  const configurado = () => {
    const n = ajustes().ntfy ?? {};
    return Boolean(n.activo && String(n.tema ?? '').trim());
  };

  async function enviar(texto) {
    if (!configurado()) return false;
    const n = ajustes().ntfy;
    const url = `${String(n.servidor || 'https://ntfy.sh').replace(/\/+$/, '')}/${encodeURIComponent(String(n.tema).trim())}`;
    try {
      const r = await fetch(url, { method: 'POST', body: texto, headers: { Title: 'Oficina', Tags: 'office' }, signal: AbortSignal.timeout(10_000) });
      ultimoEnvio = { at: new Date().toISOString(), ok: r.ok };
      return r.ok;
    } catch (e) {
      ultimoEnvio = { at: new Date().toISOString(), ok: false };
      log(`ntfy: ${e?.message ?? e}`);
      return false;
    }
  }

  /** Avisa cuando un agente pasa a colgado (con causa nueva) o a bloqueado. La primera vuelta solo toma la foto. */
  function revisarAgentes(agentes) {
    for (const a of agentes) {
      if (a.ticket == null) continue;
      const id = Number(a.ticket);
      const estado = a.colgado ? ESTADO_AVISO[a.colgado.causa] ?? 'colgado' : a.modo === 'bloqueado' ? 'bloqueado' : null;
      if (!primeraVuelta && estado && previo.get(id) !== estado) enviar(`#${id} ${estado}`);
      previo.set(id, estado);
    }
    primeraVuelta = false;
  }

  /** Último run terminado de cada pipeline sobre develop; avisa cuando uno pasa a fallido. */
  async function revisarDevelop(ados) {
    try {
      const pipelines = [];
      for (const ado of ados) {
        const runs = await az(['pipelines', 'runs', 'list', '--org', ado.organization, '--project', ado.project,
          '--branch', 'refs/heads/develop', '--top', '30', '-o', 'json']);
        const porDefinicion = new Map();
        for (const r of Array.isArray(runs) ? runs : []) {
          if (r.status !== 'completed' || porDefinicion.has(r.definition?.id)) continue;
          porDefinicion.set(r.definition?.id, { id: r.definition?.id, nombre: r.definition?.name ?? '?', resultado: r.result, fin: r.finishTime });
        }
        pipelines.push(...porDefinicion.values());
      }
      for (const p of pipelines) {
        const antes = previoDevelop.get(p.id);
        if (antes !== undefined && antes !== 'failed' && p.resultado === 'failed') enviar(`develop en rojo (pipeline ${p.id})`);
        previoDevelop.set(p.id, p.resultado);
      }
      Object.assign(develop, {
        at: new Date().toISOString(), ok: true, error: null, pipelines,
        rojos: pipelines.filter((p) => p.resultado === 'failed').map((p) => p.nombre),
      });
    } catch (e) {
      Object.assign(develop, { ok: false, error: String(e?.message ?? e).slice(0, 200) });
    }
  }

  return {
    revisarAgentes,
    revisarDevelop,
    enviar,
    develop,
    estado: () => ({ configurado: configurado(), ultimoEnvio }),
  };
}

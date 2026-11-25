// Ajustes de la oficina: config.example.json (versionado) con config.local.json (de cada PC) encima.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const POR_DEFECTO = {
  carga: { ramLibreMinPct: 15, nodePorAgenteMax: 6 },
  colgados: { pruebasLargasMin: 15, sinActividadMin: 20 },
  huerfanos: { viejosMin: 30 },
  ntfy: { activo: false, servidor: 'https://ntfy.sh', tema: '' },
  develop: { cadaMin: 15 },
};

const leer = (ruta) => {
  try {
    return JSON.parse(readFileSync(ruta, 'utf8'));
  } catch {
    return null;
  }
};
const esObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const fusionar = (base, encima) => {
  const salida = { ...base };
  for (const [k, v] of Object.entries(encima ?? {})) salida[k] = esObjeto(v) && esObjeto(base?.[k]) ? fusionar(base[k], v) : v;
  return salida;
};

/** Devuelve una función que lee los ajustes (con caché de 10 s: se pueden cambiar sin reiniciar). */
export function crearAjustes(dir) {
  let cache = null;
  let leido = 0;
  return () => {
    if (cache && Date.now() - leido < 10_000) return cache;
    cache = fusionar(fusionar(POR_DEFECTO, leer(join(dir, 'config.example.json'))), leer(join(dir, 'config.local.json')));
    leido = Date.now();
    return cache;
  };
}

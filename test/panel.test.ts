import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { parseConfig } from '../src/config.ts';
import { crearServidor, monograma } from '../src/panel.ts';
import { parseValidacion } from '../src/validacion.ts';

const RAW = JSON.parse(readFileSync(new URL('../orquestador.ejemplo.json', import.meta.url), 'utf8'));
const cfg = parseConfig(RAW, 'C:\\ws', { qa: 'oliver' });

describe('panel', () => {
  const server = crearServidor({ token: 'secreto', cargarConfig: () => cfg, leerDatos: () => ({ prueba: true }) });
  let base = '';
  before(async () => {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it('sirve la página con la marca y el token', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<title>Panel · Mi Equipo<\/title>/);
    assert.match(html, /name="orq-token" content="secreto"/);
    assert.match(html, /MiProyecto/);
  });

  it('el script de la página compila (las barras de los regex sobreviven a la plantilla)', async () => {
    const html = await (await fetch(`${base}/`)).text();
    const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length > 0);
    // new Function solo compila: si hay un error de sintaxis, el panel se queda en «Cargando…».
    for (const codigo of scripts) assert.doesNotThrow(() => new Function(codigo.replace(/^\s*import\s.*$/gm, '')));
  });

  it('devuelve los datos como JSON', async () => {
    assert.deepEqual(await (await fetch(`${base}/api/datos`)).json(), { prueba: true });
  });

  it('responder exige el token y un ticket con respuesta', async () => {
    const enviar = (headers: Record<string, string>, body: unknown) =>
      fetch(`${base}/api/responder`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    assert.equal((await enviar({}, { id: 1, texto: 'sí' })).status, 403);
    assert.equal((await enviar({ 'X-Token': 'otro' }, { id: 1, texto: 'sí' })).status, 403);
    assert.equal((await enviar({ 'X-Token': 'secreto' }, { id: 1, texto: '  ' })).status, 400);
    assert.equal((await enviar({ 'X-Token': 'secreto' }, { id: 'x', texto: 'sí' })).status, 400);
  });

  it('dibuja el monograma de la marca en claro y en oscuro', async () => {
    const svg = await (await fetch(`${base}/logo.svg`)).text();
    assert.match(svg, />ME<\/text>/);
    assert.notEqual(monograma('XK', true), monograma('XK', false));
    assert.match(monograma('x-k!', false), />XK</);
  });

  it('no existe lo que no es del panel', async () => {
    assert.equal((await fetch(`${base}/../orquestador.json`)).status, 404);
  });

  it('las capturas solo salen de repos configurados, con nombre de imagen y sin rutas', async () => {
    for (const ruta of [
      '/captura/128/mi_backend/..%2F..%2Fticket.md',
      '/captura/128/mi_backend/validacion-ia.md',
      '/captura/128/otro_repo/01-x.png',
      '/captura/abc/mi_backend/01-x.png',
      '/captura/128/mi_backend/no-existe.png',
    ]) assert.equal((await fetch(`${base}${ruta}`)).status, 404, ruta);
  });
});

describe('validación IA', () => {
  const INFORME = [
    'RESULTADO: FALLÓ',
    'FECHA: 2026-11-04T18:00:00Z',
    'QA: 3589549',
    '',
    '## Criterios',
    '- [✔] Sube el archivo — 201 y URL firmada (captura: 01-subida.png)',
    '- [✘] Expira a los 15 min — sigue abierta a los 20',
    '- [–] Correo real — sin llave de Resend',
    '',
    '## Hallazgos',
    '1. src/x.ts:10 — la expiración no se aplica.',
    '',
    '## Capturas',
    '- 01-subida.png — la subida',
    '- 02-fantasma.png — citada pero no guardada',
  ].join('\n');

  it('lee resultado, criterios, hallazgos y solo las capturas que existen', () => {
    const v = parseValidacion(INFORME, ['01-subida.png', 'notas.txt']);
    assert.ok(v);
    assert.equal(v.resultado, 'FALLÓ');
    assert.equal(v.qa, '3589549');
    assert.deepEqual(v.criterios.map((c) => c.marca), ['✔', '✘', '–']);
    assert.match(v.hallazgos, /expiración/);
    assert.deepEqual(v.capturas, [{ archivo: '01-subida.png', descripcion: 'la subida' }]);
  });

  it('sin un RESULTADO reconocible no hay validación', () => {
    assert.equal(parseValidacion('hola', []), null);
    assert.equal(parseValidacion('RESULTADO: PASO\n', [])?.resultado, 'PASÓ');
  });
});

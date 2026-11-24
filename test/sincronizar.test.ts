import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { revisionMecanica, sincronizarConBase } from '../src/sincronizar.ts';

const raiz = mkdtempSync(join(tmpdir(), 'orq-sync-'));
after(() => rmSync(raiz, { recursive: true, force: true }));

const sh = (cwd: string, ...args: string[]) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const escribir = (dir: string, f: string, t: string) => {
  mkdirSync(join(dir, f, '..'), { recursive: true });
  writeFileSync(join(dir, f), t);
};

/** Un "origin" con rama develop y un clon con la rama del ticket. */
function escenario(nombre: string) {
  const origin = join(raiz, `${nombre}-origin`);
  const clon = join(raiz, nombre);
  mkdirSync(origin);
  sh(origin, 'init', '-q', '-b', 'develop');
  escribir(origin, 'openapi.json', '{"v":0}\n');
  escribir(origin, 'a.txt', 'a\n');
  sh(origin, 'add', '.');
  sh(origin, 'commit', '-q', '-m', 'base');
  sh(raiz, 'clone', '-q', origin, clon);
  sh(clon, 'switch', '-q', '-c', 'feat/1');
  return { origin, clon };
}
const avanzarOrigin = (origin: string, clon: string, f: string, t: string) => {
  escribir(origin, f, t);
  sh(origin, 'add', '.');
  sh(origin, 'commit', '-q', '-m', `develop ${f}`);
  sh(clon, 'fetch', '-q', 'origin');
};

describe('sincronizar con la base', () => {
  it('no hace nada si la rama ya incluye la base', () => {
    const { clon } = escenario('al-dia');
    const s = sincronizarConBase({}, clon, 'origin/develop');
    assert.equal(s.estado, 'al-dia');
  });

  it('fusiona cuando la base avanzó sin chocar', () => {
    const { origin, clon } = escenario('limpio');
    escribir(clon, 'b.txt', 'b\n');
    sh(clon, 'add', '.');
    sh(clon, 'commit', '-q', '-m', 'ticket');
    avanzarOrigin(origin, clon, 'c.txt', 'c\n');
    const s = sincronizarConBase({}, clon, 'origin/develop');
    assert.equal(s.estado, 'fusionado');
    assert.equal(readFileSync(join(clon, 'c.txt'), 'utf8'), 'c\n');
  });

  it('no toca una carpeta con cambios sin confirmar', () => {
    const { origin, clon } = escenario('sucio');
    avanzarOrigin(origin, clon, 'c.txt', 'c\n');
    escribir(clon, 'a.txt', 'cambiado\n');
    assert.equal(sincronizarConBase({}, clon, 'origin/develop').estado, 'sucio');
  });

  it('omite los tickets apilados (la base no es origin/…)', () => {
    const { clon } = escenario('apilado');
    assert.equal(sincronizarConBase({}, clon, 'feat/otro').estado, 'omitido');
  });

  it('regenera cuando solo chocan archivos generados', () => {
    const { origin, clon } = escenario('generado');
    escribir(clon, 'openapi.json', '{"v":0,"ticket":true}\n');
    sh(clon, 'add', '.');
    sh(clon, 'commit', '-q', '-m', 'ticket');
    avanzarOrigin(origin, clon, 'openapi.json', '{"v":1}\n');
    const repo = { generados: ['openapi.json'], regenerar: `node -e "require('fs').writeFileSync('openapi.json','{\\"regenerado\\":true}\\n')"` };
    const s = sincronizarConBase(repo, clon, 'origin/develop');
    assert.equal(s.estado, 'regenerado');
    assert.deepEqual(s.archivos, ['openapi.json']);
    assert.equal(readFileSync(join(clon, 'openapi.json'), 'utf8'), '{"regenerado":true}\n');
    assert.equal(sh(clon, 'status', '--porcelain').trim(), '');
  });

  it('con un conflicto real aborta el merge y lista los archivos', () => {
    const { origin, clon } = escenario('real');
    escribir(clon, 'a.txt', 'ticket\n');
    sh(clon, 'add', '.');
    sh(clon, 'commit', '-q', '-m', 'ticket');
    avanzarOrigin(origin, clon, 'a.txt', 'develop\n');
    const s = sincronizarConBase({ generados: ['openapi.json'], regenerar: 'true' }, clon, 'origin/develop');
    assert.equal(s.estado, 'conflicto');
    assert.deepEqual(s.archivos, ['a.txt']);
    assert.equal(sh(clon, 'status', '--porcelain').trim(), '', 'no deja un merge a medias');
    assert.equal(readFileSync(join(clon, 'a.txt'), 'utf8'), 'ticket\n');
  });

  it('si el regenerador falla, aborta y deja la rama limpia', () => {
    const { origin, clon } = escenario('regenera-mal');
    escribir(clon, 'openapi.json', '{"t":1}\n');
    sh(clon, 'add', '.');
    sh(clon, 'commit', '-q', '-m', 'ticket');
    avanzarOrigin(origin, clon, 'openapi.json', '{"v":1}\n');
    const s = sincronizarConBase({ generados: ['openapi.json'], regenerar: 'exit 3' }, clon, 'origin/develop');
    assert.equal(s.estado, 'conflicto');
    assert.equal(sh(clon, 'status', '--porcelain').trim(), '');
  });
});

describe('revisión mecánica antes del reviewer', () => {
  it('pide «Cómo probarlo» y pasa cuando está', () => {
    const { clon } = escenario('mecanica');
    const informe = join(raiz, 'impl.md');
    writeFileSync(informe, 'ESTADO: LISTO\n\n## Resumen\nhecho\n');
    assert.equal(revisionMecanica(clon, informe).length, 1);
    writeFileSync(informe, 'ESTADO: LISTO\n\n## Cómo probarlo\nPaso 1\n');
    assert.deepEqual(revisionMecanica(clon, informe), []);
  });

  it('bloquea con cambios sin confirmar', () => {
    const { clon } = escenario('mecanica-sucia');
    const informe = join(raiz, 'impl2.md');
    writeFileSync(informe, '## Cómo probarlo\nok\n');
    escribir(clon, 'a.txt', 'x\n');
    assert.equal(revisionMecanica(clon, informe).length, 1);
  });
});

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { RepoCfg } from '../src/config.ts';
import { lineasCuentas, rolesDeTexto } from '../src/vistas.ts';

const raiz = mkdtempSync(join(tmpdir(), 'orq-guia-'));
after(() => rmSync(raiz, { recursive: true, force: true }));

describe('cuentas de prueba en la guía', () => {
  it('detecta los roles que menciona un ticket, sin confundir nombres parecidos', () => {
    const roles = ['ADMIN', 'DIRECCION_JURIDICA', 'DIRECCION_CONTRATACION', 'PROVEEDOR'];
    const texto = 'POST /api/x con un usuario rol `DIRECCION_JURIDICA`; el PROVEEDOR no puede. Un SUPERADMIN_X no cuenta.';
    assert.deepEqual(rolesDeTexto(roles, texto), ['DIRECCION_JURIDICA', 'PROVEEDOR']);
    assert.deepEqual(rolesDeTexto(roles, 'sin roles'), []);
  });

  it('llena {env:VAR} con el .env.example (no el .env) y {qa} con la carpeta de pruebas', () => {
    writeFileSync(join(raiz, '.env.example'), 'USUARIO=prueba@x.test\nCLAVE=Ejemplo1!\n');
    writeFileSync(join(raiz, '.env'), 'USUARIO=real@x.test\nCLAVE=SecretoReal\n');
    const repo = { dir: 'back', path: raiz, worktrees: 'backend', cuentas: { roles: [], como: ['entra con {env:USUARIO} / {env:CLAVE}', 'falta {env:NO_ESTA}'] } } as unknown as RepoCfg;
    const [a, b] = lineasCuentas(repo);
    assert.equal(a, 'entra con prueba@x.test / Ejemplo1!');
    assert.ok(!a.includes('SecretoReal'));
    assert.equal(b, 'falta <NO_ESTA>');
  });

  it('sin cuentas configuradas no devuelve nada', () => {
    assert.deepEqual(lineasCuentas({ dir: 'x', path: raiz } as unknown as RepoCfg), []);
  });
});

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { vidaDe, type Senales } from '../oficina/vivo.ts';

const ahora = Date.parse('2026-11-25T12:00:00Z');
const min = 60_000;
const sinNada: Senales = {
  rolProceso: null,
  nodosEnWorktree: 0,
  ultimaActividadMs: 0,
  pendienteDesktop: null,
  asignado: true,
  revisionEnCurso: false,
};

describe('oficina: ¿el ticket tiene trabajo vivo?', () => {
  test('desktop sin proceso orq pero con actividad reciente: vivo, no detenido', () => {
    const v = vidaDe({ ...sinNada, ultimaActividadMs: ahora - 3 * min, pendienteDesktop: { rol: 'implementer', desdeMs: ahora - 90 * min } }, ahora, 15);
    assert.equal(v.vivo, true);
    assert.equal(v.rol, 'implementer');
    assert.deepEqual(v.por, ['actividad']);
  });

  test('node corriendo en su worktree cuenta aunque no cambie ningún archivo', () => {
    const v = vidaDe({ ...sinNada, nodosEnWorktree: 3, ultimaActividadMs: ahora - 40 * min }, ahora, 15);
    assert.equal(v.vivo, true);
    assert.deepEqual(v.por, ['node']);
  });

  test('sesión desktop recién lanzada y asignada: viva antes de tocar archivos; sin asignar, no', () => {
    const pendiente = { rol: 'reviewer' as const, desdeMs: ahora - 2 * min };
    const asignado = vidaDe({ ...sinNada, pendienteDesktop: pendiente }, ahora, 15);
    assert.equal(asignado.vivo, true);
    assert.equal(asignado.rol, 'reviewer');
    assert.equal(vidaDe({ ...sinNada, pendienteDesktop: pendiente, asignado: false }, ahora, 15).vivo, false);
  });

  test('la revisión en curso (brief o pendiente del reviewer) da el rol reviewer', () => {
    const v = vidaDe({ ...sinNada, ultimaActividadMs: ahora - min, revisionEnCurso: true }, ahora, 15);
    assert.equal(v.rol, 'reviewer');
  });

  test('el proceso orq.ts trabajar manda en el rol', () => {
    const v = vidaDe({ ...sinNada, rolProceso: 'implementer', revisionEnCurso: true }, ahora, 15);
    assert.deepEqual(v, { vivo: true, rol: 'implementer', por: ['proceso'] });
  });

  test('sin ninguna señal durante la ventana: detenido (el subagente esperaba una tarea que ya murió)', () => {
    const v = vidaDe({ ...sinNada, ultimaActividadMs: ahora - 16 * min, pendienteDesktop: { rol: 'reviewer', desdeMs: ahora - 300 * min } }, ahora, 15);
    assert.deepEqual(v, { vivo: false, rol: null, por: [] });
  });
});

import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { cadena, parseConfig, parseSpec, reposPorEtiquetas, tallaDe, tituloDePr } from '../src/config.ts';
import { carpetasDe, rutaWorktree } from '../src/git.ts';
import { boardState, rondasDeCambios, type Evento } from '../src/historial.ts';
import { install, plan } from '../src/instalar.ts';
import { clasificar } from '../src/motores/correr.ts';
import { MOTORES } from '../src/motores/registro.ts';
import type { Trabajo } from '../src/motores/tipos.ts';
import { leerDictamen, leerInformeImpl, renderRol } from '../src/roles.ts';
import { cadenaDe, planDeFlags } from '../src/tickets.ts';
import { desdeShimNpm, parseArgs, readSection } from '../src/util.ts';

const tmp = mkdtempSync(join(tmpdir(), 'orq-test-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

const RAW = JSON.parse(readFileSync(new URL('../orquestador.ejemplo.json', import.meta.url), 'utf8'));

describe('configuración', () => {
  const cfg = parseConfig(RAW, 'C:\\ws', { qa: 'oliver' });

  it('lee el proyecto del ejemplo con sus dos repos', () => {
    const [p] = cfg.proyectos;
    assert.equal(p.nombre, 'miproyecto');
    assert.equal(p.ramaBase, 'main');
    assert.deepEqual(p.repos.map((r) => r.dir), ['mi_backend', 'mi_frontend']);
    assert.equal(p.repos[0].path, join('C:\\ws', 'mi_backend'));
    assert.equal(cfg.qa, 'oliver');
  });

  it('cada repo tiene su subcarpeta de worktrees y no se pueden repetir', () => {
    const [p] = cfg.proyectos;
    assert.deepEqual(p.repos.map((r) => r.worktrees), ['backend', 'frontend']);
    const sinGrupo = { ...RAW, proyectos: [{ ...RAW.proyectos[0], repos: RAW.proyectos[0].repos.map(({ worktrees: _w, ...r }: { worktrees?: string }) => r) }] };
    assert.deepEqual(parseConfig(sinGrupo).proyectos[0].repos.map((r) => r.worktrees), ['mi_backend', 'mi_frontend']);
    const repetido = { ...RAW, proyectos: [{ ...RAW.proyectos[0], repos: RAW.proyectos[0].repos.map((r: object) => ({ ...r, worktrees: 'backend' })) }] };
    assert.throws(() => parseConfig(repetido), /comparten "worktrees"/);
    const raro = { ...RAW, proyectos: [{ ...RAW.proyectos[0], repos: RAW.proyectos[0].repos.map((r: object) => ({ ...r, worktrees: '../fuera' })) }] };
    assert.throws(() => parseConfig(raro), /nombre de carpeta simple/);
  });

  it('asigna repos por etiqueta y «Ambos» va a los dos, back primero', () => {
    const [p] = cfg.proyectos;
    assert.deepEqual(reposPorEtiquetas(p, ['Backend', 'M']).map((r) => r.dir), ['mi_backend']);
    assert.deepEqual(reposPorEtiquetas(p, ['frontend']).map((r) => r.dir), ['mi_frontend']);
    assert.deepEqual(reposPorEtiquetas(p, ['Ambos', 'S']).map((r) => r.dir), ['mi_backend', 'mi_frontend']);
    assert.deepEqual(reposPorEtiquetas(p, ['correo']), []);
  });

  it('saca la talla de las etiquetas y usa la cadena de esa talla o la por defecto', () => {
    assert.equal(tallaDe(['Backend', 'XL', 'Opus']), 'XL');
    assert.equal(tallaDe(['producto']), '*');
    assert.equal(cadena(cfg, 'implementer', 'XS')[0].texto, 'agy:gemini-3.8-flash-medium');
    assert.equal(cadena(cfg, 'reviewer', 'XS')[0].texto, 'claude:sonnet');
    assert.equal(cadena(cfg, 'reviewer', '*')[0].texto, 'claude:opus');
  });

  it('arma el título del PR con la plantilla del proyecto', () => {
    assert.equal(cfg.proyectos[0].tituloPr, '{titulo}');
    assert.equal(cfg.proyectos[0].squash, false);
    assert.equal(tituloDePr('{titulo}', 84, 'feat(pagos): cobra'), 'feat(pagos): cobra');
    assert.equal(tituloDePr('[{id}] {titulo}', 84, 'feat(pagos): cobra'), '[84] feat(pagos): cobra');
    assert.equal(tituloDePr('[{id}] {titulo}', 84, '[84] feat(pagos): cobra'), '[84] feat(pagos): cobra');
  });

  it('separa motor, modelo y esfuerzo', () => {
    assert.deepEqual(parseSpec('codex:gpt-6-sol:high'), { motor: 'codex', modelo: 'gpt-6-sol', esfuerzo: 'high', texto: 'codex:gpt-6-sol:high' });
    assert.equal(parseSpec('claude:opus').esfuerzo, null);
    assert.throws(() => parseSpec('claude'));
  });

  it('rechaza configuraciones incompletas', () => {
    assert.throws(() => parseConfig({ ...RAW, proyectos: [] }), /no hay proyectos/);
    assert.throws(() => parseConfig({ ...RAW, motores: { implementer: { '*': ['claude:opus'] } } }), /reviewer/);
    assert.throws(() => parseConfig(RAW, 'C:\\ws', { qa: 'Oliver Velasquez' }), /qa debe ser/);
  });

  it('todos los motores de las cadenas existen en el registro', () => {
    for (const porTalla of Object.values(cfg.motores))
      for (const specs of Object.values(porTalla))
        for (const spec of specs) assert.ok(MOTORES[parseSpec(spec).motor], spec);
  });
});

describe('carpetas de trabajo', () => {
  const repo = { dir: 'mi_backend', worktrees: 'backend' };

  it('van en worktrees/<grupo>/<id> y la de pruebas en worktrees/<grupo>/qa', () => {
    const nada = () => false;
    assert.equal(rutaWorktree('C:\\ws', repo, 84, nada), join('C:\\ws', 'worktrees', 'backend', '84'));
    assert.equal(rutaWorktree('C:\\ws', repo, 'qa', nada), join('C:\\ws', 'worktrees', 'backend', 'qa'));
  });

  it('una carpeta del esquema anterior se sigue usando hasta que se migra', () => {
    const antigua = join('C:\\ws', 'mi_backend--84');
    const nueva = join('C:\\ws', 'worktrees', 'backend', '84');
    assert.equal(rutaWorktree('C:\\ws', repo, 84, (p) => p === antigua), antigua);
    assert.equal(rutaWorktree('C:\\ws', repo, 84, (p) => p === antigua || p === nueva), nueva);
  });

  it('junta las carpetas de los dos esquemas y deja fuera las de otros repos', () => {
    const ws = join(tmp, 'ws-carpetas');
    for (const d of ['worktrees/backend/84', 'worktrees/backend/qa', 'worktrees/frontend/84', 'mi_backend--70', 'mi_backend', 'mi_backend_v2--1'])
      mkdirSync(join(ws, d), { recursive: true });
    assert.deepEqual(
      carpetasDe(repo, ws).map((d) => d.slice(ws.length + 1).replaceAll('\\', '/')).sort(),
      ['mi_backend--70', 'worktrees/backend/84', 'worktrees/backend/qa'],
    );
  });
});

describe('plan de un ticket', () => {
  const cfg = parseConfig(RAW, 'C:\\ws');

  it('las cadenas elegidas al planear mandan sobre las de la talla', () => {
    const plan = planDeFlags({ talla: 'l', implementer: 'codex:gpt-6-sol:high, claude:opus', nota: 'toca pagos' }, null);
    assert.equal(plan.talla, 'L');
    assert.equal(plan.nota, 'toca pagos');
    assert.ok(plan.planeado);
    assert.deepEqual(cadenaDe(cfg, { talla: 'L', cadenas: plan.cadenas }, 'implementer').map((m) => m.texto), ['codex:gpt-6-sol:high', 'claude:opus']);
    assert.equal(cadenaDe(cfg, { talla: 'L', cadenas: plan.cadenas }, 'reviewer')[0].texto, 'claude:opus');
    assert.equal(cadenaDe(cfg, { talla: 'XS' }, 'implementer')[0].texto, 'agy:gemini-3.8-flash-medium');
  });

  it('conserva lo planeado si no se cambia y rechaza tallas o motores que no existen', () => {
    const previous = { cadenas: { reviewer: ['codex:gpt-6-sol:high'] }, nota: 'n', planeado: '2026-11-01' } as never;
    const plan = planDeFlags({}, previous);
    assert.deepEqual(plan.cadenas, { reviewer: ['codex:gpt-6-sol:high'] });
    assert.equal(plan.planeado, '2026-11-01');
    assert.throws(() => planDeFlags({ talla: 'XXL' }, null), /--talla/);
    assert.throws(() => planDeFlags({ implementer: 'copilot:x' }, null), /Motor desconocido/);
  });
});

describe('utilidades', () => {
  it('lee el destino de un .cmd de npm, saltándose node.exe', () => {
    const dir = join(tmp, 'shim');
    mkdirSync(join(dir, 'node_modules', 'x', 'bin'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', 'x', 'bin', 'x.js'), '');
    writeFileSync(
      join(dir, 'x.cmd'),
      'IF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n)\r\n"%_prog%"  "%dp0%\\node_modules\\x\\bin\\x.js" %*\r\n',
    );
    const bin = desdeShimNpm(join(dir, 'x.cmd'));
    assert.equal(bin?.command, process.execPath);
    assert.deepEqual(bin?.prefix, [join(dir, 'node_modules', 'x', 'bin', 'x.js')]);
  });

  it('parsea argumentos con y sin valor', () => {
    const { positional, flags } = parseArgs(['trabajar', '84', '--rol', 'reviewer', '--dry-run', '--text', 'hola mundo']);
    assert.deepEqual(positional, ['trabajar', '84']);
    assert.deepEqual(flags, { rol: 'reviewer', 'dry-run': true, text: 'hola mundo' });
  });

  it('lee una sección de un markdown', () => {
    const path = join(tmp, 'sec.md');
    writeFileSync(path, '# T\n\n## Resumen\nuno\ndos\n\n## Archivos\n- a\n');
    assert.equal(readSection(path, 'Resumen'), 'uno\ndos');
    assert.equal(readSection(path, 'Nada'), '');
  });
});

describe('historial', () => {
  const ev = (event: Partial<Evento> & Pick<Evento, 'event' | 'id'>, minute: number): Evento => ({
    at: `2026-11-03T10:${String(minute).padStart(2, '0')}:00.000Z`,
    ...event,
  });

  it('una pregunta deja esperando todos los repos del ticket y al responder vuelven a su estado', () => {
    const events = [
      ev({ id: 7, repo: 'mi_backend', event: 'iniciado', title: 'X' }, 1),
      ev({ id: 7, repo: 'mi_frontend', event: 'iniciado' }, 2),
      ev({ id: 7, repo: 'mi_backend', event: 'en-prueba', hash: 'abc' }, 3),
      ev({ id: 7, event: 'pregunta', note: '¿Cuál?' }, 4),
    ];
    const waiting = boardState(events);
    assert.deepEqual(waiting.map((t) => t.state), ['esperando', 'esperando']);
    assert.equal(waiting[0].title, 'X');
    const answered = boardState([...events, ev({ id: 7, event: 'respondido', note: 'Esa' }, 5)]);
    assert.deepEqual(answered.map((t) => [t.repo, t.state]), [['mi_backend', 'en-prueba'], ['mi_frontend', 'iniciado']]);
  });

  it('el trabajo de un motor no cambia el estado pero queda como último paso', () => {
    const [t] = boardState([
      ev({ id: 8, repo: 'r', event: 'iniciado' }, 1),
      ev({ id: 8, repo: 'r', event: 'trabajo', rol: 'implementer', motor: 'agy:m', resultado: 'LISTO' }, 2),
    ]);
    assert.equal(t.state, 'iniciado');
    assert.equal(t.ultimo?.resultado, 'LISTO');
  });

  it('cuenta las vueltas sin aprobar desde el último inicio, por repo', () => {
    const cambios = (repo: string, m: number) => ev({ id: 9, repo, event: 'trabajo', rol: 'reviewer', resultado: 'CAMBIOS' }, m);
    const events = [
      ev({ id: 9, repo: 'a', event: 'iniciado' }, 1),
      cambios('a', 2),
      cambios('b', 3),
      ev({ id: 9, repo: 'a', event: 'trabajo', rol: 'implementer', resultado: 'VERIFICACION_FALLIDA' }, 4),
      ev({ id: 9, repo: 'a', event: 'trabajo', rol: 'reviewer', resultado: 'APROBADO' }, 5),
    ];
    assert.equal(rondasDeCambios(events, 9, 'a'), 2);
    assert.equal(rondasDeCambios(events, 9, 'b'), 1);
    assert.equal(rondasDeCambios([...events, ev({ id: 9, repo: 'a', event: 'iniciado' }, 6)], 9, 'a'), 0);
  });
});

describe('informes de los workers', () => {
  it('lee un informe LISTO y uno BLOQUEADO con su tipo', () => {
    const ok = join(tmp, 'impl-ok.md');
    writeFileSync(ok, 'ESTADO: LISTO\n\n## Resumen\nHice X.\n\n## Archivos\n- a\n');
    assert.deepEqual(leerInformeImpl(ok), { estado: 'LISTO', tipo: null, pregunta: null, resumen: 'Hice X.' });
    const blocked = join(tmp, 'impl-bl.md');
    writeFileSync(blocked, 'ESTADO: BLOQUEADO\nTIPO_BLOQUEO: negocio\nPREGUNTA: ¿Cobramos IVA?\n');
    assert.equal(leerInformeImpl(blocked)?.tipo, 'negocio');
    assert.equal(leerInformeImpl(blocked)?.pregunta, '¿Cobramos IVA?');
  });

  it('ignora un informe viejo o sin formato', () => {
    const path = join(tmp, 'impl-viejo.md');
    writeFileSync(path, 'ESTADO: LISTO\n');
    utimesSync(path, new Date('2020-01-01'), new Date('2020-01-01'));
    assert.equal(leerInformeImpl(path, Date.now() - 1000), null);
    writeFileSync(path, 'Terminé todo, saludos.\n');
    assert.equal(leerInformeImpl(path), null);
  });

  it('lee el dictamen y sus bloqueantes', () => {
    const path = join(tmp, 'review.md');
    writeFileSync(path, 'DICTAMEN: CAMBIOS\nVERIFICACIÓN: tsc ✔ · tests ✘\n\n## Criterios\n- x\n\n## Bloqueantes\n1. a.ts:3 — falla — arreglar\n\n## Sugerencias\n- y\n');
    const d = leerDictamen(path);
    assert.equal(d?.dictamen, 'CAMBIOS');
    assert.equal(d?.bloqueantes, '1. a.ts:3 — falla — arreglar');
    assert.equal(d?.resumen, 'tsc ✔ · tests ✘');
  });

  it('las plantillas de los roles no dejan marcadores sin llenar', () => {
    const vars = { ID: '1', TITULO: 't', PROYECTO: 'p', REPO: 'r', CARPETA: 'c', RAMA: 'b', BASE: 'origin/main', TICKET: 'tk', INFORME: 'i', IMPL: 'im', VERIFICAR: 'v', INSTALAR: 'n', WORKSPACE: 'w', CONTRATO: '', CORRECCIONES: '' };
    assert.match(renderRol('implementer', vars), /ESTADO: LISTO \| BLOQUEADO/);
    assert.match(renderRol('reviewer', vars), /DICTAMEN: APROBADO \| CAMBIOS/);
    const { VERIFICAR: _, ...sinVerificar } = vars;
    assert.throws(() => renderRol('implementer', sinVerificar), /VERIFICAR/);
  });
});

describe('motores', () => {
  const trabajo: Trabajo = { cwd: 'C:\\ws\\r--1', prompt: 'p', promptFile: 'C:\\ws\\progress\\b.md', modelo: 'm', esfuerzo: 'high', dirsExtra: ['C:\\ws\\progress\\tickets\\1'] };

  it('ninguno se salta los permisos sin un sandbox', () => {
    for (const motor of Object.values(MOTORES)) {
      const args = motor.args(trabajo);
      assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'), motor.nombre);
      assert.ok(!args.includes('yolo'), motor.nombre);
      if (args.includes('--dangerously-skip-permissions')) assert.ok(args.includes('--sandbox'), motor.nombre);
    }
  });

  it('cada motor recibe el prompt y la carpeta del informe', () => {
    for (const motor of Object.values(MOTORES).filter((m) => !m.manual)) {
      const args = motor.args(trabajo).join(' ');
      assert.ok(args.includes(trabajo.dirsExtra[0]), `${motor.nombre}: carpeta del informe`);
      assert.ok(motor.stdin(trabajo) === 'p' || args.includes(trabajo.promptFile), `${motor.nombre}: prompt`);
    }
  });

  it('distingue la falta de cuota de un «429» en el código que escribió', () => {
    assert.equal(clasificar(MOTORES.codex, 0, 'const status = 429; // too many requests', '').sinCuota, false);
    assert.equal(clasificar(MOTORES.codex, 1, '', 'ERROR: You exceeded your current quota').sinCuota, true);
    assert.equal(clasificar(MOTORES.claude, 1, 'Claude AI usage limit reached|1730000000', '').sinCuota, true);
    const red = clasificar(MOTORES.agy, 1, '', 'stream error: unexpected EOF');
    assert.deepEqual(red, { sinCuota: false, corteRed: true });
  });
});

describe('instalar', () => {
  it('crea, actualiza y respalda lo que se editó a mano', () => {
    const template = join(tmp, 'plantilla');
    const ws = join(tmp, 'ws');
    mkdirSync(join(template, '.claude'), { recursive: true });
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(template, 'AGENTS.md'), 'v1');
    writeFileSync(join(template, '.claude', 'settings.json'), '{}');
    assert.deepEqual(plan(ws, template).map((s) => s.action), ['crear', 'crear']);
    install(plan(ws, template), ws, template);
    assert.deepEqual(plan(ws, template), []);
    writeFileSync(join(template, 'AGENTS.md'), 'v2');
    assert.deepEqual(plan(ws, template).map((s) => s.action), ['actualizar']);
    writeFileSync(join(ws, 'AGENTS.md'), 'editado a mano');
    assert.deepEqual(plan(ws, template).map((s) => s.action), ['respaldar y actualizar']);
    install(plan(ws, template), ws, template);
    assert.equal(readFileSync(join(ws, 'AGENTS.md'), 'utf8'), 'v2');
  });
});

describe('motor desktop', () => {
  it('es manual: no lanza proceso y siempre está «instalado»', async () => {
    const { binarioDe } = await import('../src/motores/correr.ts');
    const d = MOTORES.desktop;
    assert.ok(d, 'desktop está registrado');
    assert.equal(d.manual, true);
    assert.ok(binarioDe(d));
    assert.deepEqual(parseSpec('desktop:opus:high'), { motor: 'desktop', modelo: 'opus', esfuerzo: 'high', texto: 'desktop:opus:high' });
  });

  it('el motor claude reconoce el límite de sesión como falta de cuota', () => {
    assert.equal(clasificar(MOTORES.claude, 1, "You've hit your session limit · resets 2:50am", '').sinCuota, true);
  });
});

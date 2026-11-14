/**
 * Un ticket dentro del workspace: a qué proyecto y repos pertenece, dónde guarda el orquestador sus
 * archivos (progress/tickets/<id>/) y los comandos que solo leen de Azure (next, show).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  CLOSED_STATES,
  FIELD,
  fetchComments,
  fetchItem,
  parseRelations,
  queryTickets,
  summarize,
  ticketUrl,
  typeRules,
} from './ado.ts';
import {
  PROGRESS,
  ROLES,
  TALLAS,
  WORKSPACE,
  cadena,
  parseSpec,
  reposPorEtiquetas,
  tallaDe,
  type Config,
  type ProyectoCfg,
  type RepoCfg,
  type Rol,
} from './config.ts';
import { MOTORES } from './motores/registro.ts';
import { readHistory } from './historial.ts';
import { fail, flagText, htmlToText, log, type Flags } from './util.ts';

export type Meta = {
  id: number;
  proyecto: string;
  type: string;
  title: string;
  tags: string[];
  talla: string;
  /** Carpetas de los repos del ticket, en el orden en que se trabajan (back antes que front). */
  repos: string[];
  parent: number | null;
  url: string;
  /** Motores elegidos al planear, por rol; sin ellos se usa la cadena de la talla. */
  cadenas?: Partial<Record<Rol, string[]>>;
  /** Notas del plan: orden, dependencias, riesgos, por qué esa talla. */
  nota?: string;
  /** Cuándo se planeó (talla, repos o motores fijados a mano). */
  planeado?: string;
};

export const ticketDir = (id: number): string => join(PROGRESS, 'tickets', String(id));
export const repoWorkDir = (id: number, repo: RepoCfg): string => join(ticketDir(id), repo.dir);
export const ticketMd = (id: number): string => join(ticketDir(id), 'ticket.md');
const metaPath = (id: number): string => join(ticketDir(id), 'ticket.json');

export const rel = (path: string): string => relative(WORKSPACE, path).split('\\').join('/');

export function readMeta(id: number): Meta | null {
  const path = metaPath(id);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Meta) : null;
}

function writeMeta(meta: Meta): void {
  mkdirSync(ticketDir(meta.id), { recursive: true });
  writeFileSync(metaPath(meta.id), `${JSON.stringify(meta, null, 2)}\n`);
}

export function proyectoPorNombre(cfg: Config, nombre: string): ProyectoCfg {
  const p = cfg.proyectos.find((x) => x.nombre === nombre);
  if (!p) fail(`No hay un proyecto "${nombre}" en orquestador.json (${cfg.proyectos.map((x) => x.nombre).join(', ')}).`);
  return p;
}

/** El proyecto de un ticket: --proyecto, lo que ya se sabe de él o el único configurado. */
export function proyectoDe(cfg: Config, id: number, flags: Flags = {}): ProyectoCfg {
  const named = flagText(flags, 'proyecto');
  if (named) return proyectoPorNombre(cfg, named);
  const known = readMeta(id)?.proyecto ?? readHistory().find((e) => e.id === id && e.proyecto)?.proyecto;
  if (known) return proyectoPorNombre(cfg, known);
  if (cfg.proyectos.length === 1) return cfg.proyectos[0];
  return fail(`¿De qué proyecto es #${id}? Indícalo con --proyecto (${cfg.proyectos.map((x) => x.nombre).join(', ')}).`);
}

export function repoPorDir(p: ProyectoCfg, dir: string): RepoCfg {
  const repo = p.repos.find((r) => r.dir === dir || r.repository === dir);
  if (!repo) fail(`El proyecto ${p.nombre} no tiene el repo "${dir}" (${p.repos.map((r) => r.dir).join(', ')}).`);
  return repo;
}

/** Los repos del ticket, en el orden del proyecto. Exige haberlo leído (`show`) o iniciado. */
export function reposDe(p: ProyectoCfg, id: number): RepoCfg[] {
  const meta = readMeta(id);
  if (!meta || meta.repos.length === 0)
    fail(`#${id} no tiene repos asignados: corre show ${id} o start ${id} --repo <carpeta>.`);
  return p.repos.filter((r) => meta.repos.includes(r.dir));
}

/** Un solo repo del ticket: --repo, o el único que tiene. */
export function unRepo(p: ProyectoCfg, id: number, flags: Flags): RepoCfg {
  const named = flagText(flags, 'repo');
  if (named.includes(',')) fail(`Aquí va un solo repo: --repo ${named.split(',')[0]}`);
  if (named) return repoPorDir(p, named);
  const repos = reposDe(p, id);
  if (repos.length === 1) return repos[0];
  return fail(`#${id} va en ${repos.map((r) => r.dir).join(' y ')}: indica cuál con --repo.`);
}

/** Los repos sobre los que actúa un comando: --repo o todos los del ticket. */
export function reposObjetivo(p: ProyectoCfg, id: number, flags: Flags): RepoCfg[] {
  const named = flagText(flags, 'repo');
  if (!named) return reposDe(p, id);
  const dirs = named.split(',').map((d) => repoPorDir(p, d.trim()).dir);
  return p.repos.filter((r) => dirs.includes(r.dir));
}

/* ------------------------------------------------------------------------ next */

export function cmdNext(cfg: Config, flags: Flags): void {
  const limit = Number(flags.limit ?? 15);
  const proyectos = flagText(flags, 'proyecto') ? [proyectoPorNombre(cfg, flagText(flags, 'proyecto'))] : cfg.proyectos;
  const out = proyectos.map((p) => {
    const tickets = queryTickets(p, { resume: Boolean(flags.resume), onlyMine: flags.todos ? false : p.soloMios })
      .slice(0, limit)
      .map((t) => ({
        ...t,
        talla: tallaDe(t.tags),
        repos: reposPorEtiquetas(p, t.tags).map((r) => r.dir),
      }));
    return { proyecto: p.nombre, tickets };
  });
  if (flags.json) {
    log(JSON.stringify(out));
    return;
  }
  for (const { proyecto, tickets } of out) {
    log(`${proyecto}: ${tickets.length} ticket(s) ${flags.resume ? 'en curso' : 'para tomar'}`);
    for (const t of tickets) {
      const repos = t.repos.length ? t.repos.join('+') : 'repo ?';
      const parent = t.parent ? ` · padre #${t.parent}` : '';
      log(`  #${t.id}\t${t.type}\tP${t.priority ?? '-'}\t${t.talla}\t${repos}\t${t.title}${parent}`);
    }
  }
  log('');
  log(`Siguiente: node orquestador/orq.ts show <id>`);
}

/* ------------------------------------------------------------------------ show */

export function cmdShow(cfg: Config, id: number, flags: Flags): Meta {
  const p = proyectoDe(cfg, id, flags);
  const item = fetchItem(p, id);
  const f = item.fields;
  const s = summarize(item);
  const relations = parseRelations(item.relations);
  const description = htmlToText(f[FIELD.description]);
  const acceptance = htmlToText(f[FIELD.acceptance]);
  const repro = htmlToText(f[FIELD.repro]);
  const previous = readMeta(id);
  const named = flagText(flags, 'repo');
  // --repo a,b fija los repos de un ticket sin etiqueta; se guardan en el orden del proyecto.
  const nombrados = named ? named.split(',').map((d) => repoPorDir(p, d.trim()).dir) : [];
  const repos = named
    ? p.repos.filter((r) => nombrados.includes(r.dir)).map((r) => r.dir)
    : previous?.repos.length
      ? previous.repos
      : reposPorEtiquetas(p, s.tags).map((r) => r.dir);
  const plan = planDeFlags(flags, previous);
  // La talla elegida al planear manda; si no, la de las etiquetas; si no, la que ya tenía.
  const tallaEtiqueta = tallaDe(s.tags);
  const talla = plan.talla ?? (previous?.planeado && previous.talla !== '*' ? previous.talla : tallaEtiqueta !== '*' ? tallaEtiqueta : (previous?.talla ?? '*'));

  const alerts: string[] = [];
  if (repos.length === 0)
    alerts.push(`Sin etiqueta de repo (${p.repos.map((r) => r.etiquetas.join('/')).join(', ')}): indica el repo con --repo al iniciarlo.`);
  if (!acceptance && !description && !repro)
    alerts.push('Sin descripción ni criterios de aceptación: pide aclaración antes de implementar.');
  else if (!acceptance) alerts.push('Sin criterios de aceptación propios: mira el padre y, si no alcanza, pregunta.');

  const linked = (ids: number[]) =>
    ids.slice(0, 15).map((linkedId) => {
      try {
        const l = summarize(fetchItem(p, linkedId, { light: true }));
        return { ...l, line: `#${l.id} [${l.type}] ${l.title} — ${l.state}` };
      } catch {
        return { id: linkedId, state: '?', line: `#${linkedId} (no accesible)` };
      }
    });
  const predecessors = linked(relations.predecessors);
  for (const pre of predecessors) if (!CLOSED_STATES.has(pre.state)) alerts.push(`Predecesor sin terminar: ${pre.line}`);
  const children = linked(relations.children);
  const related = linked(relations.related);

  const lines = [
    `# #${s.id} · [${s.type}] ${s.title}`,
    '',
    `- Proyecto: ${p.nombre} · Repos: ${repos.join(', ') || '—'} · Talla: ${talla}`,
    ...(plan.nota ? [`- Plan: ${plan.nota}`] : []),
    `- Estado: ${s.state} · Prioridad: ${s.priority ?? '—'} · Asignado a: ${s.assigned}`,
    `- Etiquetas: ${s.tags.join('; ') || '—'}`,
    `- Iteración: ${String(f[FIELD.iteration] ?? '—')}`,
    `- URL: ${ticketUrl(p, s.id)}`,
    `- Generado: ${new Date().toISOString()} (instantánea; el ticket manda)`,
    '',
    '## Alertas',
    '',
    alerts.length ? alerts.map((a) => `- ${a}`).join('\n') : '- Ninguna.',
    '',
    '## Descripción',
    '',
    description || '_Vacía._',
    '',
    '## Criterios de aceptación',
    '',
    acceptance || '_Vacíos._',
    '',
  ];
  if (repro) lines.push('## Pasos para reproducir', '', repro, '');
  if (relations.parent) {
    const parent = fetchItem(p, relations.parent);
    const pf = parent.fields;
    lines.push(
      `## Ticket padre #${parent.id} — ${String(pf[FIELD.title])} [${String(pf[FIELD.type])}, ${String(pf[FIELD.state])}]`,
      '',
      htmlToText(pf[FIELD.description]).slice(0, 3000) || '_Sin descripción._',
      '',
      '### Criterios de aceptación del padre',
      '',
      htmlToText(pf[FIELD.acceptance]).slice(0, 3000) || '_Sin criterios._',
      '',
    );
  }
  const list = (label: string, items: Array<{ line: string }>) => [
    `- ${label}: ${items.length ? '' : 'ninguno'}`,
    ...items.map((i) => `  - ${i.line}`),
  ];
  lines.push('## Relaciones', '', ...list('Hijos', children), ...list('Predecesores', predecessors), ...list('Relacionados', related), '');
  lines.push('## Adjuntos (ábrelos desde el ticket si hacen falta)', '', relations.attachments.map((a) => `- ${a}`).join('\n') || '- ninguno', '');
  const comments = fetchComments(p, id);
  lines.push(
    '## Comentarios recientes',
    '',
    comments.length ? comments.map((c) => `- ${c.at.slice(0, 10)} ${c.author}: ${c.text.replace(/\n+/g, ' ')}`).join('\n') : '- ninguno',
  );

  const meta: Meta = {
    id: s.id,
    proyecto: p.nombre,
    type: s.type,
    title: s.title,
    tags: s.tags,
    talla,
    repos,
    parent: relations.parent,
    url: ticketUrl(p, s.id),
    cadenas: plan.cadenas,
    nota: plan.nota,
    planeado: plan.planeado,
  };
  writeMeta(meta);
  writeFileSync(ticketMd(id), `${lines.join('\n')}\n`);
  const motores = ROLES.map((rol) => `${rol}: ${cadenaDe(cfg, meta, rol).map((m) => m.texto).join(' → ')}`).join(' · ');
  log(`done -> ${rel(ticketMd(id))} · ${p.nombre} · ${repos.join('+') || 'repo ?'} · talla ${meta.talla}${meta.planeado ? ' (planeado)' : ''}`);
  log(`  ${motores}`);
  alerts.forEach((a) => log(`  ! ${a}`));
  return meta;
}

/* ------------------------------------------------------------------------ plan */

/**
 * Lo que el coordinador decide al planear un ticket: --talla, --implementer y --reviewer (cadenas
 * motor:modelo[:esfuerzo] separadas por coma) y --nota. Se suma a lo que ya estaba planeado.
 */
export function planDeFlags(flags: Flags, previous: Meta | null) {
  const talla = flagText(flags, 'talla').toUpperCase() || null;
  if (talla && !(TALLAS as readonly string[]).includes(talla)) fail(`--talla debe ser ${TALLAS.join(', ')} y es "${talla}"`);
  const cadenas: Partial<Record<Rol, string[]>> = { ...previous?.cadenas };
  for (const rol of ROLES) {
    const texto = flagText(flags, rol);
    if (!texto) continue;
    cadenas[rol] = texto.split(',').map((spec) => {
      const parsed = parseSpec(spec.trim());
      if (!MOTORES[parsed.motor]) fail(`Motor desconocido "${parsed.motor}" (conocidos: ${Object.keys(MOTORES).join(', ')})`);
      return parsed.texto;
    });
  }
  const nota = flagText(flags, 'nota') || previous?.nota;
  const tocado = Boolean(talla || flagText(flags, 'repo') || ROLES.some((r) => flagText(flags, r)) || flagText(flags, 'nota'));
  return {
    talla,
    cadenas: Object.keys(cadenas).length ? cadenas : undefined,
    nota,
    planeado: tocado ? new Date().toISOString() : previous?.planeado,
  };
}

/** La cadena de motores de un ticket para un rol: la que se eligió al planear o la de su talla. */
export function cadenaDe(cfg: Config, meta: Pick<Meta, 'talla' | 'cadenas'>, rol: Rol) {
  const elegida = meta.cadenas?.[rol];
  return elegida?.length ? elegida.map(parseSpec) : cadena(cfg, rol, meta.talla);
}

/** Tus tickets (para tomar y en curso) con lo que se sabe de su plan. */
export function planData(cfg: Config, flags: Flags = {}) {
  const proyectos = flagText(flags, 'proyecto') ? [proyectoPorNombre(cfg, flagText(flags, 'proyecto'))] : cfg.proyectos;
  return proyectos.flatMap((p) => {
    const vistos = new Set<number>();
    const tickets = [...queryTickets(p, { resume: true, onlyMine: true }), ...queryTickets(p, { onlyMine: true })].filter((t) =>
      vistos.has(t.id) ? false : (vistos.add(t.id), true),
    );
    return tickets.map((t) => {
      const meta = readMeta(t.id);
      const repos = meta?.repos.length ? meta.repos : reposPorEtiquetas(p, t.tags).map((r) => r.dir);
      const talla = meta?.talla && meta.talla !== '*' ? meta.talla : tallaDe(t.tags);
      const estado = t.state === typeRules(p)[t.type]?.start ? 'en curso' : meta?.planeado ? 'planeado' : 'sin plan';
      return {
        proyecto: p.nombre,
        id: t.id,
        type: t.type,
        prioridad: t.priority,
        title: t.title,
        parent: t.parent,
        estado,
        repos,
        talla,
        implementer: cadenaDe(cfg, { talla, cadenas: meta?.cadenas }, 'implementer').map((m) => m.texto),
        reviewer: cadenaDe(cfg, { talla, cadenas: meta?.cadenas }, 'reviewer').map((m) => m.texto),
        nota: meta?.nota ?? '',
        url: ticketUrl(p, t.id),
      };
    });
  });
}

/** Tus tickets con su plan, en consola y en progress/plan.md. */
export function cmdPlan(cfg: Config, flags: Flags): void {
  const filas = planData(cfg, flags);
  if (flags.json) {
    log(JSON.stringify(filas));
    return;
  }
  const sinPlan = filas.filter((f) => f.estado === 'sin plan').length;
  const lines = [
    `# Plan · tickets asignados a ti · ${filas.length} (${sinPlan} sin plan)`,
    '',
    '> Lo genera `node orquestador/orq.ts plan`. Se planea con `show <id> --repo … --talla … [--implementer …] [--reviewer …] [--nota …]`.',
    '',
    '| Ticket | Estado | P | Repos | Talla | Implementer | Reviewer | Nota |',
    '|---|---|---|---|---|---|---|---|',
    ...filas.map(
      (f) =>
        `| #${f.id} ${f.title}${f.parent ? ` (padre #${f.parent})` : ''} | ${f.estado} | ${f.prioridad ?? '—'} | ${f.repos.join('+') || '?'} | ${f.talla} | ${f.implementer.join(' → ')} | ${f.reviewer.join(' → ')} | ${f.nota} |`,
    ),
  ];
  mkdirSync(PROGRESS, { recursive: true });
  writeFileSync(join(PROGRESS, 'plan.md'), `${lines.join('\n')}\n`);
  log(lines.join('\n'));
}

/** Los criterios de aceptación del ticket, una línea por criterio (máximo 6), para la guía. */
export function criterios(id: number): string[] {
  const path = ticketMd(id);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  const limpiar = (section: string) =>
    section
      .split('\n')
      .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*(?:\[[ x]\]\s*)?/, '').trim())
      .filter((line) => line && line !== '_Vacíos._' && line !== '_Sin criterios._')
      .slice(0, 10)
      .map((line) => (line.length > 320 ? `${line.slice(0, 317)}…` : line));
  const propios = limpiar(/## Criterios de aceptación\s*\n([\s\S]*?)(\n## |$)/.exec(text)?.[1] ?? '');
  if (propios.length) return propios;
  // Muchos tickets los traen dentro de la descripción («Criterios de aceptación» o «… (hecho cuando)»),
  // hasta el siguiente bloque («Definición de terminado», «Dependencias», …) o la siguiente sección.
  const desc = /## Descripción\s*\n([\s\S]*?)(\n## |$)/.exec(text)?.[1] ?? '';
  const bloque = /(?:^|\n)\s*Criterios de aceptación[^\n]*\n([\s\S]*?)(?=\n\s*(?:Definición de terminado|Dependencias|Fuera de alcance|Notas técnicas|Riesgos)\b|$)/i.exec(desc)?.[1] ?? '';
  return limpiar(bloque);
}

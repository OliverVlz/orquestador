/**
 * Lo que mira la persona: qué probar (guía) y cómo va todo (tablero). Se imprimen y quedan en
 * progress/ del workspace.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchItem, prStatus, prUrl, prsPorRama, summarize, ticketUrl } from './ado.ts';
import { PROGRESS, qaBranch, type Config } from './config.ts';
import { baseRef, ramasContenidasEn, ramasLocales, shortHead, ticketsInQa, worktreePath } from './git.ts';
import { boardState, readHistory, type EstadoTicket } from './historial.ts';
import { criterios, proyectoPorNombre, readMeta, repoWorkDir } from './tickets.ts';
import { day, log, readSection } from './util.ts';
import { leerValidacion, resumenValidacion, type ValidacionIa } from './validacion.ts';

function save(name: string, lines: string[]): void {
  const text = `${lines.join('\n').trim()}\n`;
  mkdirSync(PROGRESS, { recursive: true });
  writeFileSync(join(PROGRESS, name), text);
  log(text);
}

/* ------------------------------------------------------------------------ guía */

export type TareaGuia = {
  id: number;
  proyecto: string;
  repo: string;
  title: string;
  url: string;
  dir: string;
  branch: string;
  tip: string;
  tested: boolean;
  pr: string | null;
  prUrl: string | null;
  checks: string[];
  /** La sección «Cómo probarlo» del informe del implementer: dónde ir, qué preparar, pasos y qué esperar. */
  comoProbar: string;
  /** Lo que validó la IA en la rama de pruebas (roles/validador.md), si ya pasó. */
  validacion: ValidacionIa | null;
};
export type Levantar = { proyecto: string; repo: string; carpeta: string; head: string; comando: string; url: string | null };

/** Qué hay para probar en la rama de pruebas de cada repo, y en qué orden levantarlos. */
export function guiaData(cfg: Config): { rama: string; levantar: Levantar[]; tareas: TareaGuia[] } {
  const rama = qaBranch(cfg);
  const levantar: Levantar[] = [];
  const tareas: TareaGuia[] = [];
  for (const p of cfg.proyectos) {
    for (const repo of p.repos) {
      const dir = worktreePath(repo, 'qa');
      if (!existsSync(dir)) continue;
      const base = baseRef(repo, p.ramaBase);
      const inQa = ticketsInQa(repo, dir, base);
      if (inQa.length === 0) continue;
      const prs = prsPorRama(p, repo.repository);
      const ramas = ramasLocales(repo.path);
      const probadas = ramasContenidasEn(dir, 'HEAD');
      levantar.push({
        proyecto: p.nombre,
        repo: repo.dir,
        carpeta: dir,
        head: shortHead(dir),
        comando: repo.levantar ?? '(define "levantar" en orquestador.json)',
        url: repo.url ?? null,
      });
      for (const { id, branch: ticketBranch } of inQa) {
        let title = readMeta(id)?.title ?? '';
        if (!title) {
          try {
            title = summarize(fetchItem(p, id, { light: true })).title;
          } catch {
            title = '(sin título: míralo en el ticket)';
          }
        }
        const pr = prs?.get(ticketBranch) ?? null;
        tareas.push({
          id,
          proyecto: p.nombre,
          repo: repo.dir,
          title,
          url: ticketUrl(p, id),
          dir: worktreePath(repo, id),
          branch: ticketBranch,
          tip: ramas.get(ticketBranch) ?? '?',
          tested: probadas.has(ticketBranch),
          pr: pr ? `#${pr.pullRequestId} (${pr.status})` : null,
          prUrl: pr ? prUrl(p, repo.repository, pr.pullRequestId) : null,
          checks: criterios(id),
          comoProbar: readSection(join(repoWorkDir(id, repo), 'impl.md'), 'Cómo probarlo'),
          validacion: leerValidacion(id, repo),
        });
      }
    }
  }
  return { rama, levantar, tareas };
}

export function cmdGuia(cfg: Config): void {
  const { rama: branch, levantar, tareas } = guiaData(cfg);
  const lines = [`# Qué probar · ${branch} · ${tareas.length} tarea(s)`, ''];
  if (tareas.length === 0) lines.push(`Nada pendiente: no hay tareas mezcladas en ${branch} que falten en la base.`, '');
  else
    lines.push(
      '**Levanta en este orden:**',
      ...levantar.map((l, i) => `${i + 1}. ${l.repo} @${l.head}: \`cd "${l.carpeta}" && ${l.comando}\`${l.url ? ` → ${l.url}` : ''}`),
      '',
    );
  tareas.forEach((t, i) => {
    lines.push(
      `## ${i + 1}. Tarea #${t.id} (${t.repo}) · ${t.title}`,
      `- **Tarea:** ${t.url}`,
      `- **Carpeta del ticket:** \`${t.dir}\` · rama \`${t.branch}\` @${t.tip}`,
      `- **PR:** ${t.pr ? `${t.pr} ${t.prUrl}` : `sin abrir (se abre con /qa-ok ${t.id})`}`,
    );
    if (t.validacion) {
      lines.push(`- **Validación IA:** ${resumenValidacion(t.validacion)} · \`progress/tickets/${t.id}/${t.repo}/validacion-ia.md\``);
      for (const c of t.validacion.criterios.filter((c) => c.marca === '✘')) lines.push(`  - ✘ ${c.texto}`);
    }
    if (!t.tested) lines.push(`- ⚠ La rama cambió después de mezclarla: corre \`qa ${t.id}\` antes de probar.`);
    if (t.comoProbar) lines.push('- **Cómo probarlo:**', ...t.comoProbar.split('\n').map((l) => `  ${l}`));
    else lines.push('- **Cómo probarlo:** el implementer no lo dejó escrito; pídeselo al coordinador.');
    const checks = t.checks.length ? t.checks : ['El ticket no tiene criterios de aceptación: míralo en Azure.'];
    lines.push('- **Criterios de aceptación (qué validar):**', ...checks.map((c) => `  - [ ] ${c}`), `- **Funciona:** \`/qa-ok ${t.id}\` · **Falla:** \`/qa-falla ${t.id} <qué falló>\``, '');
  });
  save('guia-pruebas.md', lines);
}

/* --------------------------------------------------------------------- tablero */

const EVENT_TEXT: Record<string, string> = {
  iniciado: 'iniciado',
  'en-prueba': 'mezclado para probar',
  falló: 'falló la prueba',
  aceptado: 'aceptado ✔',
  pregunta: 'pregunta',
  respondido: 'respondido',
  limpio: 'carpeta borrada',
};

function table(header: string, rows: string[]): string[] {
  return rows.length === 0 ? ['_Nada._', ''] : [header, header.replace(/[^|]/g, '-'), ...rows, ''];
}

export function cmdTablero(cfg: Config): void {
  const events = readHistory();
  const tickets = boardState(events);
  const of = (state: EstadoTicket['state']) => tickets.filter((t) => t.state === state);
  const name = (t: EstadoTicket) => `#${t.id}${t.title ? ` ${t.title}` : ''}`;
  const folder = (t: EstadoTicket) => (t.cleaned || t.repo === '—' ? '—' : `\`${t.repo}--${t.id}\``);
  const ultimo = (t: EstadoTicket) => (t.ultimo ? `${t.ultimo.rol} ${t.ultimo.resultado} (${t.ultimo.motor})` : '—');
  const esperando = [...new Map(of('esperando').map((t) => [t.id, t])).values()];
  const lines = [
    `# Tablero · ${cfg.qa ? `qa/${cfg.qa}` : 'sin rama de pruebas'} · ${day(new Date().toISOString())} (UTC)`,
    '',
    '> Lo genera `node orquestador/orq.ts tablero` a partir de `progress/historial.jsonl`. No se edita a mano.',
    '',
    `## Esperando tu respuesta · ${esperando.length}`,
    '',
    ...table('| Tarea | Pregunta | Desde |', esperando.map((t) => `| ${name(t)} | ${t.questions.map((q) => q.text).join(' · ')} | ${day(t.since)} |`)),
    `## Por probar · ${of('en-prueba').length}`,
    '',
    ...table('| Repo | Tarea | Carpeta | Mezclado |', of('en-prueba').map((t) => `| ${t.repo} | ${name(t)} | ${folder(t)} | ${day(t.since)} @${t.hash ?? ''} |`)),
    `## Corrigiendo (falló la prueba) · ${of('falló').length}`,
    '',
    ...table('| Repo | Tarea | Qué falló | Carpeta |', of('falló').map((t) => `| ${t.repo} | ${name(t)} | ${t.note ?? ''} | ${folder(t)} |`)),
    `## En desarrollo · ${of('iniciado').length}`,
    '',
    ...table('| Repo | Tarea | Último paso | Carpeta | Desde |', of('iniciado').map((t) => `| ${t.repo} | ${name(t)} | ${ultimo(t)} | ${folder(t)} | ${day(t.since)} |`)),
    `## Aceptados ✔ · ${of('aceptado').length}`,
    '',
    ...table(
      '| Repo | Tarea | PR | Estado del PR | Aceptado |',
      of('aceptado')
        .sort((a, b) => b.since.localeCompare(a.since))
        .map((t) => {
          const p = t.proyecto ? proyectoPorNombre(cfg, t.proyecto) : cfg.proyectos[0];
          const repo = p.repos.find((r) => r.dir === t.repo);
          const link = t.pr && repo ? `[${t.pr}](${prUrl(p, repo.repository, t.pr)})` : String(t.pr ?? '—');
          return `| ${t.repo} | ${name(t)} | ${link} | ${t.pr ? prStatus(p, t.pr) : '—'} | ${day(t.since)} |`;
        }),
    ),
    '## Historial (últimos 25)',
    '',
    ...(events.length === 0
      ? ['_Sin movimientos todavía._']
      : events
          .slice(-25)
          .reverse()
          .map((e) => {
            const what = e.event === 'trabajo' ? `${e.rol} ${e.resultado} con ${e.motor}` : (EVENT_TEXT[e.event] ?? e.event);
            return `- ${day(e.at)} · ${e.repo ?? ''} #${e.id} ${what}${e.note ? `: ${e.note}` : ''}${e.pr ? ` · PR ${e.pr}` : ''}`;
          })),
  ];
  save('tablero.md', lines);
}

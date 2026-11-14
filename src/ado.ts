/**
 * Azure DevOps a través de `az` (extensión azure-devops). Cada función recibe el proyecto: así un
 * mismo workspace puede tener proyectos en organizaciones distintas.
 */
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ProyectoCfg } from './config.ts';
import { exec, fail, htmlToText, isDryRun, log, splitTags, textToHtml, type Binario } from './util.ts';

/** Reglas por proceso: qué estados se pueden tomar y a cuál pasa el ticket al empezar. */
export const PRESETS: Record<string, Record<string, { pick: string[]; start: string }>> = {
  Basic: {
    Issue: { pick: ['To Do'], start: 'Doing' },
    Task: { pick: ['To Do'], start: 'Doing' },
  },
  Agile: {
    'User Story': { pick: ['New'], start: 'Active' },
    Bug: { pick: ['New'], start: 'Active' },
    Task: { pick: ['New'], start: 'Active' },
  },
  Scrum: {
    'Product Backlog Item': { pick: ['Approved'], start: 'Committed' },
    Bug: { pick: ['Approved'], start: 'Committed' },
    Task: { pick: ['To Do'], start: 'In Progress' },
  },
  CMMI: {
    Requirement: { pick: ['Proposed'], start: 'Active' },
    Bug: { pick: ['Proposed'], start: 'Active' },
    Task: { pick: ['Proposed'], start: 'Active' },
  },
};

export const FIELD = {
  title: 'System.Title',
  type: 'System.WorkItemType',
  state: 'System.State',
  tags: 'System.Tags',
  assigned: 'System.AssignedTo',
  area: 'System.AreaPath',
  iteration: 'System.IterationPath',
  priority: 'Microsoft.VSTS.Common.Priority',
  description: 'System.Description',
  acceptance: 'Microsoft.VSTS.Common.AcceptanceCriteria',
  repro: 'Microsoft.VSTS.TCM.ReproSteps',
  parent: 'System.Parent',
} as const;

const LIGHT_FIELDS = [FIELD.title, FIELD.type, FIELD.state, FIELD.tags, FIELD.assigned, FIELD.parent].join(',');
export const CLOSED_STATES = new Set(['Closed', 'Resolved', 'Done', 'Removed']);

export type WorkItem = { id: number; fields: Record<string, unknown>; relations?: Array<{ rel: string; url: string; attributes?: { name?: string } }> };
export type Resumen = { id: number; type: string; title: string; state: string; tags: string[]; assigned: string; priority: unknown; parent: number | null };

/**
 * Cómo ejecutar `az`. En Windows `az` es un `az.cmd` que Node no ejecuta sin shell, así que se
 * llama directo al Python de la instalación, como hace ese `.cmd`, en modo UTF-8 (si no, Python
 * escribe en cp1252 y las tildes rompen el JSON). ORQ_AZ permite un `az` falso en las pruebas.
 */
function azBinario(): Binario {
  const override = process.env.ORQ_AZ;
  if (override) {
    return /\.[cm]?[jt]s$/.test(override)
      ? { command: process.execPath, prefix: [override] }
      : { command: override, prefix: [] };
  }
  if (process.platform === 'win32') {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      const python = join(dir, '..', 'python.exe');
      if (dir && existsSync(join(dir, 'az.cmd')) && existsSync(python)) {
        return { command: python, prefix: ['-X', 'utf8', '-IBm', 'azure.cli'] };
      }
    }
  }
  return { command: 'az', prefix: [] };
}

let AZ: Binario | null = null;

export function az(args: string[], options: { allowFail?: boolean } = {}) {
  AZ ??= azBinario();
  return exec(AZ, args, { ...options, name: 'az', shown: args });
}

export function azJson<T = unknown>(args: string[]): T | null {
  const text = az([...args, '--output', 'json']).stdout.trim();
  return text === '' ? null : (JSON.parse(text) as T);
}

/** Un `az` que escribe en Azure DevOps; con --dry-run solo lo muestra. */
export function azWrite<T = unknown>(args: string[], description: string): T | null {
  if (isDryRun()) {
    log(`[dry-run] ${description}`);
    return null;
  }
  return azJson<T>(args);
}

const org = (p: ProyectoCfg) => ['--organization', p.ado.organization];

export const ticketUrl = (p: ProyectoCfg, id: number) =>
  `${p.ado.organization}/${encodeURIComponent(p.ado.project)}/_workitems/edit/${id}`;

export const prUrl = (p: ProyectoCfg, repository: string, prId: number) =>
  `${p.ado.organization}/${encodeURIComponent(p.ado.project)}/_git/${repository}/pullrequest/${prId}`;

const processCache = new Map<string, string>();

export function typeRules(p: ProyectoCfg) {
  let name = p.ado.process;
  if (!name || name === 'auto') {
    const key = `${p.ado.organization}|${p.ado.project}`;
    name = processCache.get(key);
    if (!name) {
      const project = azJson<{ capabilities?: { processTemplate?: { templateName?: string } } }>([
        'devops', 'project', 'show', '--project', p.ado.project, ...org(p),
      ]);
      name = project?.capabilities?.processTemplate?.templateName;
      if (!name) fail(`No se pudo detectar el proceso de ${p.ado.project}; fija ado.process en orquestador.json.`);
      processCache.set(key, name);
    }
  }
  const preset = PRESETS[name];
  if (!preset) fail(`Proceso "${name}" sin reglas en el orquestador (ado.ts PRESETS).`);
  return preset;
}

export function personName(value: unknown): string {
  if (!value) return 'sin asignar';
  if (typeof value === 'string') return value;
  const v = value as { displayName?: string; uniqueName?: string };
  return v.displayName ?? v.uniqueName ?? 'sin asignar';
}

export function summarize(item: WorkItem): Resumen {
  const f = item.fields;
  return {
    id: item.id,
    type: String(f[FIELD.type] ?? ''),
    title: String(f[FIELD.title] ?? ''),
    state: String(f[FIELD.state] ?? ''),
    tags: splitTags(f[FIELD.tags]),
    assigned: personName(f[FIELD.assigned]),
    priority: f[FIELD.priority] ?? null,
    parent: typeof f[FIELD.parent] === 'number' ? (f[FIELD.parent] as number) : null,
  };
}

export function fetchItem(p: ProyectoCfg, id: number, { light = false } = {}): WorkItem {
  const args = ['boards', 'work-item', 'show', '--id', String(id), ...org(p)];
  // `az` expande todo por defecto y no admite --fields con expansión.
  if (light) args.push('--fields', LIGHT_FIELDS, '--expand', 'none');
  else args.push('--expand', 'relations');
  const item = azJson<WorkItem>(args);
  if (!item) fail(`No se encontró el ticket #${id} en ${p.ado.project}.`);
  return item;
}

const wiqlQuote = (value: string) => `'${value.replace(/'/g, "''")}'`;

/** Tickets que se pueden tomar (o los ya empezados, con resume) del proyecto. */
export function queryTickets(p: ProyectoCfg, { resume = false, onlyMine = p.soloMios } = {}): Resumen[] {
  const rules = typeRules(p);
  const clauses = Object.entries(rules).map(([type, rule]) => {
    const states = resume ? [rule.start] : rule.pick;
    return `([System.WorkItemType] = ${wiqlQuote(type)} AND [System.State] IN (${states.map(wiqlQuote).join(', ')}))`;
  });
  const where = [`[System.TeamProject] = ${wiqlQuote(p.ado.project)}`, `(${clauses.join(' OR ')})`];
  if (!resume) where.push(`[System.Tags] NOT CONTAINS ${wiqlQuote(p.etiquetaListo)}`);
  if (onlyMine) where.push('[System.AssignedTo] = @Me');
  const select = ['System.Id', FIELD.type, FIELD.title, FIELD.state, FIELD.assigned, FIELD.priority, FIELD.tags, FIELD.parent]
    .map((n) => `[${n}]`)
    .join(', ');
  const wiql = `SELECT ${select} FROM WorkItems WHERE ${where.join(' AND ')} ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.Id] ASC`;
  const rows = azJson<WorkItem[]>(['boards', 'query', '--wiql', wiql, '--project', p.ado.project, ...org(p)]) ?? [];
  return rows.map(summarize);
}

export type Comentario = { author: string; at: string; text: string };

export function fetchComments(p: ProyectoCfg, id: number): Comentario[] {
  try {
    const data = azJson<{ comments?: Array<{ createdBy?: unknown; createdDate?: string; text?: string }> }>([
      'devops', 'invoke', '--area', 'wit', '--resource', 'comments',
      '--route-parameters', `project=${p.ado.project}`, `workItemId=${id}`,
      '--api-version', '7.1-preview', ...org(p),
    ]);
    return (data?.comments ?? []).slice(-12).map((c) => ({
      author: personName(c.createdBy),
      at: String(c.createdDate ?? ''),
      text: htmlToText(c.text),
    }));
  } catch (error) {
    return [{ author: 'orquestador', at: '', text: `No se pudieron leer los comentarios: ${(error as Error).message.split('\n')[0]}` }];
  }
}

export function signed(firma: string, repoOrProject: string, text: string): string {
  return textToHtml(`[${firma} · ${repoOrProject}] ${text}`);
}

/** Actualiza estado, etiquetas y/o deja un comentario en el ticket. */
export function updateItem(
  p: ProyectoCfg,
  id: number,
  change: { state?: string; tags?: string[]; discussion?: string },
  description: string,
): void {
  const args = ['boards', 'work-item', 'update', '--id', String(id), ...org(p)];
  if (change.state) args.push('--state', change.state);
  if (change.tags) args.push('--fields', `System.Tags=${change.tags.join('; ')}`);
  if (change.discussion) args.push('--discussion', change.discussion);
  azWrite(args, `ticket #${id}: ${description}`);
}

export type PullRequest = { pullRequestId: number; status: string };

export function createPr(
  p: ProyectoCfg,
  pr: { repository: string; source: string; title: string; description: string; workItem: number; autoComplete: boolean },
): PullRequest | null {
  const args = [
    'repos', 'pr', 'create',
    '--repository', pr.repository,
    '--source-branch', pr.source,
    '--target-branch', p.ramaBase,
    '--title', pr.title,
    '--description', pr.description,
    '--work-items', String(pr.workItem),
    '--project', p.ado.project,
    ...org(p),
  ];
  if (p.squash) args.push('--squash', 'true');
  if (pr.autoComplete) args.push('--auto-complete', 'true', '--delete-source-branch', 'true');
  return azWrite<PullRequest>(args, `abrir PR "${pr.title}" (${pr.source} -> ${p.ramaBase}) en ${pr.repository}`);
}

export function approvePr(p: ProyectoCfg, prId: number): void {
  azWrite(['repos', 'pr', 'set-vote', '--id', String(prId), '--vote', 'approve', ...org(p)], `PR ${prId}: voto aprobado`);
}

export function prOfBranch(p: ProyectoCfg, repository: string, branch: string): PullRequest | null {
  try {
    const list = azJson<PullRequest[]>([
      'repos', 'pr', 'list', '--repository', repository, '--source-branch', branch,
      '--status', 'all', '--top', '1', '--project', p.ado.project, ...org(p),
    ]);
    return list?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Los PR de un repo indexados por rama de origen (el más reciente por rama). Una sola llamada a Azure
 * en vez de una por ticket: la guía y el panel tienen decenas de tareas y cada `az` tarda casi 2 s.
 * Si Azure falla, devuelve null y cada ticket queda sin PR conocido.
 */
export function prsPorRama(p: ProyectoCfg, repository: string): Map<string, PullRequest> | null {
  try {
    const list = azJson<Array<PullRequest & { sourceRefName?: string }>>([
      'repos', 'pr', 'list', '--repository', repository, '--status', 'all', '--top', '500',
      '--project', p.ado.project, ...org(p),
    ]);
    const out = new Map<string, PullRequest>();
    for (const pr of list ?? []) {
      const branch = pr.sourceRefName?.replace(/^refs\/heads\//, '');
      if (branch && !out.has(branch)) out.set(branch, { pullRequestId: pr.pullRequestId, status: pr.status });
    }
    return out;
  } catch {
    return null;
  }
}

export function prStatus(p: ProyectoCfg, prId: number): string {
  try {
    return azJson<PullRequest>(['repos', 'pr', 'show', '--id', String(prId), ...org(p)])?.status ?? '?';
  } catch {
    return '?';
  }
}

export type Relaciones = { parent: number | null; children: number[]; predecessors: number[]; successors: number[]; related: number[]; attachments: string[] };

export function parseRelations(relations: WorkItem['relations'] = []): Relaciones {
  const out: Relaciones = { parent: null, children: [], predecessors: [], successors: [], related: [], attachments: [] };
  for (const relation of relations) {
    if (relation.rel === 'AttachedFile') {
      out.attachments.push(relation.attributes?.name ?? 'adjunto');
      continue;
    }
    const match = String(relation.url ?? '').match(/workItems\/(\d+)$/i);
    const id = match ? Number(match[1]) : null;
    if (id === null) continue;
    if (relation.rel === 'System.LinkTypes.Hierarchy-Reverse') out.parent = id;
    else if (relation.rel === 'System.LinkTypes.Hierarchy-Forward') out.children.push(id);
    else if (relation.rel === 'System.LinkTypes.Dependency-Reverse') out.predecessors.push(id);
    else if (relation.rel === 'System.LinkTypes.Dependency-Forward') out.successors.push(id);
    else if (relation.rel === 'System.LinkTypes.Related') out.related.push(id);
  }
  return out;
}

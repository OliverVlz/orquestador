/**
 * El historial del workspace (progress/historial.jsonl): una línea por evento. El tablero, las
 * preguntas pendientes y el escalado de motores salen de aquí. No se versiona: lo permanente
 * queda en los comentarios del ticket.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PROGRESS } from './config.ts';
import { isDryRun } from './util.ts';

export type Evento = {
  at: string;
  id: number;
  proyecto?: string;
  /** Carpeta del repo (mi_backend). Las preguntas son del ticket y no lo llevan. */
  repo?: string;
  event:
    | 'iniciado'
    | 'trabajo'
    | 'pregunta'
    | 'respondido'
    | 'en-prueba'
    | 'falló'
    | 'aceptado'
    | 'limpio';
  title?: string;
  branch?: string;
  note?: string;
  hash?: string;
  pr?: number;
  rol?: string;
  motor?: string;
  resultado?: string;
};

export const historyPath = (progress = PROGRESS): string => join(progress, 'historial.jsonl');

export function record(event: Omit<Evento, 'at'>, progress = PROGRESS): void {
  if (isDryRun()) return;
  const path = historyPath(progress);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export function readHistory(progress = PROGRESS): Evento[] {
  const path = historyPath(progress);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Evento];
      } catch {
        return [];
      }
    });
}

export type EstadoTicket = {
  id: number;
  repo: string;
  proyecto?: string;
  title: string;
  state: 'iniciado' | 'esperando' | 'en-prueba' | 'falló' | 'aceptado';
  since: string;
  cleaned?: boolean;
  note?: string;
  pr?: number;
  hash?: string;
  questions: Array<{ at: string; text: string }>;
  resume?: EstadoTicket['state'];
  /** Último trabajo de un motor: rol, motor y resultado. */
  ultimo?: { rol: string; motor: string; resultado: string; at: string };
};

/**
 * Estado de cada ticket y repo según su último evento. Una pregunta es del ticket: deja en
 * «esperando» todos sus repos y, al responderla, cada uno vuelve a donde estaba.
 */
export function boardState(events: Evento[]): EstadoTicket[] {
  const tickets = new Map<string, EstadoTicket>();
  const titles = new Map<number, string>();
  const ofId = (id: number) => [...tickets.values()].filter((t) => t.id === id);
  for (const e of events) {
    if (e.title) titles.set(e.id, e.title);
    if (e.event === 'pregunta' || e.event === 'respondido') {
      let targets = ofId(e.id);
      if (targets.length === 0) {
        const t: EstadoTicket = { id: e.id, repo: '—', proyecto: e.proyecto, title: '', state: 'iniciado', since: e.at, questions: [] };
        tickets.set(`${e.id}|—`, t);
        targets = [t];
      }
      for (const t of targets) {
        if (e.event === 'pregunta') {
          if (t.state !== 'esperando') t.resume = t.state;
          t.state = 'esperando';
          t.questions = [...t.questions, { at: e.at, text: e.note ?? '' }];
          t.since = e.at;
        } else {
          t.state = t.resume ?? 'iniciado';
          t.questions = [];
          t.since = e.at;
        }
      }
      continue;
    }
    const key = `${e.id}|${e.repo ?? '—'}`;
    const t: EstadoTicket = tickets.get(key) ?? {
      id: e.id,
      repo: e.repo ?? '—',
      proyecto: e.proyecto,
      title: '',
      state: 'iniciado',
      since: e.at,
      questions: [],
    };
    if (e.proyecto) t.proyecto = e.proyecto;
    if (e.event === 'limpio') t.cleaned = true;
    else if (e.event === 'trabajo') {
      t.ultimo = { rol: e.rol ?? '', motor: e.motor ?? '', resultado: e.resultado ?? '', at: e.at };
    } else {
      if (t.state === 'esperando') t.resume = e.event;
      else t.state = e.event;
      t.since = e.at;
      t.cleaned = false;
      if (e.note) t.note = e.note;
      if (e.pr) t.pr = e.pr;
      if (e.hash) t.hash = e.hash;
    }
    tickets.set(key, t);
  }
  return [...tickets.values()].map((t) => ({ ...t, title: titles.get(t.id) ?? t.title }));
}

/**
 * Cuántas veces el revisor devolvió CAMBIOS a un ticket y repo desde que se inició: es lo que decide
 * cuándo escalar al siguiente motor de la cadena.
 */
export function rondasDeCambios(events: Evento[], id: number, repo: string): number {
  let count = 0;
  for (const e of events) {
    if (e.id !== id || e.repo !== repo) continue;
    if (e.event === 'iniciado') count = 0;
    if (e.event === 'trabajo' && e.rol === 'reviewer' && e.resultado === 'CAMBIOS') count += 1;
    if (e.event === 'trabajo' && e.rol === 'implementer' && e.resultado === 'VERIFICACION_FALLIDA') count += 1;
  }
  return count;
}

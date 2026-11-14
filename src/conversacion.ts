/**
 * Lo que va y viene con la persona a través del ticket: comentarios, preguntas que la esperan y
 * sus respuestas. Las dudas de negocio nunca las responde un agente.
 */
import { fetchComments, signed, ticketUrl, updateItem } from './ado.ts';
import { personaDe, type Config } from './config.ts';
import { boardState, readHistory, record } from './historial.ts';
import { proyectoDe, proyectoPorNombre } from './tickets.ts';
import { fail, flagText, log, type Flags } from './util.ts';

export function cmdComment(cfg: Config, id: number, flags: Flags): void {
  const text = flagText(flags, 'text') || fail(`Uso: comment ${id} --text "..."`);
  const p = proyectoDe(cfg, id, flags);
  updateItem(p, id, { discussion: signed(cfg.firma, p.nombre, text) }, 'comentario');
  log(`done -> comentario en #${id}`);
}

export function cmdPregunta(cfg: Config, id: number, flags: Flags): void {
  const question = flagText(flags, 'text') || fail(`Uso: pregunta ${id} --text "la pregunta"`);
  const p = proyectoDe(cfg, id, flags);
  updateItem(p, id, { discussion: signed(cfg.firma, p.nombre, `Pregunta pendiente (el ticket espera la respuesta): ${question}`) }, 'comentario con la pregunta');
  record({ id, proyecto: p.nombre, event: 'pregunta', note: question });
  log(`done -> #${id} espera respuesta: ${question}`);
}

export function cmdResponder(cfg: Config, id: number, flags: Flags): void {
  const answer = flagText(flags, 'text') || fail(`Uso: responder ${id} --text "tu respuesta"`);
  const p = proyectoDe(cfg, id, flags);
  updateItem(p, id, { discussion: signed(cfg.firma, p.nombre, `Respuesta de ${personaDe(cfg)}: ${answer}`) }, 'comentario con la respuesta');
  record({ id, proyecto: p.nombre, event: 'respondido', note: answer });
  log(`done -> #${id} respondido; sigue con: trabajar ${id} --rol implementer --text "<la respuesta>"`);
}

export type Pendiente = {
  id: number;
  proyecto: string;
  title: string;
  url: string;
  since: string;
  questions: Array<{ at: string; text: string }>;
  replyInAzure: { author: string; at: string; text: string } | null;
};

/**
 * Las preguntas que esperan respuesta. Si alguien ya contestó en Azure (un comentario posterior que
 * no firmó el orquestador), se muestra para confirmarlo con `responder`.
 */
export function pendientesData(cfg: Config, { conAzure = true } = {}): Pendiente[] {
  const seen = new Set<number>();
  const items: Pendiente[] = [];
  for (const t of boardState(readHistory())) {
    if (t.state !== 'esperando' || seen.has(t.id)) continue;
    seen.add(t.id);
    const p = t.proyecto ? proyectoPorNombre(cfg, t.proyecto) : cfg.proyectos[0];
    const first = t.questions[0]?.at ?? t.since;
    const reply = conAzure
      ? fetchComments(p, t.id).find((c) => c.at && c.at > first && !c.text.startsWith(`[${cfg.firma}`) && c.author !== 'orquestador')
      : undefined;
    items.push({
      id: t.id,
      proyecto: p.nombre,
      title: t.title,
      url: ticketUrl(p, t.id),
      since: t.since,
      questions: t.questions,
      replyInAzure: reply ? { author: reply.author, at: reply.at, text: reply.text } : null,
    });
  }
  return items.sort((a, b) => a.since.localeCompare(b.since));
}

export function cmdPendientes(cfg: Config, flags: Flags): void {
  const items = pendientesData(cfg);
  if (flags.json) {
    log(JSON.stringify(items));
    return;
  }
  if (items.length === 0) {
    log('No hay preguntas pendientes.');
    return;
  }
  log(`Preguntas pendientes (${items.length})`);
  items.forEach((item, index) => {
    log(`${index + 1}. #${item.id} (${item.proyecto}) ${item.title} · ${item.questions.map((q) => q.text).join(' · ')}`);
    if (item.replyInAzure) log(`   ↳ ${item.replyInAzure.author} respondió en Azure: ${item.replyInAzure.text}`);
  });
  log('');
  log('Responde con: responder <id> --text "tu respuesta"');
}

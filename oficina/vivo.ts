/**
 * ¿Tiene trabajo vivo un ticket? Con el motor `desktop` no hay proceso `orq.ts trabajar <id>`: trabaja una sesión de
 * Claude Desktop (con subagentes) y su rastro son los procesos node de su worktree y los archivos que cambia. Por eso
 * cualquiera de estas señales lo mantiene vivo:
 *
 * - un proceso `orq.ts trabajar <id>` (motores de CLI);
 * - algún node con `worktrees\<grupo>\<id>` en la línea de comando;
 * - actividad en su worktree (archivos versionables o un commit) o en `progress/tickets/<id>/` hace menos de la ventana;
 * - un `*-desktop.pendiente.json` lanzado hace menos de la ventana, con el ticket asignado en `agentes.json`.
 *
 * Sin ninguna señal durante la ventana, el ticket está detenido: es el mismo umbral del colgado «sin trabajo vivo».
 */

export type Rol = 'implementer' | 'reviewer';

export type Senales = {
  /** Rol del proceso `orq.ts trabajar <id>`, si hay uno. */
  rolProceso: Rol | null;
  /** Procesos node con la carpeta del ticket en la línea de comando. */
  nodosEnWorktree: number;
  /** Último cambio en el worktree o en progress/tickets/<id>/ (ms desde 1970; 0 si no hay). */
  ultimaActividadMs: number;
  /** El `*-desktop.pendiente.json` más nuevo: su rol y cuándo se lanzó. */
  pendienteDesktop: { rol: Rol; desdeMs: number } | null;
  /** El ticket está asignado a un agente en agentes.json. */
  asignado: boolean;
  /** La revisión es lo último que se lanzó (pendiente o brief del reviewer más nuevo que impl.md y review.md). */
  revisionEnCurso: boolean;
};

export type Vida = { vivo: boolean; rol: Rol | null; por: string[] };

export function vidaDe(s: Senales, ahoraMs: number, ventanaMin: number): Vida {
  const ventana = ventanaMin * 60_000;
  const por: string[] = [];
  if (s.rolProceso) por.push('proceso');
  if (s.nodosEnWorktree > 0) por.push('node');
  if (s.ultimaActividadMs > 0 && ahoraMs - s.ultimaActividadMs < ventana) por.push('actividad');
  if (s.pendienteDesktop && s.asignado && ahoraMs - s.pendienteDesktop.desdeMs < ventana) por.push('desktop');
  if (!por.length) return { vivo: false, rol: null, por };
  const rol: Rol = s.rolProceso ?? (s.revisionEnCurso || s.pendienteDesktop?.rol === 'reviewer' ? 'reviewer' : 'implementer');
  return { vivo: true, rol, por };
}

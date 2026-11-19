#!/usr/bin/env node
/**
 * Orquestador de tickets de Azure DevOps con motores de IA enchufables.
 * Uso (desde el workspace, la carpeta que contiene los repos): node orquestador/orq.ts <comando> [opciones]
 *
 * Diagnóstico
 *   doctor                         máquina, Azure, repos, motores, memoria y si el coordinador está al día
 *   motores [--perfil P] [--proveedores a,b] [--nota T] [--probar m:modelo]
 *                                  motores instalados, cadenas, perfiles; --perfil configura orquestador.json y progress/motores.md
 *   setup --qa <nombre> [--perfil P]   tu rama de pruebas qa/<nombre> (local, nunca se sube) y perfil opcional de motores
 *   instalar [--check|--dry-run]   instala AGENTS.md, CLAUDE.md y .claude/ del coordinador en el workspace
 *   env --repo <carpeta>           variables de .env frente a .env.example, sin mostrar valores
 *   env --sync [--repo <carpeta>]  junta y deja iguales los .env del repo y de sus carpetas en worktrees/; solo imprime nombres
 *   worktrees [--migrar]           las carpetas de tickets de cada repo; --migrar pasa las del esquema anterior
 *                                  (<repo>--<id>) a worktrees/<grupo>/<id>
 *
 * Planear
 *   plan [--proyecto P]            tus tickets asignados (para tomar y en curso) con su plan: repos, talla y motores
 *   show <id> [--repo a,b] [--talla XS|S|M|L|XL] [--implementer m:modelo,…] [--reviewer m:modelo,…] [--nota T]
 *                                  lee el ticket (progress/tickets/<id>/ticket.md) y fija su plan
 *
 * Tickets (Azure DevOps)
 *   next [--resume] [--todos] [--limit N] [--proyecto P]   tickets para tomar (o en curso)
 *   start <id> [--repo carpeta] [--sin-instalar] [--sobre <id>]   carpeta worktrees/<grupo>/<id> por repo, ticket a «Doing»; --sobre: nace de la rama aprobada de otro ticket
 *   trabajar <id> --rol implementer|reviewer [--repo carpeta] [--motor m:modelo[:esfuerzo]] [--text indicaciones]
 *                                  lanza el worker con la cadena de motores de su talla; lee su informe
 *   finish <id> [--repo carpeta]   comprueba revisión aprobada y verificación; etiqueta el ticket
 *   qa <id> [--repo carpeta]       mezcla la rama del ticket en tu rama de pruebas (worktrees/<grupo>/qa)
 *   qa <id> --falla --text T       la prueba falló: queda en el ticket
 *   qa --reset [--repo carpeta]    rehace tu rama de pruebas desde la base
 *   pr <id> [--probado] [--repo carpeta] [--title T]   empuja y abre el PR; --probado: aprobado y en autocompletar
 *   clean <id>                     borra las carpetas del ticket (la rama se conserva)
 *
 * Con la persona
 *   pregunta <id> --text T         una duda de negocio: queda en el ticket y el ticket espera
 *   pendientes                     preguntas que esperan respuesta
 *   responder <id> --text T        la respuesta de la persona, a su nombre
 *   comment <id> --text T          comentario en el ticket
 *   guia [--publicar <id>]         qué probar y cómo (progress/guia-pruebas.md); --publicar: deja la guía en el ticket de Azure
 *   tablero                        cómo va todo (progress/tablero.md)
 *   tablero --servir [--puerto N]  el panel en el navegador (http://localhost:4321): pendientes, plan, tablero e
 *                                  historial; ahí respondes las preguntas de los workers
 *
 * Opciones comunes: --dry-run (muestra lo que escribiría en Azure o git), --json (salida para máquinas).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cmdClean, cmdFinish, cmdPr, cmdPublicarGuia, cmdQa, cmdStart, cmdTrabajar } from './src/ciclo.ts';
import { loadConfig } from './src/config.ts';
import { cmdComment, cmdPendientes, cmdPregunta, cmdResponder } from './src/conversacion.ts';
import { cmdDoctor, cmdEnv, cmdMotores, cmdSetup, cmdWorktrees } from './src/doctor.ts';
import { cmdInstalar } from './src/instalar.ts';
import { servir } from './src/panel.ts';
import { cmdNext, cmdPlan, cmdShow } from './src/tickets.ts';
import { CliError, fail, flagText, log, parseArgs, setDryRun } from './src/util.ts';
import { cmdGuia, cmdTablero } from './src/vistas.ts';

function help(): void {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  log(source.slice(source.indexOf('/**') + 3, source.indexOf('*/')).replace(/^ \* ?/gm, '').trim());
}

function main(): void {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, rawId] = positional;
  setDryRun(Boolean(flags['dry-run']));
  if (!command || command === 'help' || flags.help) return help();
  if (command === 'instalar') return cmdInstalar(flags);

  const cfg = loadConfig();
  const id = (): number => {
    const n = Number(rawId);
    return Number.isInteger(n) && n > 0 ? n : fail(`Uso: ${command} <id>`);
  };
  const commands: Record<string, () => unknown> = {
    doctor: () => cmdDoctor(cfg),
    motores: () => cmdMotores(cfg, flags),
    setup: () => cmdSetup(cfg, flags),
    env: () => cmdEnv(cfg, flags),
    worktrees: () => cmdWorktrees(cfg, flags),
    next: () => cmdNext(cfg, flags),
    plan: () => cmdPlan(cfg, flags),
    show: () => cmdShow(cfg, id(), flags),
    start: () => cmdStart(cfg, id(), flags),
    trabajar: () => cmdTrabajar(cfg, id(), flags),
    finish: () => cmdFinish(cfg, id(), flags),
    qa: () => cmdQa(cfg, flags.reset ? null : id(), flags),
    pr: () => cmdPr(cfg, id(), flags),
    clean: () => cmdClean(cfg, id(), flags),
    pregunta: () => cmdPregunta(cfg, id(), flags),
    pendientes: () => cmdPendientes(cfg, flags),
    responder: () => cmdResponder(cfg, id(), flags),
    comment: () => cmdComment(cfg, id(), flags),
    guia: () => (flagText(flags, 'publicar') ? cmdPublicarGuia(cfg, Number(flagText(flags, 'publicar')), flags) : cmdGuia(cfg)),
    tablero: () => (flags.servir ? servir(Number(flags.puerto ?? 4321)) : cmdTablero(cfg)),
  };
  const run = commands[command];
  if (!run) {
    help();
    fail(`Comando desconocido: ${command}`);
  }
  run();
}

try {
  main();
} catch (error) {
  if (error instanceof CliError) {
    process.stderr.write(`[FAIL] ${error.message}\n`);
    process.exit(1);
  }
  throw error;
}

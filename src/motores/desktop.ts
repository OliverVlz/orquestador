import type { Motor } from './tipos.ts';

/**
 * Claude Desktop (pestaña Code): una sesión que abre el coordinador, con la cuenta y la cuota del Desktop,
 * que puede ser otra que la de la CLI. No hay proceso que lanzar: es un motor manual en dos fases.
 *
 * 1. `trabajar <id> --rol R --motor desktop:opus[:esfuerzo]` escribe el brief y sale con DESKTOP_PENDIENTE,
 *    indicando la carpeta y el brief.
 * 2. El coordinador abre una sesión de Desktop (modelo y esfuerzo del spec) cuyo prompt empieza con
 *    «Rol: <rol>» y le pide cumplir el brief. Cuando la sesión termina, vuelve a correr el mismo `trabajar`:
 *    lee el informe y sigue como con cualquier motor.
 */
export const desktop: Motor = {
  nombre: 'desktop',
  binario: '(sesión de Claude Desktop)',
  manual: true,
  args: () => [],
  stdin: () => null,
};

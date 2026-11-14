import { COMANDOS_PERMITIDOS, instruccionCorta, type Motor } from './tipos.ts';

/**
 * Gemini CLI en modo no interactivo (`gemini -p`): aprueba solo las ediciones y los comandos de la
 * lista blanca; cualquier otra herramienta se rechaza.
 */
export const gemini: Motor = {
  nombre: 'gemini',
  binario: 'gemini',
  envBinario: 'GEMINI_BIN',
  args: (t) => [
    '--approval-mode', 'auto_edit',
    '-m', t.modelo,
    ...t.dirsExtra.flatMap((d) => ['--include-directories', d]),
    // Una opción por herramienta: con varios valores seguidos, el segundo se lee como prompt suelto.
    ...COMANDOS_PERMITIDOS.map((c) => `--allowed-tools=run_shell_command(${c})`),
    '-p', instruccionCorta(t),
  ],
  stdin: () => null,
};

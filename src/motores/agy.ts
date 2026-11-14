import { instruccionCorta, type Motor } from './tipos.ts';

/**
 * agy (Antigravity CLI) dentro de su sandbox (`--sandbox`, terminal restringida). No lee el prompt
 * por stdin ni acepta un directorio de trabajo: corre desde la carpeta del ticket y recibe una
 * instrucción corta que apunta al prompt. El razonamiento va en el nombre del modelo
 * (gemini-3.8-flash-low|medium|high).
 */
export const agy: Motor = {
  nombre: 'agy',
  binario: 'agy',
  envBinario: 'AGY_BIN',
  args: (t) => [
    '--model', t.modelo,
    '--sandbox',
    '--dangerously-skip-permissions',
    ...t.dirsExtra.flatMap((d) => ['--add-dir', d]),
    '--output-format', 'text',
    '--print-timeout', '0s',
    `-p=${instruccionCorta(t)}`,
  ],
  stdin: () => null,
};

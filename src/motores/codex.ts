import type { Motor } from './tipos.ts';

/**
 * Codex CLI (`codex exec`) dentro de su sandbox `workspace-write`: escribe solo en la carpeta del
 * ticket y en la del informe, sin red. El esfuerzo va aparte: low, medium, high, xhigh.
 */
export const codex: Motor = {
  nombre: 'codex',
  binario: 'codex',
  envBinario: 'CODEX_BIN',
  args: (t) => [
    'exec',
    '-m', t.modelo,
    ...(t.esfuerzo ? ['-c', `model_reasoning_effort=${t.esfuerzo}`] : []),
    '--sandbox', 'workspace-write',
    ...t.dirsExtra.flatMap((d) => ['--add-dir', d]),
    '--skip-git-repo-check',
    '-C', t.cwd,
    '-',
  ],
  stdin: (t) => t.prompt,
};

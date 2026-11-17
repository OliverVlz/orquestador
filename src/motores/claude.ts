import { COMANDOS_PERMITIDOS, COMANDOS_PROHIBIDOS, type Motor } from './tipos.ts';

/**
 * Claude Code en modo no interactivo (`claude -p`). Modelos: haiku, sonnet, opus o un id completo.
 * El esfuerzo va aparte (`--effort`): low, medium, high, xhigh o max.
 * Edita sin preguntar dentro de su carpeta (y la del informe) y solo corre los comandos de la
 * lista blanca; lo demás se rechaza, no se queda esperando.
 */
export const claude: Motor = {
  nombre: 'claude',
  binario: 'claude',
  envBinario: 'CLAUDE_BIN',
  args: (t) => [
    '-p',
    '--model', t.modelo,
    ...(t.esfuerzo ? ['--effort', t.esfuerzo] : []),
    '--permission-mode', 'acceptEdits',
    '--output-format', 'text',
    '--allowedTools', ['Read', 'Edit', 'Write', 'Glob', 'Grep', ...COMANDOS_PERMITIDOS.map((c) => `Bash(${c}:*)`)].join(','),
    '--disallowedTools', COMANDOS_PROHIBIDOS.map((c) => `Bash(${c}:*)`).join(','),
    ...t.dirsExtra.flatMap((d) => ['--add-dir', d]),
  ],
  stdin: (t) => t.prompt,
  sesion: { args: ['auth', 'status'], ok: /"loggedIn":\s*true/, login: 'claude (y dentro, /login)' },
  sinCuota: /usage limit reached|claude ai usage limit|credit balance is too low|hit your (?:\w+ )?limit/i,
};

/**
 * El contrato de un motor de IA. Un motor solo dice cómo se invoca su CLI en modo no interactivo;
 * lanzar el proceso, guardar la salida, detectar falta de cuota y leer el resultado es común
 * (correr.ts). El resultado nunca se lee de la salida del motor sino del informe que escribe en
 * disco: así cualquier CLI sirve.
 */
export type Trabajo = {
  /** Carpeta del ticket: donde corre el motor. */
  cwd: string;
  /** Prompt completo, también guardado en promptFile. */
  prompt: string;
  promptFile: string;
  modelo: string;
  esfuerzo: string | null;
  /** Carpetas fuera de cwd que el motor necesita leer o escribir (la del informe). */
  dirsExtra: string[];
};

export type Motor = {
  nombre: string;
  /** Programa en el PATH. Se puede fijar otro con la variable de entorno `envBinario`. */
  binario: string;
  envBinario?: string;
  /** Argumentos de la línea de comandos. */
  args(t: Trabajo): string[];
  /** Lo que recibe por stdin (el prompt completo), o null si el prompt va en los argumentos. */
  stdin(t: Trabajo): string | null;
  /** Patrones propios de «sin cuota», además de los comunes. */
  sinCuota?: RegExp;
  /**
   * Cómo saber, sin gastar cuota, si la CLI tiene una sesión iniciada: argumentos de un comando de estado
   * y el patrón que debe aparecer en su salida. `doctor` lo corre con el mismo entorno que los workers.
   */
  sesion?: { args: string[]; ok: RegExp; login: string };
  /**
   * Motor sin proceso: el orquestador deja el brief y sale con DESKTOP_PENDIENTE; el coordinador abre una
   * sesión (Claude Desktop) que lo cumple y, al terminar, se vuelve a correr `trabajar` para leer el informe.
   */
  manual?: boolean;
};

/**
 * Los comandos de terminal que un worker puede correr sin pedir permiso: instalar, verificar,
 * resolver un conflicto y hacer commit en su carpeta, y mirar (sin tocar) los contenedores.
 * Los motores con sandbox propio (Codex, agy) lo usan además de esta lista o en su lugar.
 */
export const COMANDOS_PERMITIDOS = [
  'npm', 'npx', 'pnpm', 'node',
  'git status', 'git diff', 'git log', 'git show', 'git add', 'git commit',
  'git rev-parse', 'git branch', 'git merge-base', 'git merge-tree', 'git fetch',
  'git merge', 'git ls-files', 'git grep', 'git blame', 'git for-each-ref', 'git cat-file',
  'ls', 'cat', 'grep', 'rg', 'find', 'head', 'tail', 'wc', 'sort', 'cut', 'diff',
  'mkdir', 'cp', 'mv', 'touch',
  'docker ps', 'docker inspect', 'docker logs', 'docker manifest inspect', 'docker compose config', 'docker compose ps',
];

/**
 * Lo que un worker nunca corre, aunque un prefijo de COMANDOS_PERMITIDOS lo cubra (p. ej. `npx`,
 * `git branch`, `git commit`): reescribir historia, saltarse hooks, publicar, borrar datos o leer secretos.
 */
export const COMANDOS_PROHIBIDOS = [
  'git push', 'git reset', 'git clean', 'git stash', 'git checkout', 'git restore', 'git rebase',
  'git branch -D', 'git branch -d', 'git commit --no-verify', 'git commit -n', 'git merge --no-verify',
  'git worktree', 'git filter-branch', 'git update-ref', 'git credential',
  'npx prisma migrate reset', 'npx prisma db push', 'npm publish', 'pnpm publish',
  'rm', 'printenv', 'env', 'az', 'gh', 'docker compose down', 'docker compose up', 'docker rm', 'docker volume',
];

/** Para motores que no leen el prompt por stdin: una instrucción corta que apunta al archivo. */
export const instruccionCorta = (t: Trabajo): string =>
  `Lee el archivo ${t.promptFile} y cumple sus instrucciones al pie de la letra. Tu directorio de trabajo es ${t.cwd}.`;

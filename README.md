# Orquestador

Toma tickets de Azure DevOps, los reparte a workers de IA de **cualquier proveedor** (Claude, Codex, agy, Gemini),
junta lo aprobado en tu rama de pruebas y abre el PR cuando lo aceptas.

- **Una sola CLI fuera de los repos.** Todo lo que cambia entre proyectos (organización, repos, rama base, cómo se
  instala, verifica y levanta cada uno) está en `orquestador.json`; los repos no llevan nada del orquestador.
- **Motores enchufables** por rol y talla del ticket, con respaldo por cuota y escalado automático.
- **Contrato por archivos**: el worker deja `impl.md` / `review.md` con formato fijo, sea cual sea el motor.
- **Carpetas ordenadas**: cada ticket trabaja en su worktree, en `worktrees/<grupo>/<id>`, separadas por repo.

Está escrito en TypeScript que Node (23.6 o superior) ejecuta directo: no hay paso de compilación.

```text
mi-workspace/                  ← aquí abres la sesión del coordinador (cualquier IA que lea AGENTS.md)
├─ orquestador/                ← este repo
├─ mi_backend/                 ← tus repos, limpios en su rama base
├─ mi_frontend/
├─ worktrees/
│  ├─ backend/
│  │  ├─ 84/                   ← ticket 84: implementer (agy → codex → claude) ⇄ reviewer (claude → codex)
│  │  └─ qa/                   ← tu rama de pruebas qa/<nombre>, con lo aprobado de varios tickets
│  └─ frontend/
│     ├─ 84/
│     └─ qa/
└─ progress/                   ← lo que el orquestador sabe de cada ticket (no versionado)

Azure DevOps ─► coordinador ─► workers en worktrees/<grupo>/<id> ─► worktrees/<grupo>/qa
                                     tú pruebas · /qa-ok → PR aprobado y en autocompletar
```

## Puesta en marcha (una vez)

En la carpeta que contiene tus repos (el workspace):

```bash
git clone https://github.com/OliverVlz/orquestador.git
cp orquestador/orquestador.ejemplo.json orquestador/orquestador.json   # y pon ahí tus proyectos y repos
npm --prefix orquestador install          # solo para tsc y las pruebas; para correr no hace falta
node orquestador/orq.ts setup --qa oliver # tu rama de pruebas, nunca se sube
node orquestador/orq.ts instalar          # AGENTS.md, CLAUDE.md y .claude/ del coordinador en el workspace
node orquestador/orq.ts doctor
```

`orquestador.json` y `local.json` son de tu workspace y no se versionan: el repo solo trae el ejemplo.

Requisitos: Node ≥ 23.6, git, Azure CLI con la extensión `azure-devops` y sesión iniciada, y al menos uno de los
motores en el PATH.

## El panel

En otra terminal, desde el workspace:

```bash
node orquestador/orq.ts tablero --servir        # http://localhost:4321 (--puerto N para otro)
```

Cuatro pestañas, con la marca de `orquestador.json` (`marca`:
nombre, sigla del monograma y, si los hay, `logo` / `logoOscuro` con rutas dentro del workspace):

- **Pendientes**: las preguntas de los workers (las respondes ahí mismo) y qué probar, con el orden para
  levantar, las comprobaciones de cada tarea y los botones para copiar `/qa-ok` o `/qa-falla`.
- **Plan**: tus tickets asignados con repos, talla y la cadena de motores del implementer y el reviewer.
- **Tablero**: los tickets por estado, con el último paso de su worker (motor y resultado).
- **Historial**: todo lo que pasó, filtrable por repo.

Solo escucha en `127.0.0.1`, se actualiza al recargar (o con **Actualizar**) y lo cierras con Ctrl+C. Responder
desde la página exige un token que solo tiene la página que sirvió el propio panel.

## El día a día

Abre Claude Code (o Codex) en el workspace. Al arrancar, el coordinador revisa tus tickets asignados
(`plan`) y planea los que no tienen plan: repos, talla y con qué modelos hacerlos (`/planear`). Te muestra la
tabla y espera tu visto bueno antes de lanzar nada. Después usa `/ola`, `/que-probar`, `/qa-ok <id>`,
`/qa-falla <id> <qué>`, `/pendientes`, `/responder <id> <respuesta>` y `/tablero`. Por debajo todos llaman a la
CLI (`node orquestador/orq.ts help`):

```bash
node orquestador/orq.ts plan                                   # tus tickets y su plan
node orquestador/orq.ts show 94 --repo mi_backend,mi_frontend --talla L \
  --implementer codex:gpt-6-sol:high,claude:opus --nota "cobros: nada de modelos bajos"   # fijar el plan
node orquestador/orq.ts start 84 --repo mi_backend,mi_frontend   # sin etiqueta de repo
node orquestador/orq.ts trabajar 84 --rol implementer --repo mi_backend
node orquestador/orq.ts trabajar 84 --rol reviewer --repo mi_backend
node orquestador/orq.ts finish 84 && node orquestador/orq.ts qa 84
node orquestador/orq.ts guia                                   # qué probar y en qué orden levantar
node orquestador/orq.ts pr 84 --probado                        # tras tu /qa-ok
```

`--dry-run` muestra lo que escribiría en Azure o git sin hacerlo.

## Configuración (`orquestador.json`)

- **`proyectos`**: uno por proyecto de Azure DevOps, con su organización, rama base y repos. Cada repo dice qué
  etiquetas del ticket le corresponden (`Backend`, `Frontend`, `Ambos`) y cómo se instala, verifica y levanta.
  Otro proyecto es otra entrada en la lista.
- **`tituloPr`** y **`squash`** (por proyecto, opcionales): la plantilla del título del PR (`"[{id}] {titulo}"`;
  por defecto el asunto del último commit) y si el PR se completa con squash.
- **`worktrees`** (por repo): la subcarpeta de `worktrees/` donde van las carpetas de sus tickets (`backend`,
  `frontend`, `mobile`…). Si no se pone, es el nombre de la carpeta del repo. No se puede repetir entre repos.
- **`motores`**: por rol (`implementer`, `reviewer`) y talla (`XS`…`XL`, `*` por defecto), la cadena de
  `motor:modelo[:esfuerzo]` en orden de preferencia. Si uno no está instalado, no tiene cuota o no deja informe,
  entra el siguiente.
- **`escalarTras`**: cuántas vueltas sin aprobar (CAMBIOS o verificación fallida) antes de subir al siguiente
  motor de la cadena.
- `local.json` (sin versionar) guarda tu nombre para `qa/<nombre>`.

La talla y los repos de un ticket salen de sus etiquetas en Azure. Si no las tiene, `start <id> --repo …` los fija.

## Carpetas de trabajo (`worktrees/`)

Cada ticket trabaja en un worktree de git, y los checkouts principales se quedan limpios en su rama base:

| Carpeta | Qué es |
|---|---|
| `worktrees/<grupo>/<id>` | La carpeta del ticket `<id>` en ese repo (la crea `start`, la borra `clean`) |
| `worktrees/<grupo>/qa` | Tu rama de pruebas `qa/<nombre>` de ese repo (la crea el primer `qa <id>`) |

`node orquestador/orq.ts worktrees` las lista. Si vienes de una versión anterior, en la que eran carpetas hermanas
del repo (`<repo>--<id>`, `<repo>--qa`), esas siguen funcionando donde están y
`node orquestador/orq.ts worktrees --migrar` las pasa al esquema nuevo con `git worktree move` (conserva la
rama, los cambios sin confirmar y los archivos sin versionar; `--dry-run` muestra qué movería). Después de migrar,
reinstala las dependencias en las carpetas que sigas usando si tu gestor guarda rutas absolutas (pnpm en Windows).

## Motores

| Motor | Cómo corre | Permisos |
|---|---|---|
| `claude` | `claude -p`, prompt por stdin | `acceptEdits` + lista blanca de comandos |
| `codex` | `codex exec`, prompt por stdin | sandbox `workspace-write` (su carpeta y la del informe, sin red) |
| `agy` | `agy -p`, instrucción que apunta al prompt | `--sandbox` (terminal restringida) |
| `gemini` | `gemini -p`, instrucción que apunta al prompt | `auto_edit` + lista blanca de comandos |

La lista blanca (`src/motores/tipos.ts`) permite instalar, verificar y hacer commit: `npm`, `npx`, `pnpm`, `node`,
`git add/commit/status/diff/log…`. Nada de push, reset ni borrados. Ningún motor corre con los permisos
desactivados por completo.

`node orquestador/orq.ts motores --probar claude:haiku` lanza un motor sobre un repo de juguete y comprueba que
deja su informe. Gemini CLI ya no atiende cuentas personales de Google (pide pasar a Antigravity, que es `agy`):
funciona con clave de API o cuenta Workspace.

**Añadir un motor** (opencode, aider…): un archivo en `src/motores/` que diga sus argumentos y si lee el prompt
por stdin, y una línea en `src/motores/registro.ts`. Nada más sabe qué motores existen.

## Dónde está cada cosa

| Qué | Dónde |
|---|---|
| CLI | `orq.ts` |
| Azure DevOps, git, historial | `src/ado.ts`, `src/git.ts`, `src/historial.ts` |
| Ciclo del ticket | `src/ciclo.ts` (`start`, `trabajar`, `finish`, `qa`, `pr`, `clean`) |
| Motores | `src/motores/` |
| Prompts de los roles | `roles/implementer.md`, `roles/reviewer.md`, `roles/validador.md` |
| Lo que se instala en el workspace | `plantilla/` |
| Carpetas de los tickets y de pruebas | `<workspace>/worktrees/<grupo>/` |
| Estado del trabajo (no versionado) | `<workspace>/progress/` |
| Pruebas | `npm test` (y `npm run check` para los tipos) |

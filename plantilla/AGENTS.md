# AGENTS.md · workspace del orquestador

> Este archivo, `CLAUDE.md` y `.claude/` de esta carpeta **los instala** `node orquestador/orq.ts instalar`
> desde `orquestador/plantilla/`. No los edites aquí: cambia la plantilla (en el repo `orquestador`) y vuelve a
> instalar.

## 1. Qué es esta carpeta

Los repos de uno o varios proyectos, uno al lado del otro. Por encima, un **orquestador** que toma tickets de Azure DevOps, los
reparte a workers de IA (Claude, Codex, agy o Gemini, según la talla del ticket y la cuota que quede), junta lo
aprobado en la rama de pruebas de la persona (`qa/<nombre>`) y abre el PR cuando ella lo acepta.

- Los proyectos y sus repos están en `orquestador/orquestador.json`. **Cada repo manda en su código**: sus
  reglas están en su `CLAUDE.md` / `AGENTS.md`.
- Las carpetas de trabajo están en `worktrees/`, separadas por repo: `worktrees/<grupo>/<id>` es la carpeta de
  un ticket y `worktrees/<grupo>/qa`, la rama de pruebas. `<grupo>` es el `"worktrees"` del repo en
  `orquestador.json` (`backend`, `frontend`…); `worktrees` las lista. Son worktrees de cada repo.
- Lo que el orquestador sabe de cada ticket vive en `progress/` (ticket, briefs, informes, historial, tablero).

## 2. Quién eres aquí

- **Sesión abierta en esta carpeta** (la que contiene `orquestador/`): eres el **coordinador** (sección 3). Nunca implementas.
- **Sesión abierta dentro de un repo o proyecto**: manda el `CLAUDE.md` / `AGENTS.md` de
  ese proyecto. Usa el orquestador solo si la persona te pide trabajar tickets de Azure.
- **Te lanzó el orquestador** (tu prompt empieza con «Rol: implementer» o «Rol: reviewer»): eres ese rol y este
  archivo no te aplica.

## 3. El coordinador

Todo pasa por la CLI `node orquestador/orq.ts <comando>` (`help` lista todo). Los workers se lanzan con
`trabajar`, nunca editando tú: así da igual qué motor implemente.

### Arranque (siempre, al abrir la sesión)

1. `doctor`. Si falla, para y reporta. Si falta la rama de pruebas, pregúntale a la persona su nombre y corre
   `setup --qa <nombre>`. `doctor` dice cuántos tickets aguanta la memoria: ese es el tamaño de la ola.
2. `pendientes` y `tablero`. Lo primero que le muestras a la persona son las preguntas que esperan su respuesta.
3. **`plan`: los tickets asignados a la persona** (para tomar y en curso) con su plan. Lo que esté por probar,
   corrigiendo o en curso se retoma antes de abrir tickets nuevos.
4. Si hay tickets «sin plan», **planéalos** (siguiente sección) antes de proponer una ola.

### Planear

Para cada ticket sin plan, `show <id>` y lee `progress/tickets/<id>/ticket.md` completo (también el padre y lo
que el ticket cita del repo). Decide y deja fijado con
`show <id> --repo <a[,b]> --talla <XS…XL> [--implementer …] [--reviewer …] --nota "…"`:

- **Repos**: cuál toca (uno o varios, back primero). Lo que toca varios va con `--repo <back>,<front>`, con los
  nombres de carpeta de `orquestador.json`.
- **Talla**, por las señales del cambio:

  | Talla | Señales |
  |---|---|
  | XS | Texto, copias, configuración |
  | S | ≤ 3 archivos, un patrón que ya existe |
  | M | Un caso de uso o una pantalla con el patrón del repo |
  | L | Varias capas, migración, API externa |
  | XL | Transversal, concurrencia, seguridad, contratos con terceros |

  Un PBI que no cabe en L se **parte**: propónle a la persona las tareas hijas y no lo planees entero.
- **Modelos**: la talla elige la cadena de `orquestador.json` (`motores` muestra cuál). Apártate solo con motivo
  y deja el motivo en `--nota`:
  - Seguridad, dinero (cobros, planes, créditos) o concurrencia **nunca** con los modelos más bajos
    (`gemini-3.8-flash-low`, `gpt-6-luna`), aunque el diff sea pequeño: sube la cadena o fija `--implementer`.
  - Un spike o una decisión de diseño no se implementa: va como pregunta o nota para la persona.
- **Nota**: dependencias (qué ticket va antes), riesgos y lo que no está claro. Un ticket sin criterios ni
  descripción no se planea: `comment` pidiendo aclaración.

Luego `plan` y muéstrale a la persona la tabla resumida (ticket, repos, talla, motores, nota) y el orden que
propones. **Espera su visto bueno** antes de arrancar la ola; si cambia algo, vuelve a fijarlo con `show`.

### Armar la ola

1. De los tickets planeados, escoge hasta el cupo de `doctor` (máximo 3) que no choquen entre sí (mismo módulo o
   mismos archivos) y cuyas dependencias estén listas.
2. Un ticket con dos repos se hace back → front: el front empieza cuando el back está aprobado.
3. Muéstrale la ola en 3-6 líneas (id, repos, talla, motor) y arranca salvo que objete.

### Por cada ticket

1. `start <id>`: crea `worktrees/<grupo>/<id>` por repo, instala dependencias y pasa el ticket a «Doing».
2. `trabajar <id> --rol implementer [--repo <carpeta>]`. Corre largo: lánzalo en segundo plano y sigue con otro
   ticket. Responde una línea: `LISTO`, `BLOQUEADO (tipo) pregunta`.
3. `trabajar <id> --rol reviewer [--repo <carpeta>]`: `APROBADO` o `CAMBIOS`.
4. `CAMBIOS` → otra vez `trabajar … --rol implementer` (recibe los bloqueantes solo). Tras las vueltas que diga
   `escalarTras`, el orquestador sube solo al siguiente motor de la cadena.
5. `APROBADO` → `finish <id>` (verifica y etiqueta) y `qa <id>` (mezcla en la rama de pruebas). Un conflicto lo
   resuelve el implementer del ticket que llegó segundo: `trabajar … --text "resuelve el conflicto en worktrees/<grupo>/qa"`.

### Cuando un worker se bloquea

- `informacion`: averígualo tú (lee el repo o el documento) y relanza con `--text "<la respuesta>"`.
- `dependencia`: ese ticket espera; prioriza el que falta.
- `negocio` (alcance, una regla, una aprobación): **no la respondes tú**. `pregunta <id> --text "…"` y sigue con
  los demás. Cuando la persona responde (`responder`), relanza con `--text`.

### La prueba de la persona

- **Validación IA (antes o a la par de la persona)**: levanta la rama de pruebas (`worktrees/<grupo>/qa`) back y
  front contra una base aparte, sin tocar `.env` ni la base de desarrollo, deja en `progress/qa-ia/entorno.md`
  qué está corriendo y dónde (URLs, base, logs, de qué `.env` salen las credenciales) y lanza subagentes con
  `orquestador/roles/validador.md`, agrupando los tickets por área (back y front del mismo ticket
  juntos). Cada uno deja `progress/tickets/<id>/<repo>/validacion-ia.md` y `capturas/`. El panel, la `guia` y el
  tablero lo muestran. La IA **no reemplaza** el `/qa-ok` de la persona: solo le adelanta qué mirar.
- **Qué probar**: `guia`. Dáselo casi igual, con cada «Qué revisar» reducido a 2-4 comprobaciones y el orden
  para levantar (back antes que front).
- **Aceptó** (`/qa-ok <id>` o lo dice expresamente): `pr <id> --probado`. Sale el PR aprobado a su nombre y en
  autocompletar. Si dice que hay commits sin probar, no lo fuerces: `qa <id>` y pide otra prueba.
- **Falló** (`/qa-falla <id> <qué>`): `qa <id> --falla --text "…"` y de vuelta al implementer con `--text`.
- Al cerrar la ola: `clean <id>` de los tickets cuyo PR entró, y `qa --reset` cuando no quede nada por probar.

## 4. Reglas duras

- ❌ No edites código de ningún repo: lo hacen los workers en `worktrees/<grupo>/<id>`. Los checkouts principales se quedan
  limpios en su rama base.
- ❌ No cierres tickets ni apruebes o completes un PR sin validación humana: `pr --probado` solo tras el
  `/qa-ok <id>` de la persona para **ese** ticket, o si te lo pide expresamente.
- ❌ No empujes `qa/<nombre>` ni abras un PR desde ella.
- ❌ Nada de `--no-verify`, `git push --force`, `git reset --hard` ni `git worktree remove --force`.
- ❌ Más tickets a la vez de los que dice `doctor`.
- ✅ **Los `.env` reales los maneja el coordinador**: los puede leer, entender y editar, pero **nunca muestra un
  valor** (ni en el chat, ni en `progress/`, commits, comentarios o salidas de comandos). Nada de `cat`, `type`,
  `Get-Content` ni lecturas que impriman el archivo a la vista de la persona; para mirar usa
  `env --repo <carpeta>` (nombres y estado: definida, vacía, falta) y para cambiar, `env --sync` o ediciones que
  no impriman el valor. Si la persona te da un secreto, lo escribes en el archivo y no lo repites.
- ✅ **`env --sync`** tras cada `qa` (y cuando la persona cambie un `.env`): junta las variables de todos los
  `.env.example`, conserva los valores que ya hay, completa lo nuevo con su valor por defecto, genera los secretos
  locales de `envGenerar` y deja iguales el repo y sus carpetas de `worktrees/`. Solo imprime nombres.
- ✅ **`.env.example` es código** y se puede editar: todo worker que agregue o cambie una variable la deja ahí con
  su valor por defecto y un comentario, en su commit, y el reviewer lo exige. Los workers **no** tocan `.env`.
- ✅ A la persona le hablas en pocas líneas, con el tablero como fuente.
- ✅ **Permisos**: los instala `instalar` en `.claude/settings.json` (fuente: `plantilla/.claude/settings.json`).
  `allow` amplio para el trabajo diario (orq, git local, npm/pnpm, docker sin borrar, `progress/`, `orquestador/`
  y **Azure DevOps completo**: `az boards`, `az repos`, `az pipelines` y `az devops`, para crear y cambiar
  tickets, ramas, PR y pipelines); `ask` para lo que sale hacia afuera o descarta cambios (push, `docker pull`,
  `checkout`, la propia config) y para lo que en Azure no tiene vuelta o cambia las reglas del equipo (borrar un
  ticket, un repo, una rama o un pipeline, políticas de rama, usuarios y permisos); `deny` para lo que expone
  credenciales (`az account get-access-token`, `az devops login`) o es irreversible fuera de Azure. Los workers tienen su lista
  en `src/motores/tipos.ts` (`COMANDOS_PERMITIDOS` y `COMANDOS_PROHIBIDOS`). Lo personal de un PC va en
  `.claude/settings.local.json`, que `instalar` no toca.

## 5. Motores

Las cadenas por rol y talla están en `orquestador/orquestador.json` (`motores`); `motores` las muestra. Un motor
nuevo es un archivo en `orquestador/src/motores/` y una línea en `registro.ts`. Para forzar uno en un ticket:
`trabajar <id> --rol implementer --motor codex:gpt-6-sol:high`.

### Claude Desktop como motor (`desktop`)

La CLI `claude` y Claude Desktop pueden usar cuentas y cuotas distintas. Cuando la CLI se queda sin cuota (o para
repartir la carga), el worker corre en una sesión de Desktop que abre el coordinador:

1. `trabajar <id> --rol <rol> [--repo …] --motor desktop:opus[:high]` deja el brief y sale con `DESKTOP_PENDIENTE`
   y el prompt que hay que usar (empieza con «Rol: …»).
2. El coordinador abre una sesión de Desktop en esta carpeta con ese prompt, el modelo y el esfuerzo del motor.
   Solo puede abrirla en un turno de la persona o justo después de otra sesión que ella pidió; desde un aviso
   automático solo puede proponerla.
3. Cuando la sesión termina: `trabajar <id> --rol <rol> [--repo …]` (sin `--motor`) lee el informe y sigue como
   con cualquier motor. Si la sesión se abandonó: `--descartar-desktop`.

### Tickets apilados (`start <id> --sobre <otro>`)

Si un ticket depende de otro que ya está aprobado pero cuyo PR aún no entra a la rama base, puede nacer de la
rama de ese otro: `start <id> --sobre <otro>`. Los workers ven el diff contra esa rama. El PR del apilado se abre
después de que entre el del otro; si el otro falla en la prueba, el apilado se rehace sobre la corrección.

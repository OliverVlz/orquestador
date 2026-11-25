# La oficina del orquestador

Una oficina en pixel art para ver a los agentes del orquestador trabajando en vivo: cada uno en su escritorio
(teclea, revisa, espera o se rasca la cabeza si está bloqueado), con un cartel de su ticket encima; el jefe
orquestador en su oficina; y los libres tomando tinto o en el sofá. Arriba, los tickets en **Done hoy** y en la
**semana**, con un botón ▾ que despliega cuáles son.

Node 24 y nada más: sin dependencias, sin CDNs ni imágenes externas. Solo lee; no escribe nada.

## Arrancar

Desde el workspace (la carpeta que contiene `orquestador/`):

```bash
node orquestador/orq.ts oficina                  # http://localhost:4400
node orquestador/orq.ts oficina --puerto 4500    # otro puerto
node orquestador/oficina/server.mjs              # lo mismo, sin pasar por orq
```

También sirven `OFICINA_PUERTO` (puerto) y `ORQ_WORKSPACE` (otro workspace). Solo escucha en `127.0.0.1`; se
cierra con Ctrl+C.

## De dónde sale cada cosa

- **Quién eres**: `local.json` (`qa`); si no está, el nombre de tu cuenta de `az`. Los tickets de Azure son los
  asignados a quien tiene la sesión de `az` (`@Me`); `OFICINA_AZ_USUARIO=correo` mira los de otra persona.
- **Los agentes**: `progress/oficina/agentes.json`, si el coordinador lo mantiene:

  ```json
  { "agentes": [{ "nombre": "Agente 1", "ticket": 421, "repo": "mi-front" }, { "nombre": "Agente 2", "ticket": null }] }
  ```

  `ticket: null` es un agente libre. Si el archivo no existe, la oficina sienta sola hasta 5 tickets en curso:
  los que el historial tiene iniciados (sin pasar aún a pruebas), con carpeta en `worktrees/` y en Doing en Azure.
- **Fase y % de avance**: `progress/historial.jsonl` y `progress/tickets/<id>/<repo>/` (`brief-implementer-*.md`,
  `impl.md`, `review.md`, `*-desktop.pendiente.json`).

  | Fase | % |
  |---|---|
  | Sin carpeta | 0 |
  | Carpeta y brief | 15 |
  | Programando (según commits) | 20–50 |
  | `impl.md` LISTO | 55 |
  | En revisión | 65 |
  | `review.md` APROBADO | 75 |
  | finish (etiqueta `etiquetaListo` en `ticket.json`) | 85 |
  | En la rama de pruebas (`en-prueba`) | 92 |
  | Done (`aceptado` en el historial) | 100 |

- **Revisión**: con el ticket en revisión, llega un revisor desde la puerta del jefe con lupa y portapapeles y se
  para al lado del agente («Revisando…»).
- **Tests corriendo** (engranaje y «Ejecutando pruebas…»): solo ejecutores de tests (jest, vitest, playwright,
  cypress, mocha o `node --test`, con sus workers) cuya línea de comando lleva la carpeta del ticket **y** que
  gastaron CPU desde la lectura anterior. Se leen cada 15 s (`Get-CimInstance Win32_Process` en Windows, `ps` en el
  resto). Lint, prettier, tsc o build no cuentan, ni un test huérfano o colgado que sigue vivo pero quieto.
- **Última actividad** («hace 3 min» en el cartel): el cambio más reciente en `progress/tickets/<id>/` y en la
  carpeta del ticket (último commit, índice de git, archivos cambiados o nuevos, artefactos de pruebas).
- **¿Atascado?**: más de 20 minutos sin actividad ni pruebas, con el ticket aún en manos del agente (antes de
  aprobado). El agente se duerme con «zzz» y sale una etiqueta roja con el tiempo. Lo aprobado o en QA espera a
  una persona, así que no cuenta.
- **Vuelta, motor y sincronía** (en el cartel): «↻ vuelta N» son las veces que el reviewer devolvió CAMBIOS desde el
  último inicio (rojo desde 3); el motor es el del último worker (con «⬆» si el ticket escaló de motor, y la cadena en
  el tooltip); «⎇ al día», «⎇ −N» (la rama está N commits atrás de su base) o «⚠ conflicto» (el último intento de
  sincronizar con la base chocó y sigue sin resolverse).
- **Preguntas**: un ticket bloqueado muestra un globo «❓ Te espera una respuesta» (negocio) o «❓ Bloqueado: <tipo>»;
  la pregunta completa va en el tooltip del cartel y en el ticker.
- **Líneas**: `git diff --shortstat origin/<ramaBase>...HEAD` en `worktrees/<grupo>/<id>`, más lo no confirmado
  (también los archivos nuevos). Un ticket apilado (`sobre.json`) se compara con la rama del otro ticket.
- **Done hoy y semana**: `az boards query` (estado Done o Closed, una sola consulta de los últimos 8 días; el corte de hoy y de la semana
  se hace con el día local, porque `@Today` de Azure usa la zona de la organización), cada **5 minutos**, no en cada refresco. Si `az` falla, queda el último valor bueno y la marca «Azure sin conexión»;
  mientras Azure no haya respondido nunca, se cuentan los `aceptado` de hoy del historial.

El servidor recalcula cada 10 s y la página pide `/estado.json` cada 10 s.

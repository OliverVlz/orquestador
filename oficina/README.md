# La oficina del orquestador

Una oficina en pixel art para ver a los agentes del orquestador trabajando en vivo: cada uno en su escritorio
(teclea, revisa, espera o se rasca la cabeza si está bloqueado), con un cartel de su ticket encima; el jefe
orquestador en su oficina; y los libres tomando tinto o en el sofá. Arriba, los tickets en **Done hoy** y en la
**semana**, con un botón ▾ que despliega cuáles son; la carga del PC, el estado de `develop` y un menú de **Control**.
Clic en un agente (o en su cartel) abre la **línea de tiempo** de su ticket, y a la izquierda (🐾) se adoptan
**mascotas**.

Node 24 y nada más: sin dependencias, sin CDNs ni imágenes externas. Lee el workspace; solo escribe en
`progress/oficina/` (`orden.json`, `prs.json`, `mascotas.json`) y solo mata procesos node de `worktrees/` cuando lo
confirmas en la página.

## Arrancar

Desde el workspace (la carpeta que contiene `orquestador/`):

```bash
node orquestador/orq.ts oficina                  # http://localhost:4400
node orquestador/orq.ts oficina --puerto 4500    # otro puerto
node orquestador/oficina/server.mjs              # lo mismo, sin pasar por orq
```

También sirven `OFICINA_PUERTO` (puerto) y `ORQ_WORKSPACE` (otro workspace). Solo escucha en `127.0.0.1`, solo
atiende a `localhost` y las acciones (POST) exigen el token que lleva la página que sirvió: otra página del
navegador no puede matar procesos ni escribir órdenes. Se cierra con Ctrl+C.

## Ajustes (`oficina/config.local.json`)

Copia `oficina/config.example.json` como `oficina/config.local.json` (no se versiona) y deja solo lo que cambies;
se relee sin reiniciar.

| Ajuste | Por defecto | Para qué |
|---|---|---|
| `carga.ramLibreMinPct` | 15 | Con menos RAM libre, la carga se pone en rojo y suda todo agente con procesos node. |
| `carga.nodePorAgenteMax` | 6 | Un agente con más procesos node que esto suda. |
| `colgados.pruebasLargasMin` | 15 | jest, vitest o eslint vivos más tiempo que esto: «pruebas largas». |
| `colgados.sinActividadMin` | 20 | Sin procesos ni cambios en el ticket durante esto: «sin trabajo vivo». |
| `huerfanos.viejosMin` | 30 | Node de un ticket con agente que llevan más que esto sin una suite en curso. |
| `ntfy.activo` / `ntfy.tema` / `ntfy.servidor` | apagado | Avisos al celular (ver abajo). |
| `develop.cadaMin` | 15 | Cada cuánto se miran los pipelines de `develop`. |

## Control (menú 🎛)

- **Carga del PC**: RAM y CPU libres (barras arriba), procesos node en total y en `worktrees/`, y el tope de RAM
  del orquestador (`ORQ_RAM_MAX_GB`). Cada agente cuenta los node con `worktrees<grupo><id>` en su línea de
  comando; si pasa del umbral, **suda** (gotas pixel).
- **Matar procesos huérfanos**: lista primero (con casillas) los node de `worktrees/` cuyo ticket no tiene agente
  activo (ni worker vivo, ni pruebas, ni cambios en 5 min), o que llevan más de `viejosMin` sin que su ticket
  tenga una suite gastando CPU. Mata cada PID por separado: nunca un árbol (`/T`), nunca la rama de pruebas
  (`qa`) ni el orquestador, y solo PID que siguen en la lista en ese momento.
- **Pausar todo / Reanudar todo**: la oficina **no** controla las sesiones de Claude Desktop, así que no lo simula.
  Pausar mata (con confirmación) los node de `worktrees/`, escribe `progress/oficina/orden.json`
  (`{ accion, fecha, origen, procesosTerminados }`) y te da la frase para pegarle al coordinador
  («pausa todos los agentes»). Reanudar escribe la orden y te da «reanuda todos los agentes». **Quien ejecuta es el
  coordinador.**

## Colgados: causa y acción

La etiqueta bajo el escritorio dice por qué está quieto un ticket en curso (antes de aprobado) y qué hacer; clic
en ella para el detalle:

| Causa | Cuándo | Acción sugerida |
|---|---|---|
| ⛔ Bloqueado | El ticket está en `bloqueados` de `progress/oficina/cola.json` | Priorizar el ticket del que depende |
| 🙋 Esperando a la persona | Hay una pregunta de negocio sin responder | Responder su pregunta |
| ⏳ Pruebas largas | jest, vitest o eslint vivos hace más de `pruebasLargasMin` | Matar el proceso (botón, con confirmación) |
| 💤 Sin trabajo vivo | Ni procesos ni cambios en el ticket o su worktree en `sinActividadMin` | Pedirle al agente que relance el reviewer o el implementer en primer plano (p. ej. un subagente esperando una tarea que ya murió) |

## Línea de tiempo

Clic en un agente o en su cartel: start, cada brief (inicio de una vuelta), implementación lista, cada revisión con
su número y dictamen, preguntas, QA, PR y Done en Azure, con la duración entre uno y otro. Sale del historial y de
las fechas de los archivos de `progress/tickets/<id>/<repo>/`. El PR viene del historial (`aceptado`) o de
`az repos pr list` por la rama del ticket, solo al abrir la línea de tiempo y con caché de 30 min en
`progress/oficina/prs.json`.

## Avisos al celular (ntfy)

Apagados por defecto. Para encenderlos, en `oficina/config.local.json`:

```json
{ "ntfy": { "activo": true, "tema": "un-tema-largo-y-dificil-de-adivinar" } }
```

y suscríbete a ese tema en la app de ntfy. Cualquiera que sepa el tema lee los avisos: elige uno largo. Avisa
cuando un agente pasa a colgado (con su causa) o a bloqueado, y cuando el último pipeline de `develop` pasa a
fallido. El mensaje lleva solo el id del ticket y el estado (`#306 colgado: sin trabajo vivo`, `develop en rojo
(pipeline 7)`): nada de nombres, correos, rutas ni secretos. En **Control** hay un botón para mandar un aviso de
prueba.

**`develop` en rojo** sale de los pipelines de Azure que corren sobre `develop` (chip «⎇ develop» arriba). Si el
proyecto no tiene ninguno, el chip dice «sin pipeline»: compilar `origin/develop` por nuestra cuenta (`tsc`) exigiría
un checkout aparte con sus dependencias instaladas, y quedó para después.

## Mascotas 🐾

Solo visual: nada toca el flujo. Hasta 3 a la vez (perro, gato, iguana, peces, loro, hámster, tortuga, conejo),
cada una con su casa (casita, rascador, terrario, pecera, jaula, jaula con rueda, estanque, conejera) y una máquina
de estados con algo de azar:

- **Perro**: pasea, trae la pelota al que se la tiró, mueve la cola junto a quien cerró un PR (con confeti) y le
  ladra al agente colgado o atascado.
- **Gato**: duerme sobre el teclado del agente en pausa, tumba la taza del escritorio 2 (y sale corriendo) y se
  acurruca en la zona soleada bajo la ventana del jefe.
- **Iguana**: trepa la pared y toma sol en la ventana; casi no se mueve.
- **Peces**: suben a la superficie si alguien pasa cerca (y cuando les das de comer).
- **Loro**: repite «¡APROBADO!» o «¡CAMBIOS!» cuando un reviewer da su dictamen; a ratos silba o vuela a un monitor.
- **Hámster** (rueda y escapadas en su bola), **tortuga** (lenta; se esconde si pasa alguien) y **conejo** (salta,
  olfatea a los agentes, come zanahoria).

Tienen hambre (sube con el tiempo), sueño y cariño: en el panel 🐾 se alimentan, se acarician (o clic sobre la
mascota) y se quitan. Se guardan en `progress/oficina/mascotas.json` para que sobrevivan al reinicio.

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

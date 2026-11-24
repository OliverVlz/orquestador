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

- **Líneas**: `git diff --shortstat origin/<ramaBase>...HEAD` en `worktrees/<grupo>/<id>`, más lo no confirmado
  (también los archivos nuevos). Un ticket apilado (`sobre.json`) se compara con la rama del otro ticket.
- **Done hoy y semana**: `az boards query` (estado Done o Closed, `StateChangeDate >= @Today` y `@Today - 7`), cada
  **5 minutos**, no en cada refresco. Si `az` falla, queda el último valor bueno y la marca «Azure sin conexión»;
  mientras Azure no haya respondido nunca, se cuentan los `aceptado` de hoy del historial.

El servidor recalcula cada 10 s y la página pide `/estado.json` cada 10 s.

---
description: Respondes la pregunta de un worker; el ticket sigue
argument-hint: <id del ticket> <tu respuesta>
---

La persona responde: `$ARGUMENTS` (el primer número es el id; el resto, la respuesta, con sus palabras).

1. `node orquestador/orq.ts responder <id> --text "<respuesta tal cual>"`.
2. `trabajar <id> --rol implementer --text "<respuesta tal cual>"`, en segundo plano.
3. Si quedan más preguntas pendientes, recuérdalas en una línea.

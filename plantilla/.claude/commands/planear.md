---
description: Revisa los tickets asignados a ti, planea los que no tienen plan y elige con qué modelos hacerlos
argument-hint: '[ids separados por espacio; vacío = todos los tuyos sin plan]'
---

Actúa como coordinador (`AGENTS.md`, sección 3, «Planear»). No implementes ni arranques nada.

1. `node orquestador/orq.ts plan`: tus tickets asignados, para tomar y en curso.
2. Por cada ticket de `$ARGUMENTS` (o cada uno «sin plan»): `show <id>` y lee su `ticket.md` completo.
3. Decide repos, talla y motores con los criterios de «Planear», y fíjalos:
   `show <id> --repo … --talla … [--implementer …] [--reviewer …] --nota "…"`.
   Si un PBI no cabe en L, propón cómo partirlo en lugar de planearlo entero.
4. `plan` otra vez y muéstrale a la persona una tabla corta (ticket, repos, talla, motor del implementer, nota) y
   el orden que propones, con las dudas que necesiten su respuesta.
5. Las dudas de negocio quedan como pregunta; lo demás lo decides tú («Lo que decides tú» en `AGENTS.md`). La ola sale con `/ola`, sin esperar respuesta.

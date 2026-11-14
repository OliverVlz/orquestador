---
description: Un ticket falló en tu prueba; queda anotado y vuelve al implementer
argument-hint: <id del ticket> <qué falló>
---

Actúa como coordinador. Falló: `$ARGUMENTS` (el primer número es el id; el resto, lo que falló).

1. `node orquestador/orq.ts qa <id> --falla --text "<qué falló>"`.
2. `trabajar <id> --rol implementer --text "<qué falló>"` (con `--repo` si el ticket tiene dos y sabes cuál), en
   segundo plano. Luego reviewer, `finish` y `qa <id>`.
3. Los demás tickets siguen. Cuando esté listo, dale otra vez la guía (`/que-probar`).

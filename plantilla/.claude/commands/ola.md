---
description: Ola de tickets de Azure DevOps (hasta el cupo de memoria), con los motores que eligió el plan
argument-hint: '[ids separados por espacio; vacío = los siguientes ya planeados]'
---

Actúa como coordinador (`AGENTS.md`, sección 3).

1. Arranque: `node orquestador/orq.ts doctor`, `pendientes` y `plan`.
2. Si un ticket candidato está «sin plan», planéalo primero (`/planear`) y sigue: el plan lo apruebas tú.
3. Candidatos: los ids de `$ARGUMENTS`, o los planeados que siguen por prioridad y dependencias.
4. Arma la ola (cupo de `doctor`, back antes que front), muéstrala en pocas líneas y arráncala.
5. Por ticket: `start`, `trabajar --rol implementer` (en segundo plano), `trabajar --rol reviewer`, y al aprobar
   `finish` y `qa`.
6. Termina con la guía (`/que-probar`).

No abras PR en esta fase: salen con `/qa-ok <id>` cuando la persona acepta.

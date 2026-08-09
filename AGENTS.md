AI coding agent documentation
=============================

This file defines the mandatory workflow for AI agents.

The active task's scope and pre-implementation technical decisions are defined in [BACKLOG.md](./BACKLOG.md); [ARCHITECTURE.md](./ARCHITECTURE.md) records only implemented reality.

workflow
--------

1. **context initialization**:

   - read [user documentation](./README.md) to understand implemented user-facing behavior
   - read [technical architecture](./ARCHITECTURE.md) to understand implemented technical decisions
   - read [project guidelines](./GUIDELINES.md) before making code, test, or documentation decisions
   - read [development instructions](./DEVELOPMENT.md) before running or describing project commands

2. **task refinement**:

   1. read the active task from the [development plan](./BACKLOG.md)
   2. inspect relevant code and identify gaps or inconsistencies in the task definition
   3. refine gaps with the *engineer* and update the corresponding backlog section
   4. repeat refinement if necessary, then continue to **task execution**

3. **task execution**:

   each task MUST include:

   - the implementation required by the task definition
   - behavior validation appropriate to the task and [project guidelines](./GUIDELINES.md)

4. **task completion**:

   1. perform a cleanup audit before updating documentation or the backlog:

      - trace changed behavior from production entry points and tests
      - remove unreachable source, unused exports, dependencies, configuration, obsolete tests, and temporary diagnostics
      - do not retain speculative code for future work

   2. update only the document whose audience needs the change, following the documentation boundaries in [project guidelines](./GUIDELINES.md); do not repeat the same information across documents

   3. remove implemented requirements and refinements from the backlog after recording current behavior for the appropriate audience; remove an indivisible backlog unit itself only when the engineer declares it complete

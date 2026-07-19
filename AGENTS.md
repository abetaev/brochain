AI coding agent documentation
=============================

This file defines the mandatory workflow for AI agents.

The active task's scope and pre-implementation technical decisions are defined in BACKLOG.md; ARCHITECTURE.md records only implemented reality.

workflow
--------

1. **context initialization**:

   - [user documentation](./README.md) to understand the frontend functionality and reasoning behind technical solutions

   - [technical architecture](./ARCHITECTURE.md) to understand implementation 

2. **task refinement**:

   1. read information task from [development plan](./BACKLOG.md)

   2. perform task analysis: look for relevant files, gaps in task definition

   3. if task contains gaps or inconsistencies it needs to be refined: talk to *engineer* to fill in and update corresponding section of *development plan*

   4. repeat refinement procedure if necessary or continue to **task execution**

3. **task execution**:

   execution of each task MUST consist of:

   - implementation of business logic that supports task definition

   - implementation of testing logic that provides validation of task completeness and outlines business workflow of that task in source code; consult [development instructions](./DEVELOPMENT.md) for instructions

4. upon completion of a task from backlog:

   1. update project documentation if necessary

      - if backlog task is a new feature user documentation and technical architecture SHOULD be updated

      - if backlog task is a bugfix, only architectural documentation MAY need to be updated (if needed)

      - if implemented task contains changes that reflect in development process, update **development instructions**

   2. remove task from *development plan* if it was described there

guidelines
----------

- KISS: if it's not requested do not add it, keep it simple
- DRY: if there is a pattern that is used in code multiple times - abstract it and make it reusable
- be concise: use concise style to code/describe only what matters, avoid creating judgement and enforcing opinion whenever and wherever it is possible

> **NOTE:** AI guidelines are work in progress; we will add more here along the road.
project guidelines
==================

These are project-wide engineering principles. They constrain implementation and documentation, but do not define development workflow, task scope, current architecture, or project-specific development procedures.

actors
======

1. user - is the end user of project who benefits from features project implements
2. engineer - person responsible for engineering (design, architecture, decision making) and development
3. AI agent - tool that can act on behalf of engineer with reasonable constraints to help engineer to implement and develop the project

style
=====

- KISS: keep it simple, stupid

  any implementation and documentation should follow minimalistic style, no unsolicited excessive chunks of data should be added to project unless explicitly requested by engineer

- DRY: don't repeat yourself
 
  duplications must be avoided at all costs except only the cases when complexity cost is too high to outweigh duplicated code management costs: use referenced in documentation and code abstractions

- coherence: naming must correspond to documentation exactly

  e.g. if component is named `vessel` it must be named so in every part of the project

- use [RFC2119](https://www.rfc-editor.org/info/rfc2119/) in documentation where applicable
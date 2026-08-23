project guidelines
==================

These principles constrain code, tests, and documentation. They do not define workflow, task scope, or current architecture.

- **minimality**: implement only current requested behavior. Do not add speculative abstractions, stubs, retained debugging helpers, or future-oriented code.
- **pre-production evolution**: until the engineer explicitly declares production, persisted development data and superseded interfaces or formats are disposable. Do not add migrations, compatibility shims, deprecated paths, or version bridges unless the task explicitly requires them. Preserve current intended behavior rather than obsolete implementation contracts.
- **clarity**: a shallow traversal of the source tree and public interfaces must explain what the system does and which entity owns each responsibility. Implementation details stay local to the code that requires them.
- **naming**: project-owned directories, files, entities, interfaces, and members describe their functional responsibility or designation. Do not name them for a framework, transport, runtime, protocol, or implementation technique unless that mechanism is their contract or an external tool mandates the name; in those cases, prefer the precise term to a vague substitute. Do not repeat context already expressed unambiguously by a path or namespace. Application and executable entry files use `main` unless they are run-mode integrations, which use the exact command designation (`dev` or `prod`); `index` is reserved for a directory module imported as that directory. Tool-mandated names are exempt.
- **expression**: code must read as a direct expression of its intent, not as a cipher that must be decoded. Prefer straightforward control flow and descriptive intermediate values over clever, compressed, or indirect constructs.
- **asynchronous flow**: express asynchronous operations with `async` functions and `await` wherever the surrounding API permits it. Use promise chains only when they communicate the operation more clearly or an API requires them.
- **DRY**: abstract a currently repeated pattern only when the abstraction makes the code easier to understand. Do not abstract anticipated reuse.
- **single responsibility**: each entity owns one coherent domain and has one domain-level reason to change. A service package encapsulates its implementation behind its own public interface; unrelated services must not be combined into a facade or barrel.
- **extension**: prefer composing stable entities over changing their established behavior. Add extension points only for current requirements; do not build speculative frameworks.
- **interfaces**: expose one coherent interface for each entity. A consumer may depend on a complete service while using only some of its methods; introduce a narrower entity or adapter only when it has independent meaning or makes the design simpler.
- **functional construction**: project-owned classes MUST NOT be declared or used. Construct stateful entities and services with functions and keep their state in closures. Instantiate platform or dependency classes only when their APIs require it.
- **type design**: represent one domain concept with one public type. Introduce another type only when it describes a genuinely different entity or contract; do not create parallel detail, record, state, or transport types for the same object merely to assist an implementation.
- **dependencies**: dependency graphs must be acyclic. Resolve a cycle by separating the shared contract or responsibility, not through global state or an intermediary that exposes both sides.
- **encapsulation**: declarations are private by default. Export only declarations used outside their defining file, and expose a package through one coherent entry point without re-exporting unrelated entities.
- **hierarchy**: a directory must group multiple related files. An entity implemented by one file uses `{entity}.ts`; introduce `{entity}/index.ts` only when the entity has a real internal file hierarchy.
- **service size**: keep a service in one file while it remains coherent. Split it into cohesive private files when a separate responsibility is clearer or it grows beyond roughly 600-900 lines; file count is not an architecture goal.
- **layers**: build UI from markup elements into reusable components and complete views. Extract a lower-level entity only when current reuse or cohesion warrants it. Backend consists of domain services and their methods. A view calls the service packages it needs directly and must not receive business methods through an aggregate UI backend.
- **dependency ownership**: an owning layer MUST expose stable stateful dependencies through initialization and maintenance accessors. Consumers request capabilities through those accessors and MUST NOT coordinate dependency construction, bootstrap, retry, or lifetime.
- **testing**: validate user-visible behavior through real user interaction at the highest practical level. Use lower-level tests only for behavior that cannot be reliably proven there, such as an internal invariant, security boundary, or complex algorithm.
- **hygiene**: every retained source file, export, dependency, configuration entry, and test must support current production or test behavior. Remove orphaned and temporary artifacts after each task.
- **enforcement**: enforce these principles through direct structure, types, compiler checks, and existing tests when cheap. Do not add tooling or abstractions whose enforcement cost exceeds the problem they prevent.
- **coherence**: use the same name for the same concept throughout code and documentation.
- **documentation**: README describes user behavior, DEVELOPMENT explains project operation, BACKLOG holds only unfinished requirements and provisional decisions, ARCHITECTURE outlines implemented domains and non-obvious technical decisions, and AGENTS defines AI workflow. Document each fact once and link when another audience needs it.
- **documentation detail**: organize architecture by responsibilities, dependencies, behavior, runtime, and technologies with their designations. Prefer short hierarchies, tables, and diagrams to prose. Do not narrate imports, filenames, call sequences, or facts evident from a shallow source reading; retain lower-level detail only for a non-obvious constraint, contract, security property, or operational decision.
- use [RFC2119](https://www.rfc-editor.org/info/rfc2119/) terms in documentation when they clarify a requirement.

conventions
-----------

A designated backend core component MUST have a seven-letter lowercase English
designation. Language-idiomatic capitalization of a symbol does not change its
designation. The current and planned core designations are `account`, `network`,
`options`, `secrecy`, `session`, `signals`, and `storage`. Non-core component
names have no length constraint.
